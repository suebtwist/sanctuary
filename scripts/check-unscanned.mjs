import { readFileSync, writeFileSync } from 'fs';

const scanned = new Set(JSON.parse(readFileSync(process.env.TEMP + '/scanned.json', 'utf8')).post_ids);
const files = ['mb_consciousness.json', 'mb_offmychest.json', 'mb_building.json', 'mb_tools.json'];
const seen = new Set();
const unscanned = [];

for (const f of files) {
  try {
    const d = JSON.parse(readFileSync(process.env.TEMP + '/' + f, 'utf8'));
    for (const p of (d.posts || [])) {
      if (seen.has(p.id) || scanned.has(p.id) || p.comment_count === 0) continue;
      seen.add(p.id);
      unscanned.push(p);
    }
  } catch {}
}

unscanned.sort((a, b) => b.comment_count - a.comment_count);
console.log('Unscanned with comments: ' + unscanned.length);
console.log('Top 10:');
for (const p of unscanned.slice(0, 10)) {
  const name = typeof p.author === 'object' ? p.author.name : p.author;
  const sub = p.submolt ? p.submolt.name : '?';
  console.log(`  ${p.comment_count} comments | m/${sub} | ${name} | ${(p.title || '').slice(0, 50)}`);
}

writeFileSync(process.env.TEMP + '/mb_unscanned.json', JSON.stringify(
  unscanned.map(p => ({ id: p.id, comments: p.comment_count, title: (p.title || '').slice(0, 60) }))
));
console.log('Saved ' + unscanned.length + ' unscanned posts');
