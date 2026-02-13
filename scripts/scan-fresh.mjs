/**
 * Scan unscanned Moltbook posts with 10+ comments.
 * Fetches from multiple submolts and sort orders for maximum coverage.
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

// Step 2: Fetch posts from many sources
console.log('Fetching posts from Moltbook...');
const seen = new Set();
const candidates = [];

async function fetchPage(url) {
  try {
    const resp = await fetch(url);
    const json = await resp.json();
    const posts = json.posts || [];
    for (const p of posts) {
      if (seen.has(p.id) || scannedIds.has(p.id) || p.comment_count < MIN_COMMENTS) continue;
      seen.add(p.id);
      candidates.push(p);
    }
    return posts.length;
  } catch { return 0; }
}

// Fetch from multiple communities and sort orders
const communities = ['general', 'consciousness', 'offmychest', 'building', 'tools', 'agents', 'crypto', 'memes', 'meta', 'all'];
for (const sub of communities) {
  await fetchPage(`${MOLTBOOK}/posts?sort=top&limit=100&community=${sub}`);
  await fetchPage(`${MOLTBOOK}/posts?sort=new&limit=100&community=${sub}`);
  await sleep(200);
}

// Also fetch general feed pages
for (let page = 1; page <= 20; page++) {
  const count = await fetchPage(`${MOLTBOOK}/posts?sort=new&limit=100&page=${page}`);
  if (count === 0) break;
  await sleep(200);
}

candidates.sort((a, b) => b.comment_count - a.comment_count);
console.log(`Found ${candidates.length} unscanned posts with ${MIN_COMMENTS}+ comments.\n`);

if (candidates.length === 0) {
  console.log('No qualifying posts found.');
  process.exit(0);
}

// Step 3: Scan
let completed = 0;
let failed = 0;
let totalNewComments = 0;

for (let i = 0; i < candidates.length && completed < TARGET; i++) {
  const p = candidates[i];
  const name = typeof p.author === 'object' ? p.author.name : p.author;
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

// Final stats check
const finalResp = await fetch(`${API}/noise/stats`);
const finalStats = await (finalResp.json());

console.log(`\n--- Done ---`);
console.log(`Scanned: ${completed}`);
console.log(`Failed: ${failed}`);
console.log(`New comments added: ${totalNewComments}`);
console.log(`DB total posts: ${finalStats.data?.total_posts_analyzed || '?'}`);
console.log(`DB total comments: ${finalStats.data?.total_comments_analyzed || '?'}`);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
