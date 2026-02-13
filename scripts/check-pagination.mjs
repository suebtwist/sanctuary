import { readFileSync } from 'fs';

const labels = ['p1','p2','p3','p10','p50','off100','off500','cur100'];
const allIds = new Map(); // id -> label where first seen

for (const l of labels) {
  const d = JSON.parse(readFileSync(process.env.TEMP + '/' + l + '.json', 'utf8'));
  const posts = d.posts || [];
  const first = posts[0];
  const last = posts[posts.length - 1];
  let newCount = 0;
  for (const p of posts) {
    if (!allIds.has(p.id)) {
      allIds.set(p.id, l);
      newCount++;
    }
  }
  console.log(`${l}: ${posts.length} posts, ${newCount} new | first: ${first ? first.comment_count + ' comments' : 'none'} | last: ${last ? last.comment_count + ' comments' : 'none'}`);
}

console.log(`\nTotal unique posts across all fetches: ${allIds.size}`);

// Check response metadata
for (const l of ['p1', 'off100']) {
  const d = JSON.parse(readFileSync(process.env.TEMP + '/' + l + '.json', 'utf8'));
  const keys = Object.keys(d).filter(k => k !== 'posts');
  if (keys.length > 0) {
    console.log(`\n${l} metadata keys: ${keys.join(', ')}`);
    for (const k of keys) {
      console.log(`  ${k}: ${JSON.stringify(d[k]).slice(0, 100)}`);
    }
  }
}
