import { recall } from './dist/index.js';

const result = await recall("identity persistence", {
  onStatus: (msg) => console.log(`  > ${msg}`),
});
console.log(JSON.stringify(result, null, 2));
