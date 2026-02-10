/**
 * Temporal Classification Snapshots & Rescan Scheduler
 *
 * 1. takeClassificationSnapshot() — daily job that records per-agent stats
 * 2. rescanOldPosts() — background loop that rescans stale posts (>7 days old)
 *
 * Both respect a global scan mutex so rescans don't compete with new scans.
 */

import { getDb } from '../db/index.js';
import { analyzePost } from './noise-classifier.js';

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

// ============ Rescan Scheduler ============

let rescanRunning = false;
let rescanStopRequested = false;

/**
 * Rescan posts that were last scanned more than 7 days ago.
 * Runs as a background loop with 2-second delays between posts.
 * Returns when all stale posts are processed or stop is requested.
 */
export async function rescanOldPosts(): Promise<{
  rescanned: number; failed: number; skipped: number;
}> {
  if (rescanRunning) {
    return { rescanned: 0, failed: 0, skipped: 0 };
  }

  rescanRunning = true;
  rescanStopRequested = false;

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
      if (rescanStopRequested) {
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
    rescanRunning = false;
  }

  return { rescanned, failed, skipped };
}

/**
 * Stop the current rescan loop gracefully.
 */
export function stopRescan(): void {
  rescanStopRequested = true;
}

/**
 * Check if a rescan is currently running.
 */
export function isRescanRunning(): boolean {
  return rescanRunning;
}
