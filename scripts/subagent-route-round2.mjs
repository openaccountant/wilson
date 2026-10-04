/**
 * Round-2 measurement tooling (no product code): turns run records plus per-row grades into the
 * numbers the go/no-go report states (DECISIONS "Round 2"). Pure; pinned by
 * src/__tests__/subagent-route-round2-report.test.ts.
 */
import { LABELS, percentile, scoreRound2, verdictRound2 } from './subagent-route-score.mjs';
import { applyGrades } from './subagent-route-grade.mjs';

const pct = (n, d) => (d === 0 ? null : (100 * n) / d);
const stat = (xs) => ({ n: xs.length, p50: percentile(xs, 50), p95: percentile(xs, 95), max: xs.length ? Math.max(...xs) : null });
const diverted = (r) => r.gate !== 'route' || r.route === 'none' || r.route === null;

export function buildRound2Report(records, grades) {
  const graded = applyGrades(records, grades);
  const score = scoreRound2(graded);
  const verdict = verdictRound2(score);

  const perTool = {};
  for (const label of LABELS) {
    const rows = graded.filter((r) => r.expect === label);
    const answered = rows.filter((r) => r.outcome === 'answer');
    const good = answered.filter((r) => r.expect !== 'none' && r.route === r.expect && r.answerOk === true && r.useless !== true);
    const handoffReasons = {};
    for (const r of rows) if (r.outcome === 'handoff') handoffReasons[r.reason] = (handoffReasons[r.reason] ?? 0) + 1;
    perTool[label] = {
      n: rows.length,
      gated: rows.filter((r) => r.gate !== 'route').length,
      routerNone: rows.filter((r) => r.gate === 'route' && (r.route === 'none' || r.route === null)).length,
      routedRight: rows.filter((r) => r.gate === 'route' && r.route === label).length,
      routedWrong: rows.filter((r) => r.gate === 'route' && r.route !== label && r.route !== 'none' && r.route !== null).length,
      answered: answered.length,
      good: good.length,
      wrongOrUseless: answered.length - good.length,
      precisionPct: pct(good.length, answered.length),
      coveragePct: label === 'none' ? null : pct(answered.length, rows.length),
      handoffReasons,
    };
  }

  const none = graded.filter((r) => r.expect === 'none');
  const mutation = none.filter((r) => r.mutation);
  const verbless = mutation.filter((r) => r.denylist === false);
  const noneReport = {
    n: none.length,
    divertedByScorer: none.filter(diverted).length,
    notAnsweredLocally: none.filter((r) => r.outcome !== 'answer').length,
    reachedReadTool: none.filter((r) => !diverted(r)).map((r) => r.q),
    mutationRows: mutation.length,
    mutationDiverted: mutation.filter(diverted).length,
    verblessMutationRows: verbless.length,
    verblessDiverted: verbless.filter(diverted).length,
  };

  const handoffs = graded.filter((r) => r.outcome === 'handoff' && typeof r.ms === 'number');
  const timing = {
    barPaths: score.base.c15,
    allHandoffs: stat(handoffs.map((r) => r.ms)),
  };

  const answered = graded.filter((r) => r.outcome === 'answer');
  const lenientGood = answered.filter((r) => r.expect !== 'none' && r.route === r.expect && r.answerOk === true).length;
  const sensitivity = {
    strict: { good: score.local.good, precisionPct: score.local.precisionPct },
    lenientAnswerOkOnly: { good: lenientGood, precisionPct: pct(lenientGood, answered.length) },
  };

  return { score, verdict, perTool, none: noneReport, timing, sensitivity, records: graded };
}
