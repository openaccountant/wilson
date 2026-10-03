#!/usr/bin/env node
/**
 * Round-2 report builder (no product code).
 *   node scripts/subagent-route-round2-report.mjs <run results.json> <grades.json> <out.json> [--set heldout]
 * Reads the harness output, merges the per-row grades, writes the report JSON (per-row verdict + reason,
 * bars, per-tool breakdown). The prose report is written by hand from this file.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { ROUND2_BARS } from './subagent-route-score.mjs';
import { buildRound2Report } from './subagent-route-round2.mjs';

const [runFile, gradesFile, outFile] = process.argv.slice(2);
const set = process.argv.includes('--set') ? process.argv[process.argv.indexOf('--set') + 1] : 'heldout';
const run = JSON.parse(readFileSync(runFile, 'utf8'));
const grades = JSON.parse(readFileSync(gradesFile, 'utf8'));
const records = run.sets[set].records;
const rep = buildRound2Report(records, grades);

const rows = rep.records.map((r) => {
  const t = (r.tools ?? [])[0];
  const out = {
    q: r.q,
    persona: r.persona,
    expect: r.expect,
    mutation: r.mutation || undefined,
    denylist: r.denylist,
    gate: r.gate,
    hits: r.hits,
    route: r.route,
    outcome: r.outcome,
    reason: r.reason,
    toolArgs: t?.args,
    toolSummary: t?.result?.summary ? String(t.result.summary).slice(0, 600) : t?.result && typeof t.result === 'string' ? t.result.slice(0, 600) : undefined,
    searchRows: r.rows,
    ms: r.ms,
    answerText: r.text ?? undefined,
  };
  if (r.outcome === 'answer') {
    out.grade = { toolCorrect: r.route === r.expect, answerOk: r.answerOk, useless: r.useless, good: r.expect !== 'none' && r.route === r.expect && r.answerOk === true && r.useless !== true, why: r.gradeWhy };
  }
  return out;
});

const out = {
  generatedFrom: { run: runFile, grades: gradesFile, set },
  meta: run.meta,
  bars: ROUND2_BARS,
  score: { ...rep.score, base: { ...rep.score.base, confusion: rep.score.base.confusion } },
  verdict: rep.verdict,
  perTool: rep.perTool,
  none: rep.none,
  timing: rep.timing,
  sensitivity: rep.sensitivity,
  stages: run.stages,
  rows,
};
writeFileSync(outFile, JSON.stringify(out, null, 1));
console.log(JSON.stringify({ verdict: rep.verdict, local: rep.score.local, coverage: rep.score.coverage, none: rep.none, timing: rep.timing, sensitivity: rep.sensitivity }, null, 1));
