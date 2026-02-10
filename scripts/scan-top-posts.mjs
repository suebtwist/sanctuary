/**
 * Scan top discussed Moltbook posts through Sanctuary noise filter.
 * Skips posts already cached. Stops after TARGET new scans.
 */

const API = 'https://api.sanctuary-ops.xyz';
const TARGET = 50;
const DELAY_MS = 2500; // between API calls

// Load the sorted post list
import { readFileSync } from 'fs';
const posts = JSON.parse(readFileSync(process.env.TEMP + '/mb_sorted.json', 'utf8'));

console.log(`Loaded ${posts.length} posts sorted by comment count.`);
console.log(`Target: ${TARGET} new scans.\n`);

let newScans = 0;
let cached = 0;
let failed = 0;

for (let i = 0; i < posts.length && newScans < TARGET; i++) {
  const p = posts[i];
  const label = `[${i + 1}/${posts.length}] ${p.id.slice(0, 8)} (${p.comments} comments) "${p.title.slice(0, 50)}"`;

  try {
    const start = Date.now();
    const resp = await fetch(`${API}/noise/analyze?post_id=${p.id}`);
    const elapsed = Date.now() - start;
    const json = await resp.json();

    if (!json.success) {
      console.log(`  FAIL ${label}: ${json.error || 'unknown'}`);
      failed++;
      await sleep(500);
      continue;
    }

    const d = json.data;
    const analyzedAt = new Date(d.analyzed_at).getTime();
    const isNew = (Date.now() - analyzedAt) < 30000; // analyzed within last 30s = new

    if (isNew) {
      newScans++;
      const sr = Math.round(d.signal_rate * 100);
      console.log(`  NEW  [${newScans}/${TARGET}] ${label} → ${d.total_comments} comments, ${sr}% signal (${elapsed}ms)`);
    } else {
      cached++;
      console.log(`  SKIP ${label} (already cached)`);
      await sleep(300); // short delay for cached
      continue;
    }
  } catch (e) {
    console.log(`  ERR  ${label}: ${e.message}`);
    failed++;
  }

  // Delay between new scans to avoid hammering Moltbook API
  if (newScans < TARGET) await sleep(DELAY_MS);
}

console.log(`\n--- Done ---`);
console.log(`New scans: ${newScans}`);
console.log(`Cached (skipped): ${cached}`);
console.log(`Failed: ${failed}`);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
