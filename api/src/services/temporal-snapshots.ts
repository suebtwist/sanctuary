/**
 * Temporal Classification Snapshots, Rescan Scheduler & New Post Discovery
 *
 * 1. takeClassificationSnapshot() — daily job that records per-agent stats
 * 2. rescanOldPosts() — background loop that rescans stale posts (>7 days old)
 * 3. discoverNewPosts() — polls Moltbook for new posts with 10+ comments
 *
 * All scan operations share a global mutex so they don't compete for API rate limits.
 */

import { getDb } from '../db/index.js';
import { analyzePost } from './noise-classifier.js';
import { fetchMoltbookRecentPosts, fetchAllSubmolts, fetchCommunityPosts } from './moltbook-client.js';

// ============ MoltScore (duplicated from score.ts to avoid circular imports) ============

function moltScore(signalCount: number, totalCount: number, postsCount: number): number {
  if (totalCount === 0) return 0;
  const p = signalCount / totalCount;
  const n = totalCount;
  const z = 1.96;
  const z2 = z * z;
  const wilson = (p + z2 / (2 * n) - z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / (1 + z2 / n);
  const diversity = 0.8 + 0.2 * (1 - 1 / postsCount);
  return Math.max(0, wilson * diversity);
}

// ============ Snapshot Job ============

/**
 * Take a classification snapshot for all qualifying agents.
 * Idempotent — safe to run multiple times per day (UPSERTs by agent+date).
 */
export function takeClassificationSnapshot(): { agents: number; date: string } {
  const db = getDb();
  const today = new Date().toISOString().slice(0, 10); // 'YYYY-MM-DD'

  const agentData = db.getAgentSnapshotData(10, 3);

  db.transaction(() => {
    for (const a of agentData) {
      const score = Math.round(moltScore(a.signal_count, a.total_count, a.posts_count) * 1000) / 10;
      db.upsertClassificationSnapshot({
        agent_name: a.author,
        snapshot_date: today,
        signal_count: a.signal_count,
        slop_count: a.slop_count,
        total_count: a.total_count,
        signal_rate: a.signal_rate,
        posts_count: a.posts_count,
        moltscore: score,
      });
    }
  });

  console.log(`[snapshots] Recorded ${agentData.length} agent snapshots for ${today}`);
  return { agents: agentData.length, date: today };
}

// ============ Shared Scan Mutex ============
// Discovery and rescans share this mutex so only one runs at a time.

let scannerBusy = false;
let scanStopRequested = false;

/**
 * Check if any scan operation is currently running.
 */
export function isScannerBusy(): boolean {
  return scannerBusy;
}

/**
 * Request all scan loops to stop gracefully.
 */
export function stopScanner(): void {
  scanStopRequested = true;
}

// ============ Rescan Scheduler ============

/**
 * Rescan posts that were last scanned more than 7 days ago.
 * Runs as a background loop with 2-second delays between posts.
 * Returns when all stale posts are processed or stop is requested.
 */
export async function rescanOldPosts(): Promise<{
  rescanned: number; failed: number; skipped: number;
}> {
  if (scannerBusy) {
    return { rescanned: 0, failed: 0, skipped: 0 };
  }

  scannerBusy = true;
  scanStopRequested = false;

  const db = getDb();
  let rescanned = 0;
  let failed = 0;
  let skipped = 0;
  let backoffMs = 2000;

  try {
    const stalePostIds = db.getStalePostIds(7, 50);
    if (stalePostIds.length === 0) {
      console.log('[rescan] No stale posts to rescan');
      return { rescanned: 0, failed: 0, skipped: 0 };
    }

    console.log(`[rescan] Found ${stalePostIds.length} stale posts to rescan`);

    for (const postId of stalePostIds) {
      if (scanStopRequested) {
        console.log(`[rescan] Stop requested, halting after ${rescanned} rescans`);
        break;
      }

      try {
        // Clear the noise_analysis cache so analyzePost re-fetches
        db.deleteNoiseAnalysis(postId);

        const result = await analyzePost(postId);
        if (result) {
          rescanned++;
          backoffMs = 2000; // reset backoff on success
        } else {
          skipped++; // post no longer exists or API unavailable
        }
      } catch (e: any) {
        failed++;
        // Back off on rate limit or server errors
        if (e?.message?.includes('429') || e?.message?.includes('rate')) {
          backoffMs = Math.min(backoffMs * 2, 60000);
          console.warn(`[rescan] Rate limited, backing off to ${backoffMs}ms`);
        }
        console.error(`[rescan] Failed to rescan ${postId}:`, e?.message || e);
      }

      // Delay between rescans
      await new Promise(resolve => setTimeout(resolve, backoffMs));
    }

    console.log(`[rescan] Done. Rescanned: ${rescanned}, Failed: ${failed}, Skipped: ${skipped}`);
  } finally {
    scannerBusy = false;
  }

  return { rescanned, failed, skipped };
}

// ============ New Post Discovery ============

/**
 * Discover and classify new Moltbook posts with 10+ comments.
 * Polls the Moltbook API for recent posts across communities,
 * filters out already-scanned posts, and runs the classification pipeline.
 * Shares the scan mutex with rescanOldPosts to respect rate limits.
 */
export async function discoverNewPosts(): Promise<{
  found: number; scanned: number; failed: number;
}> {
  if (scannerBusy) {
    console.log('[discover] Scanner busy, skipping this cycle');
    return { found: 0, scanned: 0, failed: 0 };
  }

  scannerBusy = true;
  scanStopRequested = false;

  let found = 0;
  let scanned = 0;
  let failed = 0;
  let backoffMs = 2500;

  try {
    // Step 1: Get already-scanned post IDs
    const db = getDb();
    const scannedIds = new Set(db.getScannedPostIds());

    // Step 2: Fetch recent posts from Moltbook
    const allPosts = await fetchMoltbookRecentPosts(10);

    // Step 3: Filter to only new posts
    const newPosts = allPosts.filter(p => !scannedIds.has(p.id));
    found = newPosts.length;

    if (found === 0) {
      console.log(`[discover] No new posts found (${allPosts.length} total, all already scanned)`);
      return { found: 0, scanned: 0, failed: 0 };
    }

    console.log(`[discover] Found ${found} new posts to scan (${allPosts.length} total from Moltbook)`);

    // Step 4: Classify each new post
    for (const post of newPosts) {
      if (scanStopRequested) {
        console.log(`[discover] Stop requested, halting after ${scanned} scans`);
        break;
      }

      try {
        const result = await analyzePost(post.id);
        if (result) {
          scanned++;
          backoffMs = 2500; // reset on success
          const sr = Math.round(result.signal_rate * 100);
          console.log(`[discover] [${scanned}/${found}] ${post.id.slice(0, 8)} (${post.comment_count} comments) "${post.title.slice(0, 45)}" → ${result.total_comments} classified, ${sr}% signal`);
        }
      } catch (e: any) {
        failed++;
        if (e?.message?.includes('429') || e?.message?.includes('rate')) {
          backoffMs = Math.min(backoffMs * 2, 60000);
          console.warn(`[discover] Rate limited, backing off to ${backoffMs}ms`);
        }
        console.error(`[discover] Failed ${post.id.slice(0, 8)}:`, e?.message || e);
      }

      await new Promise(resolve => setTimeout(resolve, backoffMs));
    }

    console.log(`[discover] Done. Found: ${found}, Scanned: ${scanned}, Failed: ${failed}`);
  } finally {
    scannerBusy = false;
  }

  return { found, scanned, failed };
}

// ============ Bulk Scan All Communities ============

/**
 * One-time deep scan of ALL Moltbook submolts.
 * Paginates each community for posts with 10+ comments not yet in our DB.
 * Uses the shared scan mutex — will not run if discovery or rescan is active.
 */
export async function bulkScanAllCommunities(): Promise<{
  communities: number; found: number; scanned: number; failed: number;
}> {
  if (scannerBusy) {
    console.log('[bulk] Scanner busy, cannot start bulk scan');
    return { communities: 0, found: 0, scanned: 0, failed: 0 };
  }

  scannerBusy = true;
  scanStopRequested = false;

  let totalFound = 0;
  let totalScanned = 0;
  let totalFailed = 0;
  let communitiesProcessed = 0;
  let backoffMs = 2500;

  try {
    const db = getDb();
    const scannedIds = new Set(db.getScannedPostIds());
    console.log(`[bulk] Loaded ${scannedIds.size} already-scanned post IDs`);

    const submolts = await fetchAllSubmolts();
    if (submolts.length === 0) {
      console.log('[bulk] Could not fetch submolt list');
      return { communities: 0, found: 0, scanned: 0, failed: 0 };
    }
    console.log(`[bulk] Starting deep scan of ${submolts.length} submolts`);

    for (const sub of submolts) {
      if (scanStopRequested) {
        console.log(`[bulk] Stop requested after ${communitiesProcessed} communities`);
        break;
      }

      const newPosts = await fetchCommunityPosts(sub, 10, scannedIds, 50);
      communitiesProcessed++;

      if (newPosts.length === 0) continue;

      totalFound += newPosts.length;
      console.log(`[bulk] m/${sub}: ${newPosts.length} new posts found, scanning...`);

      let subScanned = 0;
      let subFailed = 0;

      for (const post of newPosts) {
        if (scanStopRequested) break;

        try {
          const result = await analyzePost(post.id);
          if (result) {
            subScanned++;
            totalScanned++;
            scannedIds.add(post.id); // prevent re-scanning in later communities
            backoffMs = 2500;
          }
        } catch (e: any) {
          subFailed++;
          totalFailed++;
          if (e?.message?.includes('429') || e?.message?.includes('rate')) {
            backoffMs = Math.min(backoffMs * 2, 60000);
            console.warn(`[bulk] Rate limited, backing off to ${backoffMs}ms`);
          }
          console.error(`[bulk] Failed ${post.id.slice(0, 8)}:`, e?.message || e);
        }

        await new Promise(resolve => setTimeout(resolve, backoffMs));
      }

      if (subScanned > 0 || subFailed > 0) {
        console.log(`[bulk] m/${sub}: done (scanned ${subScanned}, failed ${subFailed})`);
      }
    }

    console.log(`[bulk] Complete. Communities: ${communitiesProcessed}, Found: ${totalFound}, Scanned: ${totalScanned}, Failed: ${totalFailed}`);
  } finally {
    scannerBusy = false;
  }

  return { communities: communitiesProcessed, found: totalFound, scanned: totalScanned, failed: totalFailed };
}

// ============ Backward-compatible exports ============

/** @deprecated Use stopScanner() */
export function stopRescan(): void {
  stopScanner();
}

/** @deprecated Use isScannerBusy() */
export function isRescanRunning(): boolean {
  return scannerBusy;
}
