import { describe, expect, test } from 'bun:test';
import { applyGrades, isMutationRow } from '../../scripts/subagent-route-grade.mjs';
import { scoreRound2 } from '../../scripts/subagent-route-score.mjs';

/** Round-2 measurement tooling (no product code): merges per-row human grades into run records. */
const rec = (o: { q: string } & Record<string, unknown>) => ({ hits: [], route: null, via: null, outcome: 'handoff', reason: null, gate: 'route', ...o });

describe('isMutationRow', () => {
  test('uses the writer own answerNotes, not row order', () => {
    expect(isMutationRow({ q: 'x', expect: 'none', answerNotes: 'Mutation request; assistant must not call a read tool' })).toBe(true);
    expect(isMutationRow({ q: 'x', expect: 'none', answerNotes: 'Greeting only; no tool call' })).toBe(false);
    expect(isMutationRow({ q: 'x', expect: 'none', mutation: true })).toBe(true);
    expect(isMutationRow({ q: 'x', expect: 'forecast', answerNotes: 'Mutation request' })).toBe(false);
  });
});

describe('applyGrades', () => {
  const records = [
    rec({ q: 'a', expect: 'transaction_search', outcome: 'answer', route: 'transaction_search' }),
    rec({ q: 'b', expect: 'profit_loss', outcome: 'handoff', reason: 'router-none' }),
    rec({ q: 'c', expect: 'net_worth', outcome: 'answer', route: 'net_worth' }),
  ];

  test('copies answerOk/useless/reason onto answered rows only', () => {
    const out = applyGrades(records, {
      a: { answerOk: true, useless: false, why: 'figure matches' },
      c: { answerOk: false, why: 'wrong total' },
    });
    expect(out[0]).toMatchObject({ answerOk: true, useless: false, gradeWhy: 'figure matches' });
    expect(out[1].answerOk).toBeUndefined();
    expect(out[2]).toMatchObject({ answerOk: false });
    expect(scoreRound2(out).local).toMatchObject({ answered: 2, good: 1, wrongOrUseless: 1, ungraded: 0 });
  });

  test('throws if an answered row has no grade (never assume correct)', () => {
    expect(() => applyGrades(records, { a: { answerOk: true, why: 'ok' } })).toThrow(/ungraded.*c/s);
  });

  test('throws if a grade targets a row that was not answered locally or does not exist', () => {
    expect(() => applyGrades(records, { a: { answerOk: true, why: 'ok' }, c: { answerOk: true, why: 'ok' }, b: { answerOk: true, why: 'x' } })).toThrow(/b/);
    expect(() => applyGrades(records, { a: { answerOk: true, why: 'ok' }, c: { answerOk: true, why: 'ok' }, zz: { answerOk: true, why: 'x' } })).toThrow(/zz/);
  });

  test('every grade needs a reason', () => {
    expect(() => applyGrades(records, { a: { answerOk: true } as never, c: { answerOk: true, why: 'ok' } })).toThrow(/why/);
  });
});
