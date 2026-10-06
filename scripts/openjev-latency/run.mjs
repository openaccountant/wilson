#!/usr/bin/env node
/**
 * open-jev pre-labeler latency harness (issue #155). Does NOT change product behaviour.
 *
 *   node scripts/openjev-latency/run.mjs --runs 5 --rows 49 --warmup 3 --label idle-m3
 *
 * Runs the same engine (src/dashboard/ui/src/prelabel/worker-core.ts) on the same synthetic rows in
 *   worker : the production bundle (src/prelabel/worker.ts -> dist-hybrid/prelabel-worker.js)
 *   main   : the engine on the main thread, same wiring
 * with the production pins (src/prelabel/config.ts: q4f16 / webgpu / pinned revision / temperature).
 * See README.md for flags, what each number means, and how to read a result.
 */
import { chromium } from 'playwright';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync, createReadStream } from 'node:fs';
import { createRequire } from 'node:module';
import { cpus, loadavg, totalmem, tmpdir, platform, release, arch } from 'node:os';
import { resolve, normalize, sep, extname } from 'node:path';
import { classifyIdle, parsePs, summarize, spread } from './stats.mjs';

const HERE = import.meta.dirname;
const REPO = resolve(HERE, '../..');
const UI = resolve(REPO, 'src/dashboard/ui');
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const flag = (n) => argv.includes(`--${n}`);

if (flag('help')) {
  console.log(readFileSync(resolve(HERE, 'README.md'), 'utf8').split('## Flags')[1]?.split('\n## ')[0] ?? 'see README.md');
  process.exit(0);
}

const RUNS = Number(opt('runs', 5));
const ROWS = Number(opt('rows', 49));
const WARMUP = Number(opt('warmup', 3));
const MODES = opt('modes', 'worker,main').split(',');
const RECREATE = flag('recreate'); // knob: dispose + reload the session before EVERY measured row
const REUSE_BROWSER = flag('reuse-browser'); // knob: keep one Chromium for all runs (default: fresh browser per run)
const HEADED = flag('headed');
const UNSAFE = flag('unsafe-webgpu');
const ALLOW_FALLBACK = flag('allow-fallback-adapter');
const NO_PRIME = flag('no-prime');
const SKIP_BUILD = flag('skip-build');
const PORT = Number(opt('port', 5190)); // keep fixed: the model cache is per-origin
const LABEL = opt('label', 'unlabeled');
const PROFILE = resolve(opt('profile', resolve(HERE, '.build/profile')));
const OUT = resolve(opt('out', resolve(HERE, 'results', `${new Date().toISOString().replace(/[:.]/g, '-')}-${LABEL}.json`)));
const NOTE = opt('note', '');
for (const m of MODES) if (!['worker', 'main'].includes(m)) throw new Error(`bad mode ${m}`);

const sh = (cmd, args, o = {}) => spawnSync(cmd, args, { encoding: 'utf8', ...o });
const log = (...a) => console.log(...a);

// ── machine / idle label ────────────────────────────────────────────────────
function snapshotMachine(when) {
  const ps = sh('ps', ['-Ao', 'pid=,pcpu=,comm=', '-r']);
  const procs = parsePs(ps.stdout ?? '').filter((p) => p.pid !== process.pid).slice(0, 15);
  const top = procs.slice(0, 8);
  const l1 = loadavg()[0];
  const idle = classifyIdle(procs, l1, cpus().length);
  return { when, at: new Date().toISOString(), loadavg: loadavg(), top_cpu_processes: top, ...idle };
}
function machineInfo() {
  const info = { platform: platform(), release: release(), arch: arch(), cpu: cpus()[0]?.model, cores: cpus().length, mem_gb: Math.round(totalmem() / 2 ** 30) };
  if (platform() === 'darwin') {
    info.sw_vers = sh('sw_vers', ['-productVersion']).stdout?.trim();
    const batt = sh('pmset', ['-g', 'batt']).stdout ?? '';
    info.power_source = /AC Power/.test(batt) ? 'ac' : /Battery Power/.test(batt) ? 'battery' : 'unknown';
    info.low_power_mode = /lowpowermode\s+1/.test(sh('pmset', ['-g']).stdout ?? '');
    info.thermal = (sh('pmset', ['-g', 'therm']).stdout ?? '').trim().split('\n').slice(0, 4).join(' | ');
  }
  return info;
}

// ── build (production worker via the repo's own config + the harness page) ────
function build() {
  const run = (label, cmd, args, cwd, env) => {
    log(`build: ${label}`);
    const r = sh(cmd, args, { cwd, env: { ...process.env, ...env } });
    if (r.status !== 0) { console.error(r.stdout, r.stderr); throw new Error(`build step failed: ${label}`); }
  };
  run('production worker (vite.prelabel.config.ts)', 'npx', ['vite', 'build', '--config', 'vite.prelabel.config.ts'], UI);
  run('ort wasm assets', 'bun', ['run', resolve(REPO, 'scripts/copy-ort-web-assets.ts')], REPO);
  run('harness page', 'npx', ['vite', 'build', '--config', resolve(HERE, 'vite.config.mjs')], UI);
}

// ── production pins + label set (fallback list the label-set module uses) ────
function loadPins() {
  // HOME is redirected so nothing under the real ~/.openaccountant can be touched by an import side effect.
  const fakeHome = resolve(tmpdir(), 'openjev-latency-home');
  mkdirSync(fakeHome, { recursive: true });
  const code = `import {PRELABEL_MODEL} from './src/prelabel/config.ts'; import {CATEGORIES} from './src/tools/categorize/categories.ts'; console.log(JSON.stringify({pins:PRELABEL_MODEL,labels:CATEGORIES}))`;
  const r = sh('bun', ['-e', code], { cwd: REPO, env: { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome } });
  if (r.status !== 0) throw new Error(`pin load failed: ${r.stderr}`);
  const { pins, labels } = JSON.parse(r.stdout.trim().split('\n').at(-1));
  const { approxDownloadBytes, ...workerPins } = pins; // PrelabelPins has no approxDownloadBytes (controller's workerPins() drops it too)
  return { pins: workerPins, labels };
}

// ── static server: / -> harness page, /assets/* -> dist-hybrid (same layout the dashboard uses) ──
const MIME = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.html': 'text/html', '.json': 'application/json' };
function serve() {
  const roots = { '/assets/': resolve(UI, 'dist-hybrid') };
  const srv = createServer((req, res) => {
    const url = decodeURIComponent((req.url ?? '/').split('?')[0]);
    let file;
    if (url === '/' || url === '/index.html') file = resolve(HERE, 'index.html');
    else if (url === '/page.js') file = resolve(HERE, '.build/page/page.js');
    else for (const [p, root] of Object.entries(roots)) if (url.startsWith(p)) { const abs = resolve(root, normalize(url.slice(p.length))); if (abs.startsWith(root + sep)) file = abs; }
    if (!file || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    createReadStream(file).pipe(res);
  });
  return new Promise((ok) => srv.listen(PORT, '127.0.0.1', () => ok(srv)));
}

// ── synthetic rows: the spike's gold set (fabricated merchants from the demo personas) ──
const gold = JSON.parse(readFileSync(resolve(REPO, 'docs/spikes/2026-10-02-open-jev-webgpu/harness/gold/categorize.json'), 'utf8'));
const makeItems = (start, n) => Array.from({ length: n }, (_, i) => { const g = gold[(start + i) % gold.length]; return { txnId: start + i, description: g.description, amount: g.amount, date: g.date }; });

// ── one engine instance, measured ───────────────────────────────────────────
async function launch() {
  const args = UNSAFE ? ['--enable-unsafe-webgpu'] : [];
  const ctx = await chromium.launchPersistentContext(PROFILE, { headless: !HEADED, channel: 'chromium', args, viewport: { width: 900, height: 600 } });
  return ctx;
}
const isFallback = (a) => !a.webgpu || a.isFallbackAdapter === true || a.architecture === 'swiftshader' || /swiftshader/i.test(`${a.vendor} ${a.description}`);

async function measureOne(ctx, mode, runIdx, cfg) {
  const page = await ctx.newPage();
  const logs = [];
  page.on('console', (m) => logs.push(`${m.type()}: ${m.text()}`.slice(0, 200)));
  page.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`.slice(0, 200)));
  const rec = { mode, run: runIdx, recreate: RECREATE, warmup: WARMUP };
  try {
    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__ready === true, null, { timeout: 60000 });
    rec.adapter = await page.evaluate(() => window.__jev.adapter());
    rec.versions = await page.evaluate(() => window.__jev.versions());
    if (isFallback(rec.adapter) && !ALLOW_FALLBACK) { rec.status = 'blocked-no-real-webgpu'; return rec; }
    const cap = await page.evaluate((c) => window.__jev.open(c), { mode, ...cfg });
    rec.capability = cap;
    if (cap.verdict !== 'ready') { rec.status = `capability-${cap.verdict}:${cap.reason}`; return rec; }

    // cold load: fresh engine, fresh browser process (unless --reuse-browser), disk caches as left by the profile
    const load = await page.evaluate(() => window.__jev.load());
    if (load.msg.type !== 'loaded') { rec.status = 'load-failed'; rec.load_msg = load.msg; return rec; }
    rec.load = { wall_ms: load.wallMs, load_ms: load.msg.loadMs, first_decision_ms: load.msg.firstDecisionMs, from_cache: load.msg.fromCache, runtime: load.msg.runtime };

    // warm-up rows (discarded) through the real run loop
    if (WARMUP > 0 && !RECREATE) {
      const w = await page.evaluate((items) => window.__jev.run(items), makeItems(1000, WARMUP));
      rec.warmup_rows_ms = w.ok ? w.rows.map((r) => r.ms) : null;
    }
    const items = makeItems(0, ROWS);
    if (!RECREATE) {
      const r = await page.evaluate((it) => window.__jev.run(it), items);
      if (!r.ok) { rec.status = 'run-failed'; rec.error = r.error; return rec; }
      rec.run_wall_ms = r.wallMs;
      rec.engine_done = { n: r.done.n, skipped: r.done.skipped, p50Ms: r.done.p50Ms, p95Ms: r.done.p95Ms, wallMs: r.done.wallMs };
      rec.rows = r.rows.filter((x) => x.ok).map((x) => ({ txnId: x.txnId, ms: x.ms, stateTokens: x.stateTokens, choice: x.choice, margin: x.margin }));
    } else {
      rec.rows = []; rec.recreate_loads = [];
      for (const it of items) {
        const t0 = Date.now();
        const x = await page.evaluate((i) => window.__jev.recreateThenRun(i), it);
        if (x.load.msg.type !== 'loaded' || !x.run.ok) { rec.status = 'recreate-failed'; return rec; }
        rec.recreate_loads.push({ wall_ms: x.load.wallMs, load_ms: x.load.msg.loadMs, first_decision_ms: x.load.msg.firstDecisionMs, iter_wall_ms: Date.now() - t0 });
        const row = x.run.rows.find((y) => y.ok);
        if (row) rec.rows.push({ txnId: row.txnId, ms: row.ms, stateTokens: row.stateTokens, choice: row.choice, margin: row.margin });
      }
    }
    rec.status = 'measured';
    rec.console_tail = logs.slice(-5);
  } catch (e) {
    rec.status = 'error'; rec.error = String(e?.message ?? e).slice(0, 600); rec.console_tail = logs.slice(-8);
  } finally {
    try { await page.evaluate(() => window.__jev?.close()); } catch {}
    await page.close().catch(() => {});
  }
  return rec;
}

const pearson = (xs, ys) => {
  const n = xs.length; if (n < 3) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : null;
};

function summarizeMode(recs) {
  const ok = recs.filter((r) => r.status === 'measured');
  const rows = ok.flatMap((r) => r.rows);
  const perRunP50 = ok.map((r) => summarize(r.rows.map((x) => x.ms)).p50);
  const loads = ok.map((r) => r.load);
  const firstRowMs = ok.map((r) => r.rows[0]?.ms).filter((x) => x != null);
  return {
    runs_measured: ok.length, runs_total: recs.length,
    steady_state_per_row_decide_ms: summarize(rows.map((x) => x.ms)),
    first_measured_row_ms: summarize(firstRowMs),
    per_run_p50_ms: perRunP50,
    per_run_p50_spread: spread(perRunP50),
    per_row_wall_ms: summarize(ok.filter((r) => r.run_wall_ms).map((r) => r.run_wall_ms / r.rows.length)), // decide + countTokens + yield + postMessage
    cold_load_wall_ms: summarize(loads.map((l) => l.wall_ms)),
    cold_load_engine_ms: summarize(loads.map((l) => l.load_ms)), // includes the warm-up decision
    first_decision_ms: summarize(loads.map((l) => l.first_decision_ms)), // shader compile + first dispatch
    recreate_iter_wall_ms: summarize(ok.flatMap((r) => (r.recreate_loads ?? []).map((l) => l.iter_wall_ms))),
    ms_vs_state_tokens_pearson: pearson(rows.map((x) => x.stateTokens), rows.map((x) => x.ms)),
  };
}

// ── main ────────────────────────────────────────────────────────────────────
if (!SKIP_BUILD) build();
if (!existsSync(resolve(UI, 'dist-hybrid/prelabel-worker.js')) || !existsSync(resolve(HERE, '.build/page/page.js'))) throw new Error('build output missing; run without --skip-build');
const { pins, labels } = loadPins();
const cfg = { pins, labels };
mkdirSync(PROFILE, { recursive: true });
mkdirSync(resolve(OUT, '..'), { recursive: true });
const server = await serve();

const result = {
  harness: 'openjev-latency/v1', issue: 155, label: LABEL, note: NOTE, date: new Date().toISOString(),
  config: { runs: RUNS, rows: ROWS, warmup: WARMUP, modes: MODES, recreate: RECREATE, reuse_browser: REUSE_BROWSER, headed: HEADED, unsafe_webgpu: UNSAFE, no_prime: NO_PRIME },
  pins: { repo: pins.repo, revision: pins.revision, dtype: pins.dtype, device: pins.device, temperature: pins.temperature, n_labels: labels.length },
  machine: machineInfo(),
  idle_before: snapshotMachine('before'),
};
log(`machine idle check: ${result.idle_before.verdict}${result.idle_before.reasons.length ? ' (' + result.idle_before.reasons.join('; ') + ')' : ''}${result.idle_before.gpuSuspects.length ? ' gpu-suspects: ' + result.idle_before.gpuSuspects.join(', ') : ''}`);

const recs = [];
let shared = REUSE_BROWSER ? await launch() : null;
try {
  const first = shared ?? (await launch());
  result.browser = first.browser()?.version();
  if (!shared) await first.close();
  if (!NO_PRIME) {
    // Prime: populate the model cache (first-ever run downloads ~350 MB). Not counted.
    log('prime: loading once so the weights are cached (not measured)');
    const ctx = shared ?? (await launch());
    const p = await measureOne(ctx, 'worker', -1, cfg);
    result.prime = { status: p.status, adapter: p.adapter, load: p.load };
    if (!shared) await ctx.close();
    if (p.status === 'blocked-no-real-webgpu' || String(p.status).startsWith('capability-') || p.status === 'load-failed') {
      result.status = p.status; result.adapter = p.adapter;
      throw new Error(`cannot measure: ${p.status} adapter=${JSON.stringify(p.adapter)}`);
    }
  }
  for (let i = 0; i < RUNS; i++) {
    const order = i % 2 === 0 ? MODES : [...MODES].reverse(); // alternate order so drift does not favour one host
    for (const mode of order) {
      const ctx = shared ?? (await launch());
      const rec = await measureOne(ctx, mode, i, cfg);
      if (!shared) await ctx.close();
      recs.push(rec);
      const s = rec.status === 'measured' ? summarize(rec.rows.map((x) => x.ms)) : null;
      log(`run ${i + 1}/${RUNS} ${mode.padEnd(6)} ${rec.status}` + (s ? `  load ${Math.round(rec.load.wall_ms)}ms first-decision ${Math.round(rec.load.first_decision_ms)}ms  per-row p50 ${s.p50.toFixed(1)} p90 ${s.p90.toFixed(1)} min ${s.min.toFixed(1)} max ${s.max.toFixed(1)}` : ` ${rec.error ?? ''}`));
    }
  }
  result.status = recs.some((r) => r.status === 'measured') ? 'measured' : 'no-measurements';
} catch (e) {
  result.error = String(e?.message ?? e);
  result.status ??= 'error';
  log('ERROR', result.error);
} finally {
  if (shared) await shared.close().catch(() => {});
  server.close();
}
result.idle_after = snapshotMachine('after');
result.adapter = result.adapter ?? recs.find((r) => r.adapter)?.adapter ?? null;
result.runs = recs;
result.summary = Object.fromEntries(MODES.map((m) => [m, summarizeMode(recs.filter((r) => r.mode === m))]));
const w = result.summary.worker?.steady_state_per_row_decide_ms?.p50, mn = result.summary.main?.steady_state_per_row_decide_ms?.p50;
if (w && mn) result.worker_vs_main_p50_ratio = w / mn;
result.verdict_hint = (result.idle_before.verdict !== 'idle' || result.idle_after.verdict === 'busy') ? 'NOT OF RECORD: machine was not idle' : 'machine idle before and not busy after';
writeFileSync(OUT, JSON.stringify(result, null, 1));

log('\n=== summary (ms; per-row = decide time inside the engine) ===');
for (const m of MODES) {
  const s = result.summary[m]; const p = s.steady_state_per_row_decide_ms;
  log(`${m.padEnd(6)} n=${p.n} p50 ${p.p50?.toFixed(1)} p90 ${p.p90?.toFixed(1)} min ${p.min?.toFixed(1)} max ${p.max?.toFixed(1)} | run-p50 spread ${s.per_run_p50_spread.min?.toFixed(1)}..${s.per_run_p50_spread.max?.toFixed(1)} (x${s.per_run_p50_spread.ratio?.toFixed(2)}) | load p50 ${s.cold_load_wall_ms.p50?.toFixed(0)} first-decision p50 ${s.first_decision_ms.p50?.toFixed(0)}`);
}
if (result.worker_vs_main_p50_ratio) log(`worker/main p50 ratio: ${result.worker_vs_main_p50_ratio.toFixed(2)}`);
log(`adapter: ${JSON.stringify(result.adapter && { vendor: result.adapter.vendor, arch: result.adapter.architecture, fallback: result.adapter.isFallbackAdapter, f16: result.adapter.shaderF16 })}`);
log(`idle before: ${result.idle_before.verdict}; after: ${result.idle_after.verdict}; ${result.verdict_hint}`);
log(`wrote ${OUT}`);
process.exit(result.status === 'measured' ? 0 : 1);
