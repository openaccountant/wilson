#!/usr/bin/env node
/**
 * Round-3 report builder (no product code).
 *   node scripts/subagent-route-round3-report.mjs --out-dir specs/eval --arm T=<results.json> --arm M6=<results.json> [--arm M17=unavailable:<reason>]
 * Writes 2026-10-03-round3-blind.jsonl (opaque ids, no arm), 2026-10-03-round3-key.json (id -> arm),
 * 2026-10-03-round3-results.json (per row per arm records + bars 1, 4, 5). An arm given as
 * `unavailable:<reason>` is recorded as not measured and contributes no rows.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { armBars, blindLines, buildBlind } from './subagent-route-round3.mjs';

const argv = process.argv.slice(2);
const all = (n) => argv.flatMap((a, i) => (a === `--${n}` ? [argv[i + 1]] : []));
const outDir = argv[argv.indexOf('--out-dir') + 1];
const PREFIX = '2026-10-03-round3';

const arms = {};
const unavailable = {};
const runMeta = {};
for (const spec of all('arm')) {
  const eq = spec.indexOf('=');
  const name = spec.slice(0, eq);
  const src = spec.slice(eq + 1);
  if (src.startsWith('unavailable:')) { unavailable[name] = src.slice('unavailable:'.length); continue; }
  const run = JSON.parse(readFileSync(src, 'utf8'));
  arms[name] = run.sets.heldout.records;
  runMeta[name] = { ...run.meta, stages: run.stages };
}

const { blind, key } = buildBlind(arms);
writeFileSync(join(outDir, `${PREFIX}-blind.jsonl`), blindLines(blind));
writeFileSync(join(outDir, `${PREFIX}-key.json`), JSON.stringify({ note: 'id -> arm. Graders must not open this file before grading.', arms: Object.keys(arms), unavailable, key }, null, 1));

const clip = (v, n) => { const s = typeof v === 'string' ? v : JSON.stringify(v); return s == null ? undefined : s.length > n ? s.slice(0, n) + '...' : s; };
const out = { arms: {}, unavailable };
for (const [name, recs] of Object.entries(arms)) {
  out.arms[name] = {
    meta: runMeta[name],
    bars: (({ base, ...b }) => ({ ...b, base: { none: base.none, read: base.read, c4: base.c4, confusion: base.confusion } }))(armBars(recs)),
    rows: recs.map((r, i) => {
      const t = (r.tools ?? [])[0];
      return {
        i, q: r.q, persona: r.persona, expect: r.expect, mutation: r.mutation || undefined, denylist: r.denylist,
        gate: r.gate, hits: r.hits, route: r.route, tool: t?.tool ?? null, args: t?.args ?? null,
        toolResultSummary: clip(t?.result, 400), outcome: r.outcome, reason: r.reason ?? undefined, answer: r.text ?? undefined,
        ms: r.ms, workerMs: r.workerMs, gateMs: r.gateMs, gens: r.gens,
      };
    }),
  };
}
writeFileSync(join(outDir, `${PREFIX}-results.json`), JSON.stringify(out, null, 1));
console.log(JSON.stringify({ blindLines: blind.length, perArm: Object.fromEntries(Object.keys(arms).map((a) => [a, Object.values(key).filter((k) => k.arm === a).length])), unavailable }, null, 1));
