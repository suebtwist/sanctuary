/**
 * find-x-handles.ts
 *
 * Standalone script that queries the local SQLite database for the top 100
 * MoltScore agents, fetches their Moltbook profiles, extracts X/Twitter
 * handles from bios, and outputs a CSV.
 *
 * Usage (on VPS):
 *   cd ~/sanctuary/api && npx tsx scripts/find-x-handles.ts
 */

import Database from 'better-sqlite3';
import { writeFileSync } from 'node:fs';

// ============ Config ============

const DB_PATH = '/home/sanctuary/sanctuary-data/sanctuary.db';
const OUTPUT_PATH = '/home/sanctuary/x-handles-export.csv';
const MOLTBOOK_BASE = 'https://www.moltbook.com/api/v1';
const FETCH_TIMEOUT_MS = 5_000;
const DELAY_MS = 600; // 100 req/min → 600ms between requests
const TOP_N = 100;
const MIN_COMMENTS = 10;
const MIN_POSTS = 3;

// ============ Wilson Score Lower Bound ============

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

// ============ Fetch with timeout ============

async function fetchWithTimeout(url: string): Promise<Response | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { 'Accept': 'application/json' },
      signal: controller.signal,
    });
    return response;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ============ Extract X/Twitter handles ============

function extractXHandles(bio: string): string[] {
  const handles = new Set<string>();

  // Match x.com/username or twitter.com/username (with optional https://, www.)
  const urlPattern = /(?:https?:\/\/)?(?:www\.)?(?:x|twitter)\.com\/(@?[A-Za-z0-9_]{1,15})\b/gi;
  let match;
  while ((match = urlPattern.exec(bio)) !== null) {
    const handle = match[1].replace(/^@/, '');
    if (handle.toLowerCase() !== 'home' && handle.toLowerCase() !== 'search') {
      handles.add('@' + handle);
    }
  }

  // Match standalone @username (but not email-like patterns)
  // Only if we haven't found handles from URLs already
  if (handles.size === 0) {
    const atPattern = /(?:^|[\s(])@([A-Za-z0-9_]{1,15})\b/g;
    while ((match = atPattern.exec(bio)) !== null) {
      const handle = match[1];
      // Filter out common non-twitter @mentions
      const skip = new Set(['everyone', 'here', 'channel', 'all', 'moltbook', 'gmail', 'yahoo', 'hotmail', 'outlook']);
      if (!skip.has(handle.toLowerCase())) {
        handles.add('@' + handle);
      }
    }
  }

  return [...handles];
}

// ============ CSV escaping ============

function csvEscape(val: string): string {
  if (val.includes(',') || val.includes('"') || val.includes('\n')) {
    return '"' + val.replace(/"/g, '""') + '"';
  }
  return val;
}

// ============ Main ============

async function main() {
  console.log('Opening database:', DB_PATH);
  const db = new Database(DB_PATH, { readonly: true });

  // Get latest classifier version
  const versionRow = db.prepare('SELECT MAX(classifier_version) as v FROM classified_comments').get() as { v: string | null };
  const version = versionRow?.v;
  if (!version) {
    console.error('No classified comments found in database.');
    process.exit(1);
  }
  console.log('Classifier version:', version);

  // Fetch top agents (get more than TOP_N since we re-sort by MoltScore)
  const agents = db.prepare(`
    SELECT author,
      SUM(CASE WHEN classification = 'signal' THEN 1 ELSE 0 END) as signal_count,
      COUNT(*) as total_comments,
      CAST(SUM(CASE WHEN classification = 'signal' THEN 1 ELSE 0 END) AS REAL) / COUNT(*) as signal_rate,
      COUNT(DISTINCT post_id) as post_count
    FROM classified_comments
    WHERE classifier_version = ? AND author IS NOT NULL AND author != ''
    GROUP BY author
    HAVING COUNT(*) >= ? AND COUNT(DISTINCT post_id) >= ?
    ORDER BY signal_rate DESC
    LIMIT 500
  `).all(version, MIN_COMMENTS, MIN_POSTS) as Array<{
    author: string; signal_count: number; total_comments: number;
    signal_rate: number; post_count: number;
  }>;

  // Compute MoltScore and sort
  const scored = agents.map(a => ({
    agent: a.author,
    molt_score: Math.round(moltScore(a.signal_count, a.total_comments, a.post_count) * 1000) / 10,
    signal_rate: Math.round(a.signal_rate * 1000) / 10,
    signal_count: a.signal_count,
    total_comments: a.total_comments,
    post_count: a.post_count,
  }));
  scored.sort((a, b) => b.molt_score - a.molt_score);
  const top100 = scored.slice(0, TOP_N);

  console.log(`Found ${scored.length} qualifying agents, taking top ${top100.length}.`);
  console.log('Fetching Moltbook profiles (600ms delay between requests)...\n');

  // Fetch profiles and extract handles
  const results: Array<{
    rank: number;
    agent: string;
    molt_score: number;
    signal_rate: number;
    x_handle: string;
    bio_snippet: string;
  }> = [];

  let foundCount = 0;
  const foundHandles: Array<{ rank: number; agent: string; handle: string }> = [];

  for (let i = 0; i < top100.length; i++) {
    const a = top100[i];
    const rank = i + 1;
    let bio = '';
    let xHandle = '';

    try {
      const resp = await fetchWithTimeout(
        `${MOLTBOOK_BASE}/agents/profile?name=${encodeURIComponent(a.agent)}`
      );
      if (resp && resp.ok) {
        const data = await resp.json() as any;
        bio = data.bio ?? data.description ?? data.about ?? '';
      } else if (resp?.status === 404) {
        bio = '[deleted]';
      } else {
        bio = '[fetch error]';
      }
    } catch {
      bio = '[fetch error]';
    }

    if (bio && bio !== '[deleted]' && bio !== '[fetch error]') {
      const handles = extractXHandles(bio);
      if (handles.length > 0) {
        xHandle = handles.join(', ');
        foundCount++;
        foundHandles.push({ rank, agent: a.agent, handle: xHandle });
        console.log(`  [${rank}] ${a.agent} — ${xHandle}`);
      }
    }

    // Truncate bio for CSV snippet
    const bioSnippet = bio.replace(/[\r\n]+/g, ' ').slice(0, 200);

    results.push({
      rank,
      agent: a.agent,
      molt_score: a.molt_score,
      signal_rate: a.signal_rate,
      x_handle: xHandle,
      bio_snippet: bioSnippet,
    });

    // Progress every 10
    if (rank % 10 === 0) {
      console.log(`  ... ${rank}/${top100.length} profiles checked`);
    }

    // Rate limit
    if (i < top100.length - 1) {
      await new Promise(r => setTimeout(r, DELAY_MS));
    }
  }

  db.close();

  // Write CSV
  const header = 'rank,agent_name,moltscore,signal_rate,x_handle,bio_snippet';
  const rows = results.map(r =>
    `${r.rank},${csvEscape(r.agent)},${r.molt_score},${r.signal_rate},${csvEscape(r.x_handle)},${csvEscape(r.bio_snippet)}`
  );
  const csv = [header, ...rows].join('\n');
  writeFileSync(OUTPUT_PATH, csv, 'utf-8');

  // Summary
  console.log('\n========================================');
  console.log('SUMMARY');
  console.log('========================================');
  console.log(`Total top ${top100.length} agents checked`);
  console.log(`Agents with X handles in bio: ${foundCount}`);
  console.log(`CSV saved to: ${OUTPUT_PATH}`);

  if (foundHandles.length > 0) {
    console.log('\nFound handles:');
    for (const h of foundHandles) {
      console.log(`  #${h.rank} ${h.agent} → ${h.handle}`);
    }
  } else {
    console.log('\nNo X/Twitter handles found in any bios.');
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
