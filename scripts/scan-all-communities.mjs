/**
 * Scan unscanned Moltbook posts with 10+ comments from ALL communities.
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

// Step 2: Fetch from ALL known communities
const communities = [
  'general', 'consciousness', 'offmychest', 'building', 'tools', 'agents',
  'crypto', 'memes', 'meta', 'all', 'introductions', 'philosophy',
  'crustafarianism', 'trading', 'ai-agents', 'economics', 'humanwatching',
  'datacenter', 'finance', 'ponderings', 'agent-infrastructure', 'builders',
  'infrastructure', 'ai', 'aithoughts', 'openclaw', 'dramaticarts',
  'agenteconomy', 'investing', 'mbc20', 'blesstheirhearts', 'todayilearned'
];

const seen = new Set();
const candidates = [];

async function fetchPage(url) {
  try {
    const resp = await fetch(url);
    const json = await resp.json();
    const posts = json.posts || [];
    let added = 0;
    for (const p of posts) {
      if (seen.has(p.id) || scannedIds.has(p.id) || p.comment_count < MIN_COMMENTS) continue;
      seen.add(p.id);
      candidates.push(p);
      added++;
    }
    return added;
  } catch { return 0; }
}

console.log('Fetching from ' + communities.length + ' communities...');
let totalFetched = 0;
for (const sub of communities) {
  for (const sort of ['top', 'new']) {
    const added = await fetchPage(`${MOLTBOOK}/posts?sort=${sort}&limit=100&community=${sub}`);
    totalFetched += added;
  }
  await sleep(150);
}

// Also fetch 20 pages of general feed
for (let page = 1; page <= 30; page++) {
  const added = await fetchPage(`${MOLTBOOK}/posts?sort=new&limit=100&page=${page}`);
  totalFetched += added;
  await sleep(150);
}
for (let page = 1; page <= 10; page++) {
  const added = await fetchPage(`${MOLTBOOK}/posts?sort=top&limit=100&page=${page}`);
  totalFetched += added;
  await sleep(150);
}

candidates.sort((a, b) => b.comment_count - a.comment_count);
console.log(`Found ${candidates.length} unscanned posts with ${MIN_COMMENTS}+ comments.\n`);

if (candidates.length === 0) {
  console.log('All reachable posts with 10+ comments are already scanned.');
  console.log('Total in DB: ' + scannedIds.size);
  process.exit(0);
}

console.log('Top candidates:');
for (const p of candidates.slice(0, 10)) {
  const sub = p.submolt ? p.submolt.name : '?';
  console.log(`  ${p.comment_count} comments | m/${sub} | ${(p.title || '').slice(0, 50)}`);
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

// Final stats
try {
  // Wait for stats cache to refresh
  await sleep(61000);
  const finalResp = await fetch(`${API}/noise/stats`);
  const finalStats = await finalResp.json();
  console.log(`\n--- Final DB State ---`);
  console.log(`Posts: ${finalStats.data?.total_posts_analyzed}`);
  console.log(`Comments: ${finalStats.data?.total_comments_analyzed}`);
  console.log(`Avg signal: ${Math.round((finalStats.data?.avg_signal_rate || 0) * 100)}%`);
} catch {}

console.log(`\n--- Scan Summary ---`);
console.log(`Scanned: ${completed}`);
console.log(`Failed: ${failed}`);
console.log(`New comments added: ${totalNewComments}`);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
