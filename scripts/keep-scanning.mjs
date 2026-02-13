/**
 * Continuous scanner: fetches scanned IDs, deep-fetches from Moltbook,
 * scans unscanned posts sorted by Moltbook's top ranking.
 * Runs until stopped or runs out of posts.
 */

const API = 'https://api.sanctuary-ops.xyz';
const MOLTBOOK = 'https://www.moltbook.com/api/v1';
const MIN_COMMENTS = 10;
const DELAY_MS = 2500;
const BATCH_SIZE = 50;

// Step 1: Get already-scanned post IDs
console.log('Fetching already-scanned post IDs...');
const scannedResp = await fetch(`${API}/noise/scanned-ids`);
const scannedJson = await scannedResp.json();
const scannedIds = new Set(scannedJson.post_ids || []);
console.log(`Already scanned: ${scannedIds.size} posts.\n`);

// Step 2: Deep fetch using offset pagination (sort=top = Moltbook's ranking)
console.log('Deep-fetching posts (sort=top, offset pagination)...');
const seen = new Set();
const candidates = [];

for (let offset = 0; offset <= 50000; offset += 100) {
  try {
    const resp = await fetch(`${MOLTBOOK}/posts?sort=top&limit=100&offset=${offset}`);
    const json = await resp.json();
    const posts = json.posts || [];
    if (posts.length === 0) break;

    for (const p of posts) {
      if (seen.has(p.id) || scannedIds.has(p.id)) continue;
      seen.add(p.id);
      if (p.comment_count >= MIN_COMMENTS) candidates.push(p);
    }
  } catch { break; }
  await sleep(150);
}

// Keep the Moltbook ranking order (don't re-sort by comment count)
console.log(`Found ${candidates.length} unscanned posts with ${MIN_COMMENTS}+ comments.\n`);

if (candidates.length === 0) {
  console.log('No more qualifying posts.');
  process.exit(0);
}

// Step 3: Scan continuously in batches
let completed = 0;
let failed = 0;
let totalNewComments = 0;
let batch = 1;

for (let i = 0; i < candidates.length; i++) {
  const p = candidates[i];
  const sub = p.submolt ? p.submolt.name : '?';
  const label = `${p.id.slice(0, 8)} (${p.comment_count} comments, m/${sub}) "${(p.title || '').slice(0, 45)}"`;

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

    completed++;
    const d = json.data;
    const sr = Math.round(d.signal_rate * 100);
    totalNewComments += d.total_comments;
    console.log(`  [${completed}] ${label} → ${d.total_comments} classified, ${sr}% signal (${elapsed}ms)`);

    // Batch summary every BATCH_SIZE
    if (completed % BATCH_SIZE === 0) {
      console.log(`\n  --- Batch ${batch} complete (${completed} total, ${totalNewComments} comments added) ---\n`);
      batch++;
    }
  } catch (e) {
    console.log(`  ERR  ${label}: ${e.message}`);
    failed++;
  }

  await sleep(DELAY_MS);
}

console.log(`\n--- Final ---`);
console.log(`Scanned: ${completed}`);
console.log(`Failed: ${failed}`);
console.log(`New comments added: ${totalNewComments}`);
console.log(`Total in DB: ~${scannedIds.size + completed}`);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
