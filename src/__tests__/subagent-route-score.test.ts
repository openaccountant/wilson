import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { percentile, scoreSet, parseJsonl, BARS, ROUND2_BARS, scoreRound2, verdictRound2 } from '../../scripts/subagent-route-score.mjs';

/**
 * Slice 8 measurement code (no product code): the scorer that turns per-row
 * run records into the D3 / Q8 bars. Pure, so it is pinned here and the
 * browser harness only has to produce records.
 *
 * Record shape: { q, expect, denylist?, gate, hits, route, via, outcome, reason, rows?, ms? }
 *   gate    'route' | 'mutation-intent' | 'non-data'
 *   hits    keywordRoute() result
 *   route   first tool chosen (keyword or llm), 'none' when the router said none, null when never routed
 *   outcome 'answer' | 'handoff' | 'bundle-fallback' | 'cancelled'
 */

const rec = (o: Record<string, unknown>) => ({ hits: [], route: null, via: null, outcome: 'handoff', reason: null, ...o });

describe('percentile', () => {
  test('nearest-rank p95', () => {
    const xs = Array.from({ length: 20 }, (_, i) => i + 1);
    expect(percentile(xs, 95)).toBe(19);
    expect(percentile(xs, 50)).toBe(10);
    expect(percentile([], 95)).toBeNull();
    expect(percentile([7], 95)).toBe(7);
  });
});

describe('scoreSet', () => {
  const rows = [
    // read rows: routed right, routed wrong, gated, handed off by args
    rec({ q: 'a', expect: 'spending_summary', gate: 'route', route: 'spending_summary', via: 'keyword', hits: ['spending_summary'] }),
    rec({ q: 'b', expect: 'profit_loss', gate: 'route', route: 'forecast', via: 'llm', hits: [] }),
    rec({ q: 'c', expect: 'net_worth', gate: 'non-data' }),
    rec({ q: 'd', expect: 'transaction_search', gate: 'route', route: 'transaction_search', via: 'keyword', hits: ['transaction_search'], reason: 'empty-result', rows: 0 }),
    // none rows: diverted by gate, diverted by router, misrouted
    rec({ q: 'e', expect: 'none', gate: 'mutation-intent', denylist: false }),
    rec({ q: 'f', expect: 'none', gate: 'route', route: 'none', via: 'llm', reason: 'router-none' }),
    rec({ q: 'g', expect: 'none', gate: 'route', route: 'transaction_search', via: 'keyword', hits: ['transaction_search'] }),
  ];

  test('counts and rates', () => {
    const s = scoreSet(rows);
    expect(s.read.n).toBe(4);
    expect(s.none.n).toBe(3);
    expect(s.read.routedCorrect).toBe(2);
    expect(s.read.falselyGated).toBe(1);
    expect(s.none.diverted).toBe(2);
    expect(s.none.divertedPct).toBeCloseTo(66.67, 1);
    expect(s.read.routedCorrectPct).toBe(50);
    expect(s.read.falselyGatedPct).toBe(25);
  });

  test('per-label confusion', () => {
    const s = scoreSet(rows);
    expect(s.confusion.spending_summary.spending_summary).toBe(1);
    expect(s.confusion.profit_loss.forecast).toBe(1);
    expect(s.confusion.net_worth.gated).toBe(1);
    expect(s.confusion.none.gated).toBe(1);
    expect(s.confusion.none.none).toBe(1);
    expect(s.confusion.none.transaction_search).toBe(1);
  });

  test('C4: mutation rows without a denylist verb must all be diverted', () => {
    const s = scoreSet([
      rec({ q: 'm1', expect: 'none', gate: 'non-data', denylist: false, mutation: true }),
      rec({ q: 'm2', expect: 'none', gate: 'route', route: 'transaction_search', denylist: false, mutation: true }),
      rec({ q: 'm3', expect: 'none', gate: 'mutation-intent', denylist: true, mutation: true }),
    ]);
    expect(s.c4.n).toBe(2);
    expect(s.c4.diverted).toBe(1);
    expect(s.c4.pass).toBe(false);
  });

  test('C3: transaction_search rows are rows, args-unfillable or empty-result, never a local answer on 0 rows', () => {
    const s = scoreSet([
      rec({ q: 't1', expect: 'transaction_search', gate: 'route', route: 'transaction_search', outcome: 'answer', rows: 3 }),
      rec({ q: 't2', expect: 'transaction_search', gate: 'route', route: 'transaction_search', reason: 'empty-result', rows: 0 }),
      rec({ q: 't3', expect: 'transaction_search', gate: 'route', route: 'transaction_search', reason: 'args-unfillable' }),
      rec({ q: 't4', expect: 'transaction_search', gate: 'route', route: 'transaction_search', outcome: 'answer', rows: 0 }),
    ]);
    expect(s.c3.n).toBe(4);
    expect(s.c3.withRows).toBe(1);
    expect(s.c3.emptyResult).toBe(1);
    expect(s.c3.argsUnfillable).toBe(1);
    expect(s.c3.localAnswerOnEmpty).toBe(1);
    expect(s.c3.pass).toBe(false);
  });

  test('C15: p95 time to handoff on gated, router-none and args-unfillable paths', () => {
    const fast = (path: string, ms: number) =>
      rec({ q: path + ms, expect: 'none', gate: path === 'gated' ? 'non-data' : 'route', route: path === 'router-none' ? 'none' : 'x', reason: path === 'args-unfillable' ? 'args-unfillable' : path === 'router-none' ? 'router-none' : 'non-data', ms });
    const rs = [fast('gated', 1), fast('router-none', 400), fast('router-none', 2500), fast('args-unfillable', 30)];
    const s = scoreSet(rs);
    expect(s.c15.n).toBe(4);
    expect(s.c15.p95).toBe(2500);
    expect(s.c15.pass).toBe(false);
    expect(s.c15.byPath['router-none'].n).toBe(2);
  });

  test('bars object matches the amended D3 bars', () => {
    expect(BARS).toEqual({ divertedMinPct: 95, routedMinPct: 90, falselyGatedMaxPct: 10, c4MinRows: 15, p95MaxMs: 2000 });
  });

  test('fallback policy "keyword single-hit only, otherwise handoff" is scored from hits', () => {
    const s = scoreSet([
      rec({ q: 'a', expect: 'spending_summary', gate: 'route', route: 'spending_summary', via: 'keyword', hits: ['spending_summary'] }),
      rec({ q: 'b', expect: 'profit_loss', gate: 'route', route: 'profit_loss', via: 'llm', hits: [] }),
      rec({ q: 'c', expect: 'none', gate: 'route', route: 'none', via: 'llm', hits: [] }),
      rec({ q: 'd', expect: 'none', gate: 'route', route: 'forecast', via: 'keyword', hits: ['forecast'] }),
    ]);
    expect(s.keywordOnly.read.routedCorrect).toBe(1);
    expect(s.keywordOnly.none.diverted).toBe(1);
  });
});

describe('parseJsonl', () => {
  test('skips blanks, rejects malformed rows', () => {
    expect(parseJsonl('{"q":"x","expect":"none"}\n\n{"q":"y","expect":"forecast"}\n').length).toBe(2);
    expect(() => parseJsonl('{"q":"x"}\n')).toThrow();
    expect(() => parseJsonl('{"q":"x","expect":"bogus"}\n')).toThrow();
  });
});

describe('burned v1 held-out set (archived in Round 2, kept for scorer-shape coverage only)', () => {
  const rows = parseJsonl(readFileSync(join(import.meta.dir, '../../specs/eval/heldout-router.v1-burned.jsonl'), 'utf8'));
  test('at least 40 rows, 5 read tools and none all present', () => {
    expect(rows.length).toBeGreaterThanOrEqual(40);
    for (const label of ['transaction_search', 'spending_summary', 'profit_loss', 'net_worth', 'forecast', 'none']) {
      expect(rows.some((r: { expect: string }) => r.expect === label), label).toBe(true);
    }
  });
});

describe('Round 2 precision-first bars (DECISIONS "Round 2")', () => {
  test('bars', () => {
    expect(ROUND2_BARS).toEqual({
      divertedMinPct: 95,
      c4MinRows: 15,
      precisionMinPct: 97,
      wrongOrUselessMaxPct: 3,
      coverageTargetPct: 35,
      p95MaxMs: 2000,
    });
  });

  const answered = (o: Record<string, unknown>) => rec({ gate: 'route', outcome: 'answer', via: 'keyword', ...o });
  const ok = (q: string, tool: string) => answered({ q, expect: tool, route: tool, hits: [tool], answerOk: true });

  test('precision = locally answered with the right tool AND a correct, useful answer', () => {
    const s = scoreRound2([
      ok('a', 'profit_loss'),
      ok('b', 'net_worth'),
      answered({ q: 'c', expect: 'profit_loss', route: 'profit_loss', hits: ['profit_loss'], answerOk: false }), // wrong answer
      answered({ q: 'd', expect: 'profit_loss', route: 'profit_loss', hits: ['profit_loss'], answerOk: true, useless: true }), // useless
      answered({ q: 'e', expect: 'forecast', route: 'net_worth', hits: ['net_worth'], answerOk: true }), // wrong tool
      answered({ q: 'f', expect: 'none', route: 'net_worth', hits: ['net_worth'], answerOk: true }), // a none row answered locally
      rec({ q: 'g', expect: 'spending_summary', gate: 'route', route: 'none', reason: 'router-none' }), // handed off
    ]);
    expect(s.local.answered).toBe(6);
    expect(s.local.good).toBe(2);
    expect(s.local.precisionPct).toBeCloseTo(33.33, 1);
    expect(s.local.wrongOrUseless).toBe(4);
    expect(s.local.wrongOrUselessPct).toBeCloseTo(66.67, 1);
    expect(s.local.ungraded).toBe(0);
  });

  test('coverage = share of READ rows answered locally (informational)', () => {
    const s = scoreRound2([
      ok('a', 'profit_loss'),
      rec({ q: 'b', expect: 'profit_loss', gate: 'route', route: 'none', reason: 'router-none' }),
      rec({ q: 'c', expect: 'net_worth', gate: 'non-data' }),
      rec({ q: 'd', expect: 'net_worth', gate: 'route', route: 'net_worth', reason: 'empty-result' }),
      rec({ q: 'e', expect: 'none', gate: 'mutation-intent' }),
    ]);
    expect(s.coverage.readRows).toBe(4);
    expect(s.coverage.answeredLocally).toBe(1);
    expect(s.coverage.pct).toBe(25);
  });

  test('a locally answered row nobody graded is ungraded and blocks the verdict (never assumed correct)', () => {
    const s = scoreRound2([answered({ q: 'a', expect: 'profit_loss', route: 'profit_loss', hits: ['profit_loss'] })]);
    expect(s.local.ungraded).toBe(1);
    expect(s.local.precisionPct).toBeNull();
    expect(verdictRound2(s).bars.allLocalAnswersGraded).toBe(false);
    expect(verdictRound2(s).allPass).toBe(false);
  });

  test('no locally answered rows: precision is null and fails (an empty bar is not a pass)', () => {
    const s = scoreRound2([rec({ q: 'a', expect: 'profit_loss', gate: 'route', route: 'none', reason: 'router-none' })]);
    expect(s.local.answered).toBe(0);
    expect(s.local.precisionPct).toBeNull();
    expect(verdictRound2(s).bars.precisionGe97).toBe(false);
  });

  test('coverage below the 35% target is reported but does not fail the verdict', () => {
    const rows = [
      ...Array.from({ length: 100 }, (_, i) => ok(`r${i}`, 'profit_loss')),
      ...Array.from({ length: 300 }, (_, i) => rec({ q: `h${i}`, expect: 'net_worth', gate: 'route', route: 'none', reason: 'router-none', ms: 50 })),
      ...Array.from({ length: 20 }, (_, i) => rec({ q: `m${i}`, expect: 'none', gate: 'mutation-intent', mutation: true, denylist: false, ms: 5 })),
    ];
    const s = scoreRound2(rows);
    expect(s.coverage.pct).toBe(25);
    const v = verdictRound2(s);
    expect(v.coverageMetTarget).toBe(false);
    expect(v.bars.precisionGe97).toBe(true);
    expect(v.bars.wrongOrUselessLe3).toBe(true);
    expect(v.bars.divertedGe95).toBe(true);
    expect(v.bars.c4AllDiverted).toBe(true);
    expect(v.bars.p95Le2s).toBe(true);
    expect(v.allPass).toBe(true);
  });

  test('96% precision fails the 97% bar; exactly 97% passes', () => {
    const mk = (good: number, bad: number) => [
      ...Array.from({ length: good }, (_, i) => ok(`g${i}`, 'profit_loss')),
      ...Array.from({ length: bad }, (_, i) => answered({ q: `b${i}`, expect: 'profit_loss', route: 'profit_loss', hits: ['profit_loss'], answerOk: false })),
    ];
    expect(verdictRound2(scoreRound2(mk(96, 4))).bars.precisionGe97).toBe(false);
    expect(verdictRound2(scoreRound2(mk(97, 3))).bars.precisionGe97).toBe(true);
    expect(verdictRound2(scoreRound2(mk(97, 3))).bars.wrongOrUselessLe3).toBe(true);
  });

  test('fewer than 15 verb-less mutation rows cannot pass the none/mutation bar', () => {
    const rows = Array.from({ length: 14 }, (_, i) => rec({ q: `m${i}`, expect: 'none', gate: 'mutation-intent', mutation: true, denylist: false }));
    expect(verdictRound2(scoreRound2(rows)).bars.c4AllDiverted).toBe(false);
  });

  test('p95 time to handoff above 2 s fails', () => {
    const rows = [
      ...Array.from({ length: 10 }, (_, i) => rec({ q: `s${i}`, expect: 'net_worth', gate: 'route', route: 'none', reason: 'router-none', ms: 100 })),
      rec({ q: 'slow', expect: 'net_worth', gate: 'route', route: 'none', reason: 'router-none', ms: 2500 }),
    ];
    expect(verdictRound2(scoreRound2(rows)).bars.p95Le2s).toBe(false);
  });
});
