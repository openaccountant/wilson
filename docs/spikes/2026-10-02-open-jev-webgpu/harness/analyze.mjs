import { readFileSync, readdirSync } from 'node:fs';
const R = Object.fromEntries(readdirSync('results').map((f) => [f.replace('.json', ''), JSON.parse(readFileSync('results/' + f))]));
const f = (x, d = 1) => (x == null ? '-' : x.toFixed(d));
console.log('| run | status | load cold ms | HF bytes | warm-cache load ms | workload | n | first ms | p50 | p95 | acc | margin p10/p50/p90 |');
for (const [k, r] of Object.entries(R)) {
  if (r.status !== 'measured') { console.log(`| ${k} | ${r.status} | ${f(r.load_cold?.load_ms,0)} | ${r.network_cold?.hf_bytes} | | | | | | | |`); continue; }
  for (const [w, x] of Object.entries(r.workloads))
    console.log(`| ${k} | ${r.status} | ${f(r.load_cold.load_ms, 0)} | ${r.network_cold.hf_bytes} | ${f(r.load_warmcache.load_ms, 0)} | ${w} | ${x.n} | ${f(x.first_decision_ms, 0)} | ${f(x.p50_ms)} | ${f(x.p95_ms)} | ${f(x.accuracy, 3)} (${x.correct}/${x.n}) | ${f(x.margin_p10, 3)}/${f(x.margin_p50, 3)}/${f(x.margin_p90, 3)} |`);
}
// agreement q4f16-webgpu vs fp32-wasm vs fp16-webgpu vs run2
const pred = (k, w) => R[k]?.workloads?.[w]?.results.map((x) => x.pred);
for (const w of ['route', 'categorize-bare']) {
  const a = pred('open-jev-q4f16-webgpu', w);
  for (const k of ['open-jev-q4f16-webgpu-run2', 'open-jev-fp16-webgpu', 'open-jev-fp32-wasm']) {
    const b = pred(k, w); if (!a || !b) continue;
    console.log(`agree ${w}: q4f16-webgpu vs ${k}: ${a.filter((x, i) => x === b[i]).length}/${a.length}`);
  }
}
// router analysis on route (run1 + run2 pooled separately: run1)
const route = R['open-jev-q4f16-webgpu'].workloads.route.results;
const tools = route.filter((x) => x.expected !== 'none'), none = route.filter((x) => x.expected === 'none');
console.log('route: read-tool rows', tools.length, 'correct', tools.filter((x) => x.pred === x.expected).length, '| none rows', none.length, 'predicted none', none.filter((x) => x.pred === 'none').length);
console.log('route conf of correct read-tool:', tools.filter((x) => x.pred === x.expected).map((x) => +x.conf.toFixed(2)).sort().join(' '));
console.log('route conf of none rows (all mispredicted/correct):', none.map((x) => `${x.pred}:${x.conf.toFixed(2)}`).join(' '));
for (const th of [0, 0.25, 0.3, 0.35, 0.4, 0.5]) {
  // handoff if pred==none or conf<th
  const dec = route.map((x) => ({ x, hand: x.pred === 'none' || x.conf < th }));
  const ok = dec.filter((d) => (d.x.expected === 'none' ? d.hand : !d.hand && d.x.pred === d.x.expected)).length;
  const wrongTool = dec.filter((d) => !d.hand && d.x.expected !== 'none' && d.x.pred !== d.x.expected).length;
  const toolWronglyHandled = dec.filter((d) => !d.hand && d.x.expected === 'none').length;
  console.log(`  conf<${th} -> handoff: end-to-end correct ${ok}/${route.length}, wrong tool executed ${wrongTool}, none-intent executed as tool ${toolWronglyHandled}, read-tool rows sent to handoff ${dec.filter((d) => d.hand && d.x.expected !== 'none').length}`);
}
const cb = R['open-jev-q4f16-webgpu'].workloads['categorize-bare'].results;
for (const th of [0, 0.1, 0.2, 0.3, 0.4, 0.5]) {
  const k = cb.filter((x) => x.margin >= th); console.log(`categorize-bare margin>=${th}: coverage ${k.length}/${cb.length}, acc ${k.length ? (k.filter((x) => x.pred === x.expected).length / k.length).toFixed(3) : '-'}`);
}
const pc = {}; for (const x of cb) { pc[x.expected] ??= [0, 0]; pc[x.expected][1]++; if (x.pred === x.expected) pc[x.expected][0]++; }
console.log('per-class', JSON.stringify(pc));
const des = R['open-jev-q4f16-webgpu'].workloads['categorize'].results; console.log('desc variant preds:', JSON.stringify(des.reduce((a, x) => (a[x.pred] = (a[x.pred] ?? 0) + 1, a), {})));
console.log('adapter', JSON.stringify(R['open-jev-q4f16-webgpu'].adapter).slice(0, 300), R['open-jev-q4f16-webgpu'].versions, R['open-jev-q4f16-webgpu'].browser);
console.log('info', R['open-jev-q4f16-webgpu'].info_cold.downloadSize, R['kev-0.6b-q4f16-webgpu'].info_cold.downloadSize, R['open-jev-fp16-webgpu'].info_cold.downloadSize);
console.log(JSON.stringify(R['open-jev-q4f16-webgpu'].info_cold.files));
