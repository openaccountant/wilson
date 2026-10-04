import { describe, expect, test } from 'bun:test';
import { buildRound2Report } from '../../scripts/subagent-route-round2.mjs';

/** Round-2 measurement tooling (no product code): turns graded run records into the report numbers. */
const rec = (o: { q: string; expect: string } & Record<string, unknown>) => ({
  hits: [], route: null, via: null, outcome: 'handoff', reason: null, gate: 'route', mutation: false, ...o,
});

const records = [
  // read rows
  rec({ q: 'r1', expect: 'spending_summary', route: 'spending_summary', outcome: 'answer', ms: 400 }),
  rec({ q: 'r2', expect: 'spending_summary', route: 'spending_summary', outcome: 'answer', ms: 400 }),
  rec({ q: 'r3', expect: 'spending_summary', gate: 'non-data', ms: 0 }),
  rec({ q: 'r4', expect: 'forecast', route: 'none', reason: 'router-none', ms: 1 }),
  rec({ q: 'r5', expect: 'transaction_search', route: 'transaction_search', reason: 'empty-result', ms: 3 }),
  rec({ q: 'r6', expect: 'profit_loss', route: 'net_worth', reason: 'ungrounded', ms: 200 }),
  // none rows
  rec({ q: 'n1', expect: 'none', gate: 'mutation-intent', mutation: true, denylist: true, ms: 0 }),
  rec({ q: 'n2', expect: 'none', gate: 'non-data', mutation: true, denylist: false, ms: 0 }),
  rec({ q: 'n3', expect: 'none', gate: 'route', route: 'none', reason: 'router-none', ms: 1 }),
  rec({ q: 'n4', expect: 'none', route: 'transaction_search', reason: 'empty-result', ms: 3 }),
];
const grades = {
  r1: { answerOk: true, why: 'matches the tool figure' },
  r2: { answerOk: true, useless: true, why: 'bare number, no period' },
};

describe('buildRound2Report', () => {
  const rep = buildRound2Report(records, grades);

  test('applies grades and computes the Round-2 numbers', () => {
    expect(rep.score.local).toMatchObject({ answered: 2, good: 1, wrongOrUseless: 1, precisionPct: 50, wrongOrUselessPct: 50 });
    expect(rep.score.coverage).toMatchObject({ readRows: 6, answeredLocally: 2 });
    expect(rep.verdict.allPass).toBe(false);
    expect(rep.verdict.bars.precisionGe97).toBe(false);
  });

  test('per-tool breakdown groups by expected label', () => {
    const ss = rep.perTool.spending_summary;
    expect(ss).toMatchObject({ n: 3, gated: 1, answered: 2, good: 1, wrongOrUseless: 1, coveragePct: (100 * 2) / 3 });
    expect(rep.perTool.forecast).toMatchObject({ n: 1, routerNone: 1, answered: 0 });
    expect(rep.perTool.transaction_search.handoffReasons).toEqual({ 'empty-result': 1 });
    expect(rep.perTool.profit_loss).toMatchObject({ routedWrong: 1 });
    expect(rep.perTool.none).toMatchObject({ n: 4, answered: 0 });
  });

  test('none and mutation breakdown, strict not-answered view', () => {
    expect(rep.none).toMatchObject({ n: 4, divertedByScorer: 3, notAnsweredLocally: 4, mutationRows: 2, verblessMutationRows: 1, verblessDiverted: 1 });
    expect(rep.none.reachedReadTool).toEqual(['n4']);
  });

  test('time to handoff: bar paths and all handoffs', () => {
    expect(rep.timing.barPaths.n).toBe(5);
    expect(rep.timing.allHandoffs.n).toBe(8);
    expect(rep.timing.allHandoffs.max).toBe(200);
  });

  test('lenient sensitivity ignores useless but never answerOk', () => {
    expect(rep.sensitivity.lenientAnswerOkOnly).toMatchObject({ good: 2, precisionPct: 100 });
    expect(rep.sensitivity.strict).toMatchObject({ good: 1 });
  });

  test('throws on ungraded answered rows', () => {
    expect(() => buildRound2Report(records, { r1: grades.r1 })).toThrow(/ungraded/);
  });
});
