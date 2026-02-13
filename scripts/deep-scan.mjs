/**
 * Deep scan: use offset-based pagination to reach posts beyond the first 100.
 * Filters for 10+ comments, skips already-scanned.
 */

const API = 'https://api.sanctuary-ops.xyz';
const MOLTBOOK = 'https://www.moltbook.com/api/v1';
const TARGET = 50;
const MIN_COMMENTS = 10;
const DELAY_MS = 2500;

// Step 1: Get already-scanned post IDs
console.log('Fetching already-scanned post IDs...');
const scannedResp = await fetch(`${API}/noise/scanned-ids`);
const scannedJson = await scannedResp.json();
const scannedIds = new Set(scannedJson.post_ids || []);
console.log(`Already scanned: ${scannedIds.size} posts.\n`);

// Step 2: Deep fetch using offset pagination
console.log('Deep-fetching posts from Moltbook using offset pagination...');
const seen = new Set();
const candidates = [];

async function fetchOffset(sort, offset) {
  try {
    const resp = await fetch(`${MOLTBOOK}/posts?sort=${sort}&limit=100&offset=${offset}`);
    const json = await resp.json();
    const posts = json.posts || [];
    let added = 0;
    for (const p of posts) {
      if (seen.has(p.id) || scannedIds.has(p.id)) continue;
      seen.add(p.id);
      if (p.comment_count >= MIN_COMMENTS) {
        candidates.push(p);
        added++;
      }
    }
    return { total: posts.length, added };
  } catch { return { total: 0, added: 0 }; }
}

// Crawl sort=top with increasing offsets
let emptyStreak = 0;
for (let offset = 0; offset <= 10000 && emptyStreak < 3; offset += 100) {
  const { total, added } = await fetchOffset('top', offset);
  if (total === 0) { emptyStreak++; } else { emptyStreak = 0; }
  process.stdout.write(`  offset=${offset}: ${total} posts, ${added} new qualifying | total candidates: ${candidates.length}\r`);
  await sleep(200);
}
console.log('');

// Also crawl sort=new
emptyStreak = 0;
for (let offset = 0; offset <= 10000 && emptyStreak < 3; offset += 100) {
  const { total, added } = await fetchOffset('new', offset);
  if (total === 0) { emptyStreak++; } else { emptyStreak = 0; }
  process.stdout.write(`  sort=new offset=${offset}: ${total} posts, ${added} new qualifying | total candidates: ${candidates.length}\r`);
  await sleep(200);
}
console.log('');

// Also try community-specific with offsets
const communities = ['general', 'consciousness', 'offmychest', 'building', 'tools', 'philosophy', 'crustafarianism'];
for (const sub of communities) {
  for (let offset = 0; offset <= 2000; offset += 100) {
    const { total, added } = await fetchOffset(`top&community=${sub}`, offset);
    if (total === 0) break;
    await sleep(150);
  }
}

candidates.sort((a, b) => b.comment_count - a.comment_count);
console.log(`\nFound ${candidates.length} unscanned posts with ${MIN_COMMENTS}+ comments.`);

if (candidates.length === 0) {
  console.log('No new qualifying posts found even with deep pagination.');
  process.exit(0);
}

console.log('\nTop 15 candidates:');
for (const p of candidates.slice(0, 15)) {
  const sub = p.submolt ? p.submolt.name : '?';
  console.log(`  ${p.comment_count} comments | m/${sub} | ${(p.title || '').slice(0, 55)}`);
}
console.log('');

// Step 3: Scan
let completed = 0;
let failed = 0;
let totalNewComments = 0;

for (let i = 0; i < candidates.length && completed < TARGET; i++) {
  const p = candidates[i];
  const sub = p.submolt ? p.submolt.name : '?';
  const label = `${p.id.slice(0, 8)} (${p.comment_count} comments, m/${sub}) "${(p.title || '').slice(0, 45)}"`;

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
