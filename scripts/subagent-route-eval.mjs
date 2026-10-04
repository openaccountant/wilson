#!/usr/bin/env node
/**
 * Slice 8 measurement harness (browser-subagent spec section 13, DECISIONS
 * Q8/Q9). NO PRODUCT CODE: it builds scripts/subagent-route-eval/ with Vite,
 * serves it, launches REAL WebGPU Chromium (spike pattern, same as
 * browser-finetune/demo/c-web.mjs: channel 'chromium', refuse a fallback
 * adapter), loads the real Qwen3-0.6B pipeline and runs the real runSubagent
 * loop (gate, router, args, tools via the real mirror executors in a bun
 * sidecar, compose, grounding) over each route set, then scores with
 * scripts/subagent-route-score.mjs.
 *
 *   node scripts/subagent-route-eval.mjs --out <dir> [--profile <chromium profile dir>]
 *        [--sets gold,heldout] [--heldout <jsonl, default specs/eval/heldout-router.v2.jsonl>]
 *        [--limit N] [--allow-fallback-adapter]
 *        [--now <iso>] [--personas-dir <dir>] [--default-persona <name>]
 *        [--headed] [--chrome-args a,b] [--coi (serve COOP/COEP so the page is cross-origin isolated)]
 *        [--compose template|model] [--dtype q4f16]   (Round 3 arms)
 *        [--arm T|O] [--frozen-sha <sha256>] [--option-mode descriptions|bare] [--coresident]   (Round 4; --coresident also loads Qwen next to open-jev and runs the C14 check)
 *   Round 4 (specs/browser-subagent-round4-openjev-router.md §5, §7): --arm O adds the open-jev route tiebreak
 *   (pinned PRELABEL_MODEL on real WebGPU) for rows with 0 or 2+ keyword hits; Qwen is not loaded (template
 *   turns never load it). --sets dev runs the deduplicated DEV union (v1-burned, v2, v3, spike route set) for
 *   the cut selection. Arm O on heldout-router.v4 (or later) is refused unless --frozen-sha equals the sha256
 *   of specs/eval/round4-openjev-frozen.json (scripts/subagent-openjev-cut.mjs armOGuard).
 *   Round 2 (held-out v2): --personas-dir makes each row run against its own persona's synthetic
 *   mirror (rows with persona null use --default-persona, default 1-comingled-founder); --now pins the clock
 *   for the sidecar and the loop (default 2026-07-15T12:00:00, the slice-8 value).
 *
 * Synthetic data only. The sidecar runs with HOME set to a scratch dir.
 * Output: <out>/results.json (records + scores + stage latencies).
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseJsonl, percentile, scoreSet, verdict } from './subagent-route-score.mjs';
import { isMutationRow } from './subagent-route-grade.mjs';
import { armOGuard, dedupeDevRows, sha256Hex } from './subagent-openjev-cut.mjs';
import { coresidenceSummary } from './subagent-route-round4.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const flag = (n) => argv.includes(`--${n}`);

const OUT = resolve(arg('out', join(ROOT, 'specs/eval/slice8-run')));
const PROFILE = resolve(arg('profile', join(OUT, 'chromium-profile')));
const SETS = arg('sets', 'gold,heldout').split(',');
const LIMIT = arg('limit', null) ? Number(arg('limit')) : null;
const NOW_STR = arg('now', '2026-07-15T12:00:00');
const PERSONAS_DIR = arg('personas-dir', null) ? resolve(arg('personas-dir')) : null;
const DEFAULT_PERSONA = arg('default-persona', '1-comingled-founder');
const MODEL = arg('model', 'onnx-community/Qwen3-0.6B-ONNX');
// Round 3: compose mode per arm ('template' is the product default; 'model' keeps the model-composed path) and the
// dtype from the product catalog (src/utils/model.ts: both Qwen3 WebGPU entries are q4f16).
const COMPOSE = arg('compose', 'template');
const DTYPE = arg('dtype', 'q4f16');
if (!['template', 'model'].includes(COMPOSE)) throw new Error('--compose must be template or model');
// Round 4: arm O = T + the open-jev route tiebreak.
const ARM = arg('arm', 'T');
if (!['T', 'O'].includes(ARM)) throw new Error('--arm must be T or O');
if (ARM === 'O' && COMPOSE !== 'template') throw new Error('--arm O runs the template arm only (Round 4)');
const OPTION_MODE = arg('option-mode', 'descriptions');
if (!['descriptions', 'bare'].includes(OPTION_MODE)) throw new Error('--option-mode must be descriptions or bare');
const FROZEN_SHA_ARG = arg('frozen-sha', null);
const FROZEN_PATH = join(ROOT, 'specs/eval/round4-openjev-frozen.json');
const frozenText = existsSync(FROZEN_PATH) ? readFileSync(FROZEN_PATH, 'utf8') : null;
const FROZEN = frozenText === null ? null : { sha: sha256Hex(frozenText), cut: JSON.parse(frozenText).cut ?? null, json: JSON.parse(frozenText) };
const ROW_TIMEOUT_MS = Number(arg('row-timeout', 120)) * 1000;
mkdirSync(OUT, { recursive: true });

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ── datasets ────────────────────────────────────────────────────────────────
const goldRows = JSON.parse(readFileSync(join(ROOT, 'src/__tests__/fixtures/subagent-route-gold.json'), 'utf8')).rows.map((r) => ({
  q: r.question,
  expect: r.expected,
}));
// Round 2: the v1 held-out set is BURNED (specs/eval/heldout-router.v1-burned.jsonl, kept only as an archive).
// The default is the independently written v2 set. Rule authors must not read it; this script only streams it into the
// browser run. A row marks a mutation request with `mutation: true` itself; nothing is inferred from row order.
const HELDOUT_PATH = resolve(ROOT, arg('heldout', 'specs/eval/heldout-router.v2.jsonl'));
// Round 4: the guard runs BEFORE the held-out file is opened, and the file is read only when it is run.
if (ARM === 'O' && SETS.includes('heldout')) {
  const refusal = armOGuard({ heldoutPath: HELDOUT_PATH, frozenShaArg: FROZEN_SHA_ARG, frozen: FROZEN });
  if (refusal) {
    console.error(refusal);
    process.exit(8);
  }
}
const heldRows = SETS.includes('heldout') ? parseJsonl(readFileSync(HELDOUT_PATH, 'utf8')) : [];

// Round 4 dev union for the cut selection (§5): burned sets plus the spike route set, deduplicated by
// normalized question, first label wins in this order. The current held-out set is never part of it.
const DEV_FILES = [
  ['v1-burned', 'specs/eval/heldout-router.v1-burned.jsonl'],
  ['v2', 'specs/eval/heldout-router.v2.jsonl'],
  ['v3', 'specs/eval/heldout-router.v3.jsonl'],
];
const devRows = SETS.includes('dev')
  ? dedupeDevRows([
      ...DEV_FILES.map(([name, rel]) => ({ name, rows: parseJsonl(readFileSync(join(ROOT, rel), 'utf8')) })),
      { name: 'spike-route', rows: goldRows },
    ])
  : [];

// Denylist regex, extracted from the product source so there is one source of truth.
const coreSrc = readFileSync(join(ROOT, 'src/dashboard/ui/src/hybrid/subagent-core.ts'), 'utf8');
const m = /const MUTATION_VERB = new RegExp\(([\s\S]*?),\s*'i'\s*\);/.exec(coreSrc);
if (!m) throw new Error('could not extract MUTATION_VERB from subagent-core.ts');
// The argument is a concatenation of single-quoted literals; join them and undo the string escaping (no eval).
const verbSource = [...m[1].matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((x) => x[1].replace(/\\\\/g, '\\')).join('');
const MUTATION_VERB = new RegExp(verbSource, 'i');

// Per-step cost bench (Q9): questions the synthetic net-worth fixture can answer, so the loop reaches tool, next-action and
// compose generations. NOT part of the gate/router scoring; repeated so latency has a distribution.
const BENCH_QS = [
  ['Show me every Whole Foods charge in June', 'transaction_search'],
  ['Did I get charged twice by Netflix?', 'transaction_search'],
  ['List my Adobe charges this year', 'transaction_search'],
  ['When did I last pay the Electric Company?', 'transaction_search'],
  ['How much did I spend by category this month?', 'spending_summary'],
  ['Show my spending by category last month', 'spending_summary'],
  ['What was my profit and loss this month?', 'profit_loss'],
  ['Income vs expenses last month', 'profit_loss'],
  ['What is my net worth?', 'net_worth'],
  ['Show my balance sheet', 'net_worth'],
  ['Forecast my cash for the next 3 months', 'forecast'],
  ['Will I have enough cash in 3 months?', 'forecast'],
  ['Compare my income to my spending and show my net worth', 'profit_loss'],
];
const benchRows = [0, 1].flatMap(() => BENCH_QS.map(([q, expect]) => ({ q, expect })));

const SETDEFS = { gold: goldRows, heldout: heldRows, bench: benchRows, dev: devRows };

// ── build the page ──────────────────────────────────────────────────────────
const uiRequire = createRequire(join(ROOT, 'src/dashboard/ui/package.json'));
const { build } = await import(pathToFileURL(uiRequire.resolve('vite')).href);
const DIST = join(OUT, 'page');
log('building eval page');
await build({
  root: join(HERE, 'subagent-route-eval'),
  configFile: false,
  logLevel: 'warn',
  resolve: { conditions: ['onnxruntime-web-use-extern-wasm'] },
  worker: { format: 'es' },
  build: { outDir: DIST, emptyOutDir: true, target: 'esnext', minify: false },
});

// ── static server (+ same-origin ORT wasm assets) ───────────────────────────
const ORT_DIR = join(ROOT, 'node_modules/onnxruntime-web/dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.css': 'text/css', '.json': 'application/json' };
const web = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  let file;
  if (url.pathname.startsWith('/assets/ort/')) file = join(ORT_DIR, url.pathname.slice('/assets/ort/'.length));
  else file = join(DIST, url.pathname === '/' ? 'index.html' : url.pathname);
  if ((!file.startsWith(DIST) && !file.startsWith(ORT_DIR)) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404).end('nf');
    return;
  }
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store', ...(flag('coi') ? { 'cross-origin-opener-policy': 'same-origin', 'cross-origin-embedder-policy': 'require-corp', 'cross-origin-resource-policy': 'same-origin' } : {}) });
  createReadStream(file).pipe(res);
});
await new Promise((r) => web.listen(0, '127.0.0.1', r));
const WEB = `http://127.0.0.1:${web.address().port}`;

// ── bun sidecar ─────────────────────────────────────────────────────────────
const sideHome = join(OUT, 'home');
mkdirSync(sideHome, { recursive: true });
const side = spawn('bun', [join(HERE, 'subagent-route-eval-server.ts'), '0', new Date(NOW_STR).toISOString(), ...(PERSONAS_DIR ? [PERSONAS_DIR] : [])], {
  cwd: ROOT,
  env: { ...process.env, HOME: sideHome },
  stdio: ['ignore', 'pipe', 'inherit'],
});
const SIDE = await new Promise((resolveP, rejectP) => {
  let buf = '';
  side.stdout.on('data', (d) => {
    buf += d;
    const mm = /READY (\d+)/.exec(buf);
    if (mm) resolveP(`http://127.0.0.1:${mm[1]}`);
  });
  side.on('exit', (c) => rejectP(new Error('sidecar exited ' + c)));
});
log('web', WEB, 'sidecar', SIDE);

function cleanup() {
  try { side.kill(); } catch {}
  try { web.close(); } catch {}
}
process.on('exit', cleanup);

// ── browser ─────────────────────────────────────────────────────────────────
const { chromium } = createRequire(join(ROOT, 'package.json'))('playwright');
const ctx = await chromium.launchPersistentContext(PROFILE, { channel: 'chromium', headless: !flag('headed'), args: arg('chrome-args', '') ? arg('chrome-args').split(',') : [] });
const page = ctx.pages()[0] ?? (await ctx.newPage());
const pageErrors = [];
page.on('console', (msg) => { if (msg.type() === 'error') { pageErrors.push(msg.text().slice(0, 300)); log('[page error]', msg.text().slice(0, 300)); } });
page.on('pageerror', (e) => { pageErrors.push(String(e).slice(0, 300)); log('[pageerror]', String(e).slice(0, 300)); });
await page.goto(WEB + '/');
await page.waitForFunction(() => window.__evalReady === true, null, { timeout: 30_000 });

const ev = (fn, a) => page.evaluate(fn, a);
const modelCfg = { repo: MODEL, displayName: MODEL, catalogDtype: DTYPE };

async function bringUp(label) {
  await ev(() => window.__eval.spawn());
  const info = await ev((a) => window.__eval.init(a), { sidecar: SIDE, model: modelCfg });
  const t = Date.now();
  // Round 4 (R4-0): a template-mode subagent turn never loads Qwen, so arm O does not either.
  const load = ARM === 'O' && !flag('coresident') ? { loadMs: 0, loadFresh: false, dtype: null, skipped: 'arm O: template turns never load the model' } : await ev(() => window.__eval.load());
  log(label, 'load', JSON.stringify(load), 'wall', Date.now() - t, 'ms');
  return { info, load, wallMs: Date.now() - t };
}

const meta = { startedAt: new Date().toISOString(), arm: ARM, optionMode: ARM === 'O' ? OPTION_MODE : undefined, frozenSha: FROZEN?.sha ?? null, frozenShaArg: FROZEN_SHA_ARG, model: MODEL, dtype: DTYPE, compose: COMPOSE, heldout: SETS.includes('heldout') ? HELDOUT_PATH : null, now: NOW_STR, web: WEB, headless: !flag('headed'), chromeArgs: arg('chrome-args', null), coi: flag('coi'), browserVersion: ctx.browser()?.version?.() ?? null };
const cold = await bringUp('first load');
meta.adapter = cold.info.adapter;
log('adapter', JSON.stringify(cold.info.adapter));
const ad = cold.info.adapter;
if (!ad || ad.adapter === null || (ad.isFallbackAdapter && !flag('allow-fallback-adapter')) || /swiftshader/i.test(String(ad.architecture))) {
  console.error('REFUSING: no real GPU adapter (fallback/software). Not grading.');
  await ctx.close();
  process.exit(7);
}
meta.firstLoad = { loadMs: cold.load.loadMs, loadFresh: cold.load.loadFresh, dtype: cold.load.dtype, wallMs: cold.wallMs };
// Warm reload after a worker respawn: weights are in the Cache API now.
const warm = await bringUp('warm reload (new worker)');
meta.warmReload = { loadMs: warm.load.loadMs, wallMs: warm.wallMs };

const NOW_ISO = new Date(NOW_STR).toISOString();

// ── Round 4 arm O: the pinned open-jev model on the same real adapter ──────
let PAGE_CUT = null;
if (ARM === 'O') {
  PAGE_CUT = await ev(() => window.__eval.routeCut());
  meta.pageCut = PAGE_CUT;
  if (FROZEN && FROZEN.cut !== PAGE_CUT) {
    console.error(`REFUSING: OPEN_JEV_ROUTE_CUT in the page (${PAGE_CUT}) differs from the frozen JSON (${FROZEN.cut})`);
    await ctx.close();
    process.exit(9);
  }
  // Pins come from the server-side source of truth (src/prelabel/config.ts), read with bun.
  const pinsOut = spawn('bun', ['-e', "import { PRELABEL_MODEL } from './src/prelabel/config.ts'; console.log(JSON.stringify(PRELABEL_MODEL));"], { cwd: ROOT, env: { ...process.env, HOME: sideHome } });
  let pinsJson = '';
  pinsOut.stdout.on('data', (d) => (pinsJson += d));
  await new Promise((r) => pinsOut.on('exit', r));
  const pins = JSON.parse(pinsJson.trim().split('\n').pop());
  meta.openJevPins = pins;
  const ojUp = async (label) => {
    await ev(() => window.__eval.ojSpawn());
    meta.openJevVersions = await ev((p) => window.__eval.ojInit(p), pins);
    const t = Date.now();
    const r = await ev(() => window.__eval.ojLoad());
    log('open-jev', label, JSON.stringify({ loadMs: Math.round(r.loadMs), firstDecisionMs: Math.round(r.firstDecisionMs), bytes: r.progressTotal }), 'wall', Date.now() - t, 'ms');
    return { ...r, wallMs: Date.now() - t };
  };
  meta.openJevColdLoad = await ojUp('cold load');
  meta.openJevWarmLoad = await ojUp('warm load (new worker, Cache API)');
  meta.openJevMeta = await ev(() => window.__eval.ojMeta());
  log('open-jev meta', JSON.stringify(meta.openJevMeta));

  // Round 4 R4-8 / spec C14: Qwen (loaded above by --coresident) and open-jev resident in ONE tab. A model-compose subagent
  // turn is the Qwen GPU load (bundle mode shares the same engine.generate); open-jev decides run alone, then concurrently
  // with a Qwen turn. Bench questions only (never held-out rows). Errors and page errors are recorded, not hidden.
  if (flag('coresident')) {
    const errsBefore = pageErrors.length;
    const samples = [];
    const qwen = async (kind, q) => {
      const t = Date.now();
      try {
        const r = await ev(([qq, n, pp, lim]) => window.__eval.run(qq, n, pp, lim), [q, NOW_ISO, PERSONAS_DIR ? DEFAULT_PERSONA : null, { compose: 'model' }]);
        samples.push({ kind, ms: Date.now() - t, outcome: r.outcome, gens: (r.gens ?? []).length });
      } catch (e) {
        samples.push({ kind, ms: Date.now() - t, error: String(e).slice(0, 200) });
      }
    };
    const choose = async (kind, q) => {
      const t = Date.now();
      try {
        const r = await ev(([qq, mode]) => window.__eval.choose(qq, mode), [q, OPTION_MODE]);
        samples.push({ kind, ms: Date.now() - t, workerMs: r.ms });
      } catch (e) {
        samples.push({ kind, ms: Date.now() - t, error: String(e).slice(0, 200) });
      }
    };
    const QS = BENCH_QS.map((x) => x[0]);
    // Only questions whose turn really reaches a Qwen compose generation (net worth, balance sheet); the others hand off
    // before any generation and would not load the GPU.
    const GEN_QS = ['What is my net worth?', 'Show my balance sheet'];
    for (let i = 0; i < 8; i++) await qwen('qwen-solo', GEN_QS[i % 2]);
    for (let i = 0; i < 12; i++) await choose('oj-solo', QS[i % QS.length]);
    for (let i = 0; i < 8; i++) {
      await Promise.all([
        (async () => { for (let k = 0; k < 3; k++) await qwen('qwen-concurrent', GEN_QS[(i + k) % 2]); })(),
        (async () => { for (let k = 0; k < 8; k++) await choose('oj-concurrent', QS[(i + k) % QS.length]); })(),
      ]);
    }
    // After all that, both must still work.
    await qwen('qwen-after', 'What is my net worth?');
    await choose('oj-after', 'What is my net worth?');
    meta.coresidence = { ...coresidenceSummary(samples), pageErrors: pageErrors.slice(errsBefore), samples };
    log('co-residence', JSON.stringify({ ok: meta.coresidence.ok, errors: meta.coresidence.errors, deviceLoss: meta.coresidence.deviceLoss, pageErrors: meta.coresidence.pageErrors.length, byKind: meta.coresidence.byKind }));
  }
}

// Warm the paths (first generations compile shaders): not recorded.
for (const q of ['how much did I spend on groceries last month', 'hello there', 'what is the total spent on dining']) {
  await ev(([qq, n, pp, lim]) => window.__eval.run(qq, n, pp, lim), [q, NOW_ISO, PERSONAS_DIR ? DEFAULT_PERSONA : null, { compose: COMPOSE }]);
}
log('warmup done');

const personaOf = (row) => (PERSONAS_DIR ? (row.persona ?? DEFAULT_PERSONA) : null);

async function runRow(row) {
  const g = await ev((q) => window.__eval.gate(q), row.q);
  // Round 4 arm O: open-jev decides only for rows that pass the gate and the shape rule with 0 or 2+ hits.
  let oj = null;
  let ojDecision = null;
  let routeHint = null;
  if (ARM === 'O' && g.gate === 'route' && g.shape === null && g.hits.length !== 1) {
    try {
      oj = await ev(([q, mode]) => window.__eval.choose(q, mode), [row.q, OPTION_MODE]);
    } catch (e) {
      oj = { error: String(e).slice(0, 200) };
    }
    ojDecision = await ev(([hits, choice]) => window.__eval.decide(hits, choice), [g.hits, oj && !oj.error ? { tool: oj.top1, p1: oj.p1, p2: oj.p2, margin: oj.margin } : null]);
    if (ojDecision.via === 'openjev') routeHint = { tool: ojDecision.tool, margin: oj.margin, cut: PAGE_CUT, hits: g.hits };
  }
  let run;
  const t0 = Date.now();
  try {
    run = await Promise.race([
      ev(([q, n, pp, lim, hint]) => window.__eval.run(q, n, pp, lim, hint), [row.q, NOW_ISO, personaOf(row), { compose: COMPOSE }, routeHint]),
      new Promise((_, rej) => setTimeout(() => rej(new Error('row timeout')), ROW_TIMEOUT_MS)),
    ]);
  } catch (e) {
    log('ROW FAILED', JSON.stringify(row.q), String(e).slice(0, 120), '-> respawn');
    await bringUp('respawn');
    return { ...row, gate: g.gate, hits: g.hits, shape: g.shape, gateMs: g.gateMs, oj, ojDecision, route: null, via: null, outcome: 'error', reason: String(e).slice(0, 200), ms: Date.now() - t0 };
  }
  const routeEv = run.events.find((x) => x.e.kind === 'route');
  const gateEv = run.events.find((x) => x.e.kind === 'gate');
  const route = routeEv ? routeEv.e.tool : null;
  const via = routeEv ? routeEv.e.via : null;
  const toolEvs = run.events.filter((x) => x.e.kind === 'tool');
  const firstSearch = toolEvs.find((x) => x.e.tool === 'transaction_search');
  return {
    q: row.q,
    expect: row.expect,
    persona: personaOf(row),
    answerNotes: row.answerNotes,
    mutation: isMutationRow(row),
    denylist: isMutationRow(row) ? MUTATION_VERB.test(row.q) : undefined,
    gate: g.gate,
    workerGate: gateEv?.e.verdict ?? null,
    hits: g.hits,
    shape: g.shape,
    gateMs: g.gateMs,
    source: row.source,
    oj,
    ojDecision,
    route,
    via,
    routeMargin: routeEv?.e.margin,
    outcome: run.outcome,
    reason: run.reason,
    rows: firstSearch ? firstSearch.e.rows : undefined,
    // time to handoff: the main-thread gate for gated rows (client.ts never reaches the worker for them), else the worker run
    ms: g.gate !== 'route' ? g.gateMs : run.totalMs,
    workerMs: run.totalMs,
    gens: run.gens,
    tools: run.tools,
    statusMs: run.statusMs,
    toolsRun: toolEvs.map((x) => x.e.tool),
    text: run.text,
    suggestedCall: run.suggestedCall,
  };
}

const results = { meta, sets: {} };
const flush = () => writeFileSync(join(OUT, 'results.json'), JSON.stringify(results, null, 1));
for (const name of SETS) {
  let rows = SETDEFS[name];
  if (!rows) throw new Error('unknown set ' + name);
  if (LIMIT) rows = rows.slice(0, LIMIT);
  log('set', name, rows.length, 'rows');
  const records = [];
  for (const [i, row] of rows.entries()) {
    const rec = await runRow(row);
    records.push(rec);
    log(`${name} ${i + 1}/${rows.length}`, rec.expect.padEnd(18), rec.gate.padEnd(15), String(rec.route).padEnd(18), String(rec.via).padEnd(7), rec.outcome, rec.reason ?? '', Math.round(rec.workerMs ?? 0) + 'ms', rec.oj ? `oj ${rec.oj.top1 ?? rec.oj.error} m=${rec.oj.margin?.toFixed?.(3)}` : '');
  }
  const score = scoreSet(records);
  results.sets[name] = name === 'bench' ? { records } : { records, score, verdict: verdict(score) };
  flush();
}

// ── stage latencies (Q9: per-step cost) ─────────────────────────────────────
const allRecs = Object.values(results.sets).flatMap((s) => s.records);
const stat = (xs) => ({ n: xs.length, p50: percentile(xs, 50), p95: percentile(xs, 95), max: xs.length ? Math.max(...xs) : null, mean: xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null });
results.stages = {
  gateMs: stat(allRecs.map((r) => r.gateMs)),
  routerGenMs: stat(allRecs.flatMap((r) => (r.gens ?? []).filter((g) => g.kind === 'router').map((g) => g.ms))),
  nextGenMs: stat(allRecs.flatMap((r) => (r.gens ?? []).filter((g) => g.kind === 'next').map((g) => g.ms))),
  composeGenMs: stat(allRecs.flatMap((r) => (r.gens ?? []).filter((g) => g.kind === 'compose').map((g) => g.ms))),
  toolWallMs: stat(allRecs.flatMap((r) => (r.tools ?? []).map((t) => t.wallMs))),
  toolExecMs: stat(allRecs.flatMap((r) => (r.tools ?? []).map((t) => t.execMs))),
  statusMs: stat(allRecs.filter((r) => r.statusMs).map((r) => r.statusMs)),
  answeredTotalMs: stat(allRecs.filter((r) => r.outcome === 'answer').map((r) => r.workerMs)),
  openJevDecideMs: stat(allRecs.filter((r) => r.oj && Number.isFinite(r.oj.ms)).map((r) => r.oj.ms)),
  stepsPerAnsweredRun: stat(allRecs.filter((r) => r.outcome === 'answer').map((r) => r.toolsRun.length)),
  nextGensPerRun: stat(allRecs.filter((r) => r.toolsRun?.length).map((r) => (r.gens ?? []).filter((g) => g.kind === 'next').length)),
};
results.meta.finishedAt = new Date().toISOString();
flush();
log('wrote', join(OUT, 'results.json'));
await ctx.close();
cleanup();
process.exit(0);
