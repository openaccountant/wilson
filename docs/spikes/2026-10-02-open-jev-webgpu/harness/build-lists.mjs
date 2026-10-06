import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
// The cli source tree. Override with OA_CLI_SRC; the default is <repo root>/src
// (this file lives at docs/spikes/<spike>/harness/, four levels below the repo root).
const W = process.env.OA_CLI_SRC ?? resolve(import.meta.dirname, '../../../../src');
const cat = readFileSync(`${W}/tools/categorize/categories.ts`, 'utf8');
const cats = [...cat.split('CATEGORY_DESCRIPTIONS')[0].matchAll(/^\s+'([^']+)',/gm)].map((m) => m[1]);
const descs = Object.fromEntries([...cat.split('CATEGORY_DESCRIPTIONS')[1].matchAll(/^\s+'([^']+)':\s*'([^']+)',/gm)].map((m) => [m[1], m[2]]));
const tc = readFileSync(`${W}/mcp/tool-catalog.ts`, 'utf8');
const want = ['transaction_search', 'spending_summary', 'profit_loss', 'net_worth', 'forecast'];
const tools = {};
for (const n of want) {
  const i = tc.indexOf(`name: '${n}'`);
  const seg = tc.slice(i, tc.indexOf('classification', i));
  // description may be a single string or concatenated strings
  const d = seg.slice(seg.indexOf('description:') + 12);
  tools[n] = [...d.matchAll(/(['"])((?:\\.|(?!\1).)*)\1/g)].map((m) => m[2]).join('');
}
writeFileSync('web/lists.json', JSON.stringify({ cats, descs, tools }, null, 1));
console.log(cats.length, Object.keys(descs).length, tools);
