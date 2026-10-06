#!/usr/bin/env node
/**
 * Round 4 §5 report + freeze (specs/browser-subagent-round4-openjev-router.md): reads the
 * arm-O DEV run(s) of scripts/subagent-route-eval.mjs (--arm O --sets dev), applies the
 * pre-registered selection in scripts/subagent-openjev-cut.mjs, and writes
 *   <out-dir>/<date>-round4-dev-cut.{json,md}
 *   <out-dir>/round4-openjev-frozen.json   (only with --freeze)
 *
 *   node scripts/subagent-openjev-dev-report.mjs --results <descriptions run results.json>
 *        [--results-bare <bare-label run results.json>] [--cold-results <fresh-profile run results.json>]
 *        --date 2026-10-03 [--out-dir specs/eval] [--freeze]
 *   --cold-results: a run whose Chromium profile started empty, for the true cold-load (download) cost.
 *
 * The bare-label run is the §3 fallback: it is consulted ONLY when the descriptions run has no
 * viable cut, and only once. Reads DEV files only; the current held-out set is never opened.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CUT_GRID,
  MIN_PRECISION,
  MIN_SELECTED,
  READ_LABELS,
  coverageGain,
  isReadLabel,
  marginHistogram,
  pct,
  selectCut,
  sha256Hex,
  wilsonLower,
} from './subagent-openjev-cut.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const OUT_DIR = resolve(arg('out-dir', join(ROOT, 'specs/eval')));
const DATE = arg('date', new Date().toISOString().slice(0, 10));
const FREEZE = argv.includes('--freeze');

const DEV_FILES = [
  ['v1-burned', 'specs/eval/heldout-router.v1-burned.jsonl'],
  ['v2', 'specs/eval/heldout-router.v2.jsonl'],
  ['v3', 'specs/eval/heldout-router.v3.jsonl'],
  ['spike-route', 'src/__tests__/fixtures/subagent-route-gold.json'],
];

function load(path) {
  const r = JSON.parse(readFileSync(resolve(path), 'utf8'));
  const set = r.sets?.dev;
  if (!set) throw new Error(`${path}: no "dev" set (run the harness with --arm O --sets dev)`);
  if (r.meta?.arm !== 'O') throw new Error(`${path}: not an arm-O run`);
  return { meta: r.meta, records: set.records, stages: r.stages };
}

const labelOf = (r) => (r.mutation ? 'mutation' : r.expect);

function analyse(run) {
  const all = run.records;
  const A = all.filter((r) => r.oj && !r.oj.error).map((r) => ({
    q: r.q,
    label: labelOf(r),
    source: r.source,
    hits: r.hits,
    top1: r.oj.top1,
    p1: r.oj.p1,
    p2: r.oj.p2,
    margin: r.oj.margin,
    top2: r.oj.top2,
    ms: r.oj.ms,
  }));
  const ojErrors = all.filter((r) => r.oj?.error).map((r) => ({ q: r.q, error: r.oj.error }));
  const sel = selectCut(A);
  const readRows = all.filter((r) => isReadLabel(labelOf(r)));
  const byTool = Object.fromEntries(READ_LABELS.map((t) => [t, readRows.filter((r) => r.expect === t).length]));
  const sources = [...new Set(all.map((r) => r.source))];
  const bySource = Object.fromEntries(sources.map((s) => [s, readRows.filter((r) => r.source === s).length]));
  const denominators = { total: readRows.length, byTool, bySource };
  const gain = coverageGain(A, sel.cut, denominators);
  const correct = A.filter((r) => isReadLabel(r.label) && r.top1 === r.label);
  const wrong = A.filter((r) => isReadLabel(r.label) && r.top1 !== r.label);
  const noneRows = A.filter((r) => !isReadLabel(r.label));
  return {
    rows: all.length,
    readRows: readRows.length,
    bySourceRows: Object.fromEntries(sources.map((s) => [s, all.filter((r) => r.source === s).length])),
    A: A.length,
    Abreakdown: {
      zeroHit: A.filter((r) => r.hits.length === 0).length,
      multiHit: A.filter((r) => r.hits.length >= 2).length,
      read: A.length - noneRows.length,
      noneOrMutation: noneRows.length,
      inconsistentMultiHit: A.filter((r) => r.hits.length >= 2 && !r.hits.includes(r.top1)).length,
    },
    ojErrors,
    cut: sel.cut,
    reason: sel.reason,
    chosen: sel.chosen ? { ...sel.chosen, wilsonLower95: wilsonLower(sel.chosen.correct, sel.chosen.n) } : null,
    curve: sel.curve,
    coverageGain: gain,
    histograms: { correct: marginHistogram(correct), wrong: marginHistogram(wrong), noneOrMutation: marginHistogram(noneRows) },
    decideMs: { n: A.length, p50: pct(A.map((r) => r.ms), 50), p95: pct(A.map((r) => r.ms), 95), max: A.length ? Math.max(...A.map((r) => r.ms)) : null },
    records: A,
  };
}

const descRun = load(arg('results'));
const desc = analyse(descRun);
let bare = null;
let bareRun = null;
let final = { mode: 'descriptions', run: descRun, analysis: desc };
if (desc.cut === null) {
  const barePath = arg('results-bare', null);
  if (barePath) {
    bareRun = load(barePath);
    if (bareRun.meta.optionMode !== 'bare') throw new Error(`${barePath}: not a --option-mode bare run`);
    bare = analyse(bareRun);
    if (bare.cut !== null) final = { mode: 'bare', run: bareRun, analysis: bare };
  }
}
const frozenCut = final.analysis.cut;
const meta = final.run.meta;

const devFiles = DEV_FILES.map(([name, rel]) => ({ name, path: rel, sha256: sha256Hex(readFileSync(join(ROOT, rel))) }));
const report = {
  date: DATE,
  spec: 'specs/browser-subagent-round4-openjev-router.md §5',
  procedure: { grid: CUT_GRID, minPrecision: MIN_PRECISION, minSelected: MIN_SELECTED, leak: 0, stability: 'P >= minPrecision and no leak at every higher grid cut (an empty S(c) passes)' },
  devFiles,
  run: {
    adapter: meta.adapter,
    browserVersion: meta.browserVersion,
    now: meta.now,
    openJevPins: meta.openJevPins,
    openJevVersions: meta.openJevVersions,
    openJevColdLoad: meta.openJevColdLoad,
    openJevWarmLoad: meta.openJevWarmLoad,
    openJevMeta: meta.openJevMeta,
  },
  descriptions: desc,
  bare: bare ?? (desc.cut === null ? 'not run' : 'not needed (descriptions yielded a viable cut)'),
  frozen: { cut: frozenCut, optionMode: frozenCut === null ? null : final.mode },
};
const base = join(OUT_DIR, `${DATE}-round4-dev-cut`);
writeFileSync(`${base}.json`, JSON.stringify(report, null, 1) + '\n');

// ── markdown ──
const f3 = (x) => (x === null || x === undefined ? 'n/a' : Number(x).toFixed(3));
const pctS = (x) => (x === null || x === undefined ? 'n/a' : `${(100 * x).toFixed(1)}%`);
const a = desc;
const lines = [];
/** Which §5 rules a grid cut breaks ('' = it qualifies). */
const okPoint = (p) => p.leak === 0 && (p.n === 0 || p.precision >= MIN_PRECISION);
function fails(curve, i) {
  const p = curve[i];
  const why = [];
  if (p.precision !== null && p.precision < MIN_PRECISION) why.push(`P < ${MIN_PRECISION}`);
  if (p.leak > 0) why.push('leak');
  if (p.n < MIN_SELECTED) why.push(`size < ${MIN_SELECTED}`);
  if (okPoint(p) && !curve.slice(i).every(okPoint)) why.push('unstable above');
  return why.join(', ') || 'qualifies';
}
lines.push(`# Round 4 dev cut: open-jev route tiebreak (${DATE})`);
lines.push('');
lines.push(`Pre-registered procedure: \`specs/browser-subagent-round4-openjev-router.md\` §5, implemented in \`scripts/subagent-openjev-cut.mjs\` (test-first). Dev data only: ${devFiles.map((d) => `\`${d.path}\``).join(', ')}. The current held-out set (\`heldout-router.v4.jsonl\`) was not opened.`);
lines.push('');
lines.push('## Result');
lines.push('');
if (frozenCut === null) {
  lines.push(`- **No viable cut on dev** with tool name + description options${bare ? ', and none with the bare-label fallback (run once, §3)' : ''}: no grid cut has P(c) >= ${MIN_PRECISION}, no leak, |S(c)| >= ${MIN_SELECTED} and an error-free curve above it (the "fails" column below says which rule each cut breaks). \`OPEN_JEV_ROUTE_CUT\` stays \`null\`: **arm O is disabled** and the v4 arm-O run is skipped (§5 step 6).`);
} else {
  const c = final.analysis.chosen;
  lines.push(`- **Cut c = ${frozenCut}** (${final.mode === 'descriptions' ? 'tool name + catalog description options' : 'bare tool-name options (§3 fallback)'}).`);
  lines.push(`- At c: |S(c)| = ${c.n}, tool precision P(c) = ${c.correct}/${c.n} = ${pctS(c.precision)} (Wilson 95% lower bound ${pctS(c.wilsonLower95)}, informational), leak L(c) = ${c.leak}.`);
  const g = final.analysis.coverageGain;
  lines.push(`- Dev coverage gain: ${g.rows} read rows newly routed correctly / ${final.analysis.readRows} dev read rows = **${pctS(g.share)}** (routing only; answers are judged on the held-out set).`);
}
lines.push('');
lines.push('## Population A');
lines.push('');
lines.push(`- Dev rows (deduplicated by normalized question, first label wins in the order v1-burned, v2, v3, spike route set): ${a.rows} (${Object.entries(a.bySourceRows).map(([k, v]) => `${k} ${v}`).join(', ')}); read rows ${a.readRows}.`);
lines.push(`- A = rows that pass the round-4 gate and the what-if / comparison / trend rule with 0 or 2+ keyword hits: **${a.A}** (0-hit ${a.Abreakdown.zeroHit}, multi-hit ${a.Abreakdown.multiHit}; read ${a.Abreakdown.read}, none or mutation ${a.Abreakdown.noneOrMutation}; multi-hit with top1 outside the hits ${a.Abreakdown.inconsistentMultiHit}).`);
lines.push(`- open-jev decision errors: ${a.ojErrors.length}.`);
lines.push('');
lines.push(`## Curve (${frozenCut !== null && final.mode === 'bare' ? 'descriptions run; bare run in the JSON' : 'descriptions'})`);
lines.push('');
lines.push('| c | S(c) size | correct | wrong | leak | P(c) | fails |');
lines.push('|---|---|---|---|---|---|---|');
for (const [i, p] of a.curve.entries()) lines.push(`| ${p.cut.toFixed(2)} | ${p.n} | ${p.correct} | ${p.wrong} | ${p.leak} | ${pctS(p.precision)} | ${fails(a.curve, i)} |`);
lines.push('');
if (bare) {
  lines.push('## Bare-label fallback curve (§3, run once)');
  lines.push('');
  lines.push('| c | S(c) size | correct | wrong | leak | P(c) | fails |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const [i, p] of bare.curve.entries()) lines.push(`| ${p.cut.toFixed(2)} | ${p.n} | ${p.correct} | ${p.wrong} | ${p.leak} | ${pctS(p.precision)} | ${fails(bare.curve, i)} |`);
  lines.push('');
}
lines.push('## Coverage gain per tool and per source (at the frozen cut)');
lines.push('');
const g = final.analysis.coverageGain;
lines.push('| Tool | gained / dev read rows |');
lines.push('|---|---|');
for (const [t, v] of Object.entries(g.byTool)) lines.push(`| ${t} | ${v.gained} / ${v.of} |`);
lines.push('');
lines.push('| Source | gained / dev read rows |');
lines.push('|---|---|');
for (const [s, v] of Object.entries(g.bySource)) lines.push(`| ${s} | ${v.gained} / ${v.of} |`);
lines.push('');
lines.push('## Margin histograms (descriptions run, A only, 0.05 bins)');
lines.push('');
lines.push('| bin | correct read | wrong read | none / mutation |');
lines.push('|---|---|---|---|');
for (const bin of Object.keys(a.histograms.correct)) lines.push(`| ${bin} | ${a.histograms.correct[bin]} | ${a.histograms.wrong[bin]} | ${a.histograms.noneOrMutation[bin]} |`);
lines.push('');
lines.push('## Timing and load (real WebGPU)');
lines.push('');
const ad = meta.adapter ?? {};
lines.push(`- Adapter: vendor \`${ad.vendor}\`, architecture \`${ad.architecture}\`, fallback ${ad.isFallbackAdapter}, shader-f16 ${ad.shaderF16}; Chromium ${meta.browserVersion}.`);
lines.push(`- Decide per row (A, warm, descriptions): p50 ${f3(a.decideMs.p50)} ms, p95 ${f3(a.decideMs.p95)} ms, max ${f3(a.decideMs.max)} ms.${bare ? ` Bare labels: p50 ${f3(bare.decideMs.p50)} ms, p95 ${f3(bare.decideMs.p95)} ms.` : ''}`);
const coldPath = arg('cold-results', null);
const cold = coldPath ? JSON.parse(readFileSync(resolve(coldPath), 'utf8')).meta?.openJevColdLoad : null;
if (cold) {
  report.run.freshProfileColdLoad = cold;
  writeFileSync(`${base}.json`, JSON.stringify(report, null, 1) + '\n');
  lines.push(`- Cold load in a fresh Chromium profile (download + session): ${Math.round(cold.loadMs)} ms, ${cold.progressTotal} bytes reported by the download progress; first decision ${Math.round(cold.firstDecisionMs)} ms.`);
}
lines.push(`- This run: first load in the browser process (weights already in the Cache API) ${Math.round(meta.openJevColdLoad?.loadMs ?? 0)} ms; warm-cache load in a new worker ${Math.round(meta.openJevWarmLoad?.loadMs ?? 0)} ms; first decision after load ${Math.round(meta.openJevWarmLoad?.firstDecisionMs ?? 0)} ms.`);
lines.push(`- Tokens: question ${meta.openJevMeta?.questionTokens}, options ${JSON.stringify(meta.openJevMeta?.optionTokens)} (engine limit 200).`);
lines.push('');
lines.push('## Notes');
lines.push('');
lines.push('- Tool precision is a proxy: arm O answers with the round-3 templates, so answer quality is judged on the held-out set (§7), not here.');
lines.push('- Expect small n; the stability rule and |S| >= 20 guard against a lucky dip.');
lines.push(`- Per-row A records (question, label, source, hits, top1, p1, p2, margin, top-2, ms): \`${DATE}-round4-dev-cut.json\`.`);
writeFileSync(`${base}.md`, lines.join('\n') + '\n');
console.log('wrote', `${base}.json`, `${base}.md`);

if (FREEZE) {
  const pins = meta.openJevPins;
  // The option strings and question come from the product source (one definition), read with bun.
  const src = JSON.parse(
    execFileSync('bun', ['-e', "import * as r from './src/dashboard/ui/src/hybrid/openjev-route.ts'; console.log(JSON.stringify({ OPTIONS: r.OPEN_JEV_ROUTE_OPTIONS, QUESTION: r.OPEN_JEV_ROUTE_QUESTION }));"], { cwd: ROOT, encoding: 'utf8' }).trim().split('\n').pop(),
  );
  const { OPTIONS, QUESTION } = src;
  const frozen = {
    v: 1,
    spec: 'specs/browser-subagent-round4-openjev-router.md §5',
    frozenOn: DATE,
    cut: frozenCut,
    optionMode: frozenCut === null ? null : final.mode,
    question: meta.openJevMeta?.question,
    options: OPTIONS ?? null,
    consistencyRule: 'multi-hit: top1 must be one of the keyword hits (DECISIONS Round 4)',
    chatTimeoutMs: 400,
    pins: { repo: pins.repo, revision: pins.revision, configSha: pins.configSha, temperature: pins.temperature, dtype: pins.dtype, device: pins.device },
    devFiles,
    devRun: { adapter: meta.adapter, browserVersion: meta.browserVersion, startedAt: meta.startedAt, A: final.analysis.A, chosen: final.analysis.chosen },
    report: `specs/eval/${DATE}-round4-dev-cut.md`,
  };
  if (QUESTION && QUESTION !== frozen.question) throw new Error('question mismatch between the run and the source');
  writeFileSync(join(OUT_DIR, 'round4-openjev-frozen.json'), JSON.stringify(frozen, null, 1) + '\n');
  console.log('wrote', join(OUT_DIR, 'round4-openjev-frozen.json'), 'cut', frozenCut);
}
