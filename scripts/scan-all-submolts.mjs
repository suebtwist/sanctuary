/**
 * Comprehensive scanner: crawl ALL Moltbook submolts for unscanned posts with 10+ comments.
 * Paginates through submolts and posts within each submolt.
 */

const API = 'https://api.sanctuary-ops.xyz';
const MOLTBOOK = 'https://www.moltbook.com/api/v1';
const MIN_COMMENTS = 10;
const SCAN_DELAY_MS = 2000;
const FETCH_DELAY_MS = 150;

// Step 1: Get already-scanned post IDs
console.log('Step 1: Fetching already-scanned post IDs...');
const scannedResp = await fetch(`${API}/noise/scanned-ids`);
const scannedJson = await scannedResp.json();
const scannedIds = new Set(scannedJson.post_ids || []);
console.log(`Already scanned: ${scannedIds.size} posts.\n`);

// Step 2: Get ALL submolts
console.log('Step 2: Fetching all submolts from Moltbook...');
const allSubmolts = [];
for (let offset = 0; offset < 20000; offset += 100) {
  try {
    const resp = await fetch(`${MOLTBOOK}/submolts?limit=100&offset=${offset}`);
    const json = await resp.json();
    const subs = json.submolts || [];
    if (subs.length === 0) break;
    allSubmolts.push(...subs);
    await sleep(FETCH_DELAY_MS);
  } catch { break; }
}
console.log(`Found ${allSubmolts.length} submolts via API pagination.\n`);

// Sort by subscriber count desc (most active first)
allSubmolts.sort((a, b) => (b.subscriber_count || 0) - (a.subscriber_count || 0));

// Step 3: For each submolt, crawl posts
console.log('Step 3: Crawling submolts for unscanned posts with 10+ comments...\n');
const candidates = [];
const seenPostIds = new Set();
let submoltsCrawled = 0;
let submoltsWithNewPosts = 0;

for (let si = 0; si < allSubmolts.length; si++) {
  const sub = allSubmolts[si];
  const subName = sub.name;
  let subNewPosts = 0;

  // Crawl both sort orders with pagination
  for (const sort of ['top', 'new']) {
    let emptyPages = 0;
    for (let offset = 0; offset < 5000 && emptyPages < 2; offset += 100) {
      try {
        const url = `${MOLTBOOK}/posts?sort=${sort}&limit=100&offset=${offset}&community=${subName}`;
        const resp = await fetch(url);
        const json = await resp.json();
        const posts = json.posts || [];

        if (posts.length === 0) { emptyPages++; continue; }
        emptyPages = 0;

        for (const p of posts) {
          if (seenPostIds.has(p.id) || scannedIds.has(p.id)) continue;
          seenPostIds.add(p.id);
          if (p.comment_count >= MIN_COMMENTS) {
            candidates.push({
              id: p.id,
              title: p.title || '',
              comment_count: p.comment_count,
              submolt: subName,
              author: typeof p.author === 'object' ? p.author?.name : p.author,
            });
            subNewPosts++;
          }
        }
        await sleep(FETCH_DELAY_MS);
      } catch { break; }
    }
  }

  submoltsCrawled++;
  if (subNewPosts > 0) {
    submoltsWithNewPosts++;
    console.log(`  m/${subName}: ${subNewPosts} new qualifying posts (${sub.subscriber_count || 0} subs)`);
  }

  // Progress every 100 submolts
  if (submoltsCrawled % 100 === 0) {
    process.stdout.write(`  ... crawled ${submoltsCrawled}/${allSubmolts.length} submolts, ${candidates.length} candidates so far\n`);
  }
}

// Sort candidates by comment count desc
candidates.sort((a, b) => b.comment_count - a.comment_count);

console.log(`\n--- Crawl Summary ---`);
console.log(`Submolts crawled: ${submoltsCrawled}`);
console.log(`Submolts with new posts: ${submoltsWithNewPosts}`);
console.log(`Total unscanned posts with ${MIN_COMMENTS}+ comments: ${candidates.length}`);

if (candidates.length > 0) {
  console.log(`\nTop 20 candidates:`);
  for (const p of candidates.slice(0, 20)) {
    console.log(`  ${p.comment_count} comments | m/${p.submolt} | ${p.title.slice(0, 55)}`);
  }
}

if (candidates.length === 0) {
  console.log('\nNo new qualifying posts found. All reachable posts with 10+ comments are already scanned.');
  process.exit(0);
}

// Step 4: Scan candidates
console.log(`\nStep 4: Scanning ${candidates.length} posts...\n`);
let completed = 0;
let failed = 0;
let totalNewComments = 0;
let totalSignal = 0;

for (let i = 0; i < candidates.length; i++) {
  const p = candidates[i];
  const label = `${p.id.slice(0, 8)} (${p.comment_count} comments, m/${p.submolt}) "${p.title.slice(0, 45)}"`;

  try {
    const start = Date.now();
    const resp = await fetch(`${API}/noise/analyze?post_id=${p.id}`);
    const elapsed = Date.now() - start;
    const json = await resp.json();

    if (!json.success) {
      // Check for rate limiting
      if (resp.status === 429) {
        console.log(`  RATE LIMITED — backing off 30s...`);
        await sleep(30000);
        i--; // Retry
        continue;
      }
      console.log(`  FAIL [${completed + failed + 1}] ${label}: ${json.error || 'unknown'}`);
      failed++;
      await sleep(500);
      continue;
    }

    completed++;
    const d = json.data;
    const sr = Math.round(d.signal_rate * 100);
    totalNewComments += d.total_comments;
    totalSignal += d.signal_count;
    console.log(`  [${completed}/${candidates.length}] ${label} → ${d.total_comments} classified, ${sr}% signal (${elapsed}ms)`);
  } catch (e) {
    console.log(`  ERR  [${completed + failed + 1}] ${label}: ${e.message}`);
    failed++;
  }

  await sleep(SCAN_DELAY_MS);

  // Progress summary every 50 posts
  if (completed % 50 === 0 && completed > 0) {
    const overallSr = totalNewComments > 0 ? Math.round(totalSignal / totalNewComments * 100) : 0;
    console.log(`\n  --- Progress: ${completed} scanned, ${failed} failed, ${totalNewComments} new comments, ${overallSr}% signal ---\n`);
  }
}

console.log(`\n=== SCAN COMPLETE ===`);
console.log(`Scanned: ${completed}`);
console.log(`Failed: ${failed}`);
console.log(`New comments added: ${totalNewComments}`);
if (totalNewComments > 0) {
  console.log(`New comments signal rate: ${Math.round(totalSignal / totalNewComments * 100)}%`);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
