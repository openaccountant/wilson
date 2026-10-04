#!/usr/bin/env node
/**
 * Round-4 report builder (no product code).
 *   node scripts/subagent-route-round4-report.mjs --out-dir specs/eval --key-out <path outside the repo>
 *        --arm T=<results.json> [--arm O=<results.json> | --arm O=skipped:<reason>] [--repeat T=<results.json>]
 *        [--load <results.json of an arm-O load run>] [--coresident <results.json>]
 * Writes 2026-10-03-round4-blind.jsonl (opaque ids, shuffled, no arm), the id -> arm key to --key-out ONLY (never into
 * --out-dir), and 2026-10-03-round4-results.json (per-row records WITHOUT answer text, bars 1/4/5, determinism).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { blindLines, buildBlind } from './subagent-route-round3.mjs';
import { armBarsR4, coverageDelta, stripAnswerText } from './subagent-route-round4.mjs';

const argv = process.argv.slice(2);
const all = (n) => argv.flatMap((a, i) => (a === `--${n}` ? [argv[i + 1]] : []));
const one = (n) => all(n)[0];
const outDir = resolve(one('out-dir'));
const keyOut = resolve(one('key-out'));
if (keyOut.startsWith(outDir + '/') || keyOut.startsWith(resolve('.') + '/')) throw new Error('--key-out must be outside the repo');
const PREFIX = '2026-10-03-round4';
const load = (p) => JSON.parse(readFileSync(p, 'utf8'));

const arms = {};
const skipped = {};
const runMeta = {};
for (const spec of all('arm')) {
  const eq = spec.indexOf('=');
  const name = spec.slice(0, eq);
  const src = spec.slice(eq + 1);
  if (src.startsWith('skipped:')) { skipped[name] = src.slice('skipped:'.length); continue; }
  const run = load(src);
  arms[name] = run.sets.heldout.records;
  runMeta[name] = { ...run.meta, stages: run.stages };
}
const determinism = {};
for (const spec of all('repeat')) {
  const eq = spec.indexOf('=');
  const name = spec.slice(0, eq);
  const b = load(spec.slice(eq + 1)).sets.heldout.records;
  const a = arms[name];
  const fields = ['gate', 'route', 'via', 'outcome', 'reason', 'text', 'hits'];
  const diffs = a.map((r, i) => (fields.some((f) => JSON.stringify(r[f]) !== JSON.stringify(b[i]?.[f])) ? i : -1)).filter((i) => i >= 0);
  determinism[name] = { rows: a.length, rowsRepeat: b.length, differences: diffs.length, differingRows: diffs };
}

const { blind, key } = buildBlind(arms);
writeFileSync(join(outDir, `${PREFIX}-blind.jsonl`), blindLines(blind));
writeFileSync(keyOut, JSON.stringify({ note: 'id -> arm. The grader must not open this file before grading.', arms: Object.keys(arms), skipped, key }, null, 1));

const clip = (v, n) => { const s = typeof v === 'string' ? v : JSON.stringify(v); return s == null ? undefined : s.length > n ? s.slice(0, n) + '...' : s; };
const out = { arms: {}, skipped, determinism, coverageDeltaOvsT: coverageDelta(arms.T, arms.O ?? null) };
for (const [name, recs] of Object.entries(arms)) {
  const { base, ...bars } = armBarsR4(recs);
  out.arms[name] = {
    meta: runMeta[name],
    bars: { ...bars, base: { none: base.none, read: base.read, c4: base.c4, confusion: base.confusion } },
    rows: stripAnswerText(recs.map((r, i) => {
      const t = (r.tools ?? [])[0];
      return {
        i, q: r.q, persona: r.persona, expect: r.expect, mutation: r.mutation || undefined, denylist: r.denylist,
        gate: r.gate, hits: r.hits, shape: r.shape, route: r.route, tool: t?.tool ?? null, args: t?.args ?? null,
        toolResultSummary: clip(t?.result, 400), outcome: r.outcome, reason: r.reason ?? undefined,
        ms: r.ms, workerMs: r.workerMs, gateMs: r.gateMs, text: r.text,
      };
    })),
  };
}
if (one('load')) { const m = load(one('load')).meta; out.openJevLoad = { adapter: m.adapter, browserVersion: m.browserVersion, pins: m.openJevPins, versions: m.openJevVersions, cold: m.openJevColdLoad, warm: m.openJevWarmLoad, tokens: m.openJevMeta }; }
if (one('coresident')) { const m = load(one('coresident')).meta; out.coresidence = { qwen: { model: m.model, dtype: m.dtype, firstLoad: m.firstLoad, warmReload: m.warmReload }, openJevCold: m.openJevColdLoad, openJevWarm: m.openJevWarmLoad, ...m.coresidence }; }
writeFileSync(join(outDir, `${PREFIX}-results.json`), JSON.stringify(out, null, 1));
console.log(JSON.stringify({ blindLines: blind.length, perArm: Object.fromEntries(Object.keys(arms).map((a) => [a, Object.values(key).filter((k) => k.arm === a).length])), skipped, determinism, coverageDeltaOvsT: out.coverageDeltaOvsT }, null, 1));
