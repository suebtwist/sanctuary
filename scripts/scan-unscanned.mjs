/**
 * Scan unscanned Moltbook posts (pre-filtered list from check-unscanned.mjs).
 */

import { readFileSync } from 'fs';

const API = 'https://api.sanctuary-ops.xyz';
const TARGET = 50;
const DELAY_MS = 2500;

const posts = JSON.parse(readFileSync(process.env.TEMP + '/mb_unscanned.json', 'utf8'));
console.log(`Loaded ${posts.length} unscanned posts. Target: ${TARGET}.\n`);

let completed = 0;
let failed = 0;
let totalNewComments = 0;

for (let i = 0; i < posts.length && completed < TARGET; i++) {
  const p = posts[i];
  const label = `${p.id.slice(0, 8)} (${p.comments} comments) "${p.title.slice(0, 50)}"`;

  try {
    const start = Date.now();
    const resp = await fetch(`${API}/noise/analyze?post_id=${p.id}`);
    const elapsed = Date.now() - start;
    const json = await resp.json();

    if (!json.success) {
      console.log(`  FAIL [${i + 1}] ${label}: ${json.error || 'unknown'}`);
      failed++;
      await sleep(500);
      continue;
    }

    completed++;
    const d = json.data;
    const sr = Math.round(d.signal_rate * 100);
    totalNewComments += d.total_comments;
    console.log(`  [${completed}/${TARGET}] ${label} → ${d.total_comments} classified, ${sr}% signal (${elapsed}ms)`);
  } catch (e) {
    console.log(`  ERR  [${i + 1}] ${label}: ${e.message}`);
    failed++;
  }

  if (completed < TARGET) await sleep(DELAY_MS);
}

console.log(`\n--- Done ---`);
console.log(`Scanned: ${completed}`);
console.log(`Failed: ${failed}`);
console.log(`New comments added: ${totalNewComments}`);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
