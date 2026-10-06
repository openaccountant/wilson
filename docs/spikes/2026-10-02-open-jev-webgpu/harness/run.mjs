import { chromium } from 'playwright';
import { createServer } from 'vite';
import { createServer as net } from 'node:net';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
const HERE = import.meta.dirname;
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const MODEL = arg('model', 'open-jev'), DTYPE = arg('dtype', 'q4f16'), DEVICE = arg('device', 'webgpu');
const HEADED = argv.includes('--headed'), UNSAFE = argv.includes('--unsafe-webgpu'), ALLOW_FALLBACK = argv.includes('--allow-fallback-adapter');
const WORKLOADS = arg('workloads', 'categorize,categorize-bare,route').split(',');
const TAG = arg('tag', `${MODEL}-${DTYPE}-${DEVICE}`);
const PROFILE = resolve(HERE, 'profiles', TAG);
const OUT = resolve(HERE, 'results', `${TAG}.json`);
mkdirSync(resolve(HERE, 'results'), { recursive: true });
if (!argv.includes('--keep-profile')) rmSync(PROFILE, { recursive: true, force: true });
const port = await new Promise((res) => { const s = net(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const server = await createServer({ configFile: resolve(HERE, 'vite.config.js'), server: { port, strictPort: true, host: '127.0.0.1', hmr: false, watch: null }, logLevel: 'warn' });
await server.listen();
const base = `http://127.0.0.1:${port}/`;
const gold = { categorize: JSON.parse(readFileSync(resolve(HERE, 'gold/categorize.json'))), route: JSON.parse(readFileSync(resolve(HERE, 'gold/route.json'))) };

async function session(fn) {
  const args = UNSAFE ? ['--enable-unsafe-webgpu'] : [];
  const ctx = await chromium.launchPersistentContext(PROFILE, { headless: !HEADED, channel: 'chromium', args, viewport: { width: 1000, height: 700 } });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Network.enable');
  const urls = new Map(); const bytes = []; 
  cdp.on('Network.requestWillBeSent', (e) => urls.set(e.requestId, e.request.url));
  cdp.on('Network.loadingFinished', (e) => bytes.push({ url: urls.get(e.requestId), bytes: e.encodedDataLength }));
  const logs = []; page.on('console', (m) => logs.push(`${m.type()}: ${m.text()}`.slice(0, 300))); page.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`.slice(0, 300)));
  await page.goto(base, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 120000 });
  try { return await fn({ ctx, page, bytes, logs, version: ctx.browser()?.version() }); } finally { await ctx.close(); }
}
const summarize = (bytes) => {
  const g = (re) => bytes.filter((b) => re.test(b.url ?? '')).reduce((s, b) => s + b.bytes, 0);
  return { hf_bytes: g(/huggingface\.co|hf\.co|xethub|cdn-lfs/), jsdelivr_bytes: g(/jsdelivr/), total_bytes: bytes.reduce((s, b) => s + b.bytes, 0), n_requests: bytes.length };
};
const cfg = { model: MODEL, dtype: DTYPE, device: DEVICE };
const result = { tag: TAG, cfg, date: new Date().toISOString(), headed: HEADED, unsafe_webgpu: UNSAFE };

// ---- session 1: COLD (fresh profile, empty HTTP/Cache API storage)
await session(async ({ page, bytes, logs, version }) => {
  result.browser = version;
  result.userAgent = await page.evaluate(() => navigator.userAgent);
  result.adapter = await page.evaluate(() => window.__adapterInfo());
  result.versions = await page.evaluate(() => window.__versions());
  console.log('adapter', JSON.stringify({ v: result.adapter.vendor, a: result.adapter.architecture, fb: result.adapter.is_fallback_adapter, f16: result.adapter.shader_f16, reason: result.adapter.reason }));
  const fallback = !result.adapter.webgpu || result.adapter.is_fallback_adapter === true || result.adapter.architecture === 'swiftshader' || (result.adapter.vendor === 'google' && result.adapter.architecture !== 'metal-3');
  if (DEVICE === 'webgpu' && fallback && !ALLOW_FALLBACK) { result.status = 'blocked-fallback-adapter'; return; }
  result.info_cold = await page.evaluate((c) => window.__info(c), cfg);
  console.log('info', result.info_cold.downloadSize, 'cached', result.info_cold.isCached);
  const t0 = Date.now();
  result.load_cold = await page.evaluate((c) => window.__load(c), cfg);
  result.load_cold.wall_ms = Date.now() - t0;
  result.network_cold = summarize(bytes);
  console.log('cold load', JSON.stringify({ ok: result.load_cold.ok, ms: Math.round(result.load_cold.load_ms), rt: result.load_cold.runtime, err: result.load_cold.error?.slice(0, 300) }), result.network_cold);
  if (!result.load_cold.ok) { result.status = 'load-failed'; result.console = logs.slice(-15); return; }
  result.workloads = {};
  for (const w of WORKLOADS) {
    const rows = w.startsWith('route') ? gold.route : gold.categorize;
    const r = await page.evaluate((a) => window.__run(a), { workload: w, rows, warmup: 3 });
    const ms = r.results.map((x) => x.ms).sort((a, b) => a - b);
    const q = (p) => ms[Math.min(ms.length - 1, Math.ceil(p * ms.length) - 1)];
    const acc = r.results.filter((x) => x.pred === x.expected).length / r.results.length;
    const margins = r.results.map((x) => x.margin).sort((a, b) => a - b);
    result.workloads[w] = { n: r.results.length, first_decision_ms: r.first_ms, p50_ms: q(0.5), p95_ms: q(0.95), min_ms: ms[0], max_ms: ms.at(-1), mean_ms: ms.reduce((a, b) => a + b, 0) / ms.length,
      accuracy: acc, correct: r.results.filter((x) => x.pred === x.expected).length, margin_p10: margins[Math.floor(0.1 * margins.length)], margin_p50: margins[Math.floor(0.5 * margins.length)], margin_p90: margins[Math.floor(0.9 * margins.length)], results: r.results };
    console.log(w, 'n', r.results.length, 'p50', q(0.5).toFixed(1), 'p95', q(0.95).toFixed(1), 'first', r.first_ms.toFixed(0), 'acc', acc.toFixed(3));
  }
  result.status = 'measured';
  result.console_tail = logs.slice(-10);
});
// ---- session 2: WARM CACHE load (same profile; bytes from Cache API, no network for weights)
if (result.status === 'measured') {
  await session(async ({ page, bytes }) => {
    result.info_warm = await page.evaluate((c) => window.__info(c), cfg);
    const t0 = Date.now();
    result.load_warmcache = await page.evaluate((c) => window.__load(c), cfg);
    result.load_warmcache.wall_ms = Date.now() - t0;
    result.network_warmcache = summarize(bytes);
    console.log('warm-cache load', Math.round(result.load_warmcache.load_ms), 'ms', result.network_warmcache, 'isCached', result.info_warm.isCached);
  });
}
writeFileSync(OUT, JSON.stringify(result, null, 1));
await server.close();
console.log('wrote', OUT, result.status);
process.exit(0);
