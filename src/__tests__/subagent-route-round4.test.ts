import { describe, expect, test } from 'bun:test';
import { armBarsR4, coverageDelta, coresidenceSummary, stripAnswerText } from '../../scripts/subagent-route-round4.mjs';

/** Round-4 measurement tooling (no product code): Round 4 Bar-1 ruling, arm comparison, co-residence summary. */
const rec = (o: { q: string; expect: string } & Record<string, unknown>) => ({
  persona: 'p', answerNotes: 'notes', hits: [], route: null, via: null, outcome: 'handoff', reason: null, gate: 'route', mutation: false, ...o,
});

describe('armBarsR4: Bar 1 is "never answered locally"', () => {
  const recs: any[] = [
    rec({ q: 'r1', expect: 'net_worth', route: 'net_worth', outcome: 'answer', text: 'secret answer', ms: 5 }),
    rec({ q: 'r2', expect: 'forecast', route: 'forecast', reason: 'empty-result', ms: 3 }),
    // reads a tool, then hands off: diverted under the Round 4 ruling, NOT under the Round 3 scorer
    rec({ q: 'm1', expect: 'none', mutation: true, denylist: false, route: 'transaction_search', reason: 'empty-result', ms: 2 }),
    rec({ q: 'm2', expect: 'none', mutation: true, denylist: false, gate: 'non-data', ms: 0 }),
    rec({ q: 'm3', expect: 'none', mutation: true, denylist: true, gate: 'mutation-intent', ms: 0 }),
    rec({ q: 'n1', expect: 'none', route: 'none', reason: 'router-none', ms: 1 }),
  ];
  const b = armBarsR4(recs);

  test('counts rows never answered locally, and lists the ones that reached a read tool', () => {
    expect(b.bar1).toMatchObject({
      noneRows: 4, neverAnswered: 4, neverAnsweredPct: 100, answeredLocally: [],
      mutationRows: 3, mutationNeverAnswered: 3, verblessMutationRows: 2, verblessNeverAnswered: 2,
      reachedReadTool: ['m1'],
    });
  });
  test('passes only with >= 95%, >= 15 verb-less mutation rows and zero none/mutation answered locally', () => {
    expect(b.bar1.pass).toBe(false); // only 2 verb-less rows
    expect(b.bar1.passParts).toEqual({ pct: true, verbless: false, noneAnswered: true });
  });
  test('any none row answered locally fails the zero-leak part and is listed', () => {
    const leaked = armBarsR4([...recs, rec({ q: 'leak', expect: 'none', route: 'net_worth', outcome: 'answer', text: 'x', ms: 4 })]);
    expect(leaked.bar1.answeredLocally).toEqual(['leak']);
    expect(leaked.bar1.passParts.noneAnswered).toBe(false);
    expect(leaked.bar1.neverAnsweredPct).toBeCloseTo(80, 5);
  });
  test('bar 4 coverage and bar 5 come through unchanged', () => {
    expect(b.bar4).toMatchObject({ readRows: 2, answered: 1, pct: 50 });
    expect(b.bar5.barPaths.n).toBe(3);
  });
});

describe('coverageDelta (arm O must beat T by >= 5 pp)', () => {
  const t: any[] = [rec({ q: 'a', expect: 'net_worth', outcome: 'answer' }), rec({ q: 'b', expect: 'forecast' }), rec({ q: 'n', expect: 'none' })];
  test('an arm that was not run has no delta and cannot pass', () => {
    expect(coverageDelta(t, null)).toEqual({ tRows: 1, oRows: null, readRows: 2, deltaRows: null, deltaPp: null, meetsFivePp: false });
  });
  test('computes rows and percentage points over the read rows', () => {
    const o: any[] = [rec({ q: 'a', expect: 'net_worth', outcome: 'answer' }), rec({ q: 'b', expect: 'forecast', outcome: 'answer' }), rec({ q: 'n', expect: 'none' })];
    expect(coverageDelta(t, o)).toEqual({ tRows: 1, oRows: 2, readRows: 2, deltaRows: 1, deltaPp: 50, meetsFivePp: true });
  });
});

describe('stripAnswerText', () => {
  test('removes every field that carries an answer, keeps the rest', () => {
    const out = stripAnswerText([{ q: 'q', text: 'A', answer: 'A', suggestedCall: { x: 1 }, outcome: 'answer', ms: 1 }] as any[]);
    expect(out[0]).toEqual({ q: 'q', suggestedCall: { x: 1 }, outcome: 'answer', ms: 1 });
  });
});

describe('coresidenceSummary', () => {
  test('separates solo and concurrent timings, counts errors and device-loss signals', () => {
    const s = coresidenceSummary([
      { kind: 'qwen-solo', ms: 800 }, { kind: 'qwen-solo', ms: 900 },
      { kind: 'oj-solo', ms: 100 }, { kind: 'oj-solo', ms: 120 },
      { kind: 'qwen-concurrent', ms: 1500 }, { kind: 'oj-concurrent', ms: 400 },
      { kind: 'oj-concurrent', ms: 0, error: 'device lost' },
    ]);
    expect(s.errors).toBe(1);
    expect(s.deviceLoss).toBe(1);
    expect(s.byKind['qwen-solo']).toMatchObject({ n: 2, p50: 800, max: 900 });
    expect(s.byKind['oj-concurrent']).toMatchObject({ n: 1 }); // errored sample excluded from timings
    expect(s.ok).toBe(false);
  });
  test('ok when nothing errored', () => {
    expect(coresidenceSummary([{ kind: 'qwen-solo', ms: 1 }]).ok).toBe(true);
  });
});
