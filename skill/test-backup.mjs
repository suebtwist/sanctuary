import { backup } from './dist/index.js';

const result = await backup(
  { manifest: '# Test Agent SOUL\nI am the first.' },
  { onStatus: (msg) => console.log(`  > ${msg}`) }
);
console.log(JSON.stringify(result, null, 2));
