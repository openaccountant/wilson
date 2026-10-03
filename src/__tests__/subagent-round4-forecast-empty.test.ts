import { describe, expect, test } from 'bun:test';
import { isEmptyResult } from '../dashboard/ui/src/hybrid/subagent-empty.js';
import { ok, rig } from './subagent-round3-rig.js';

/** Round 4 (specs/DECISIONS.md "Round 4", "Bugs to fix"). */

describe('(1) forecast with an empty trailing window is empty, whatever the starting cash', () => {
  const base = {
    trailingMonths: 3, horizonMonths: 3, startingCash: 12000,
    trailingMonthlyIncome: 0, trailingMonthlyExpense: 0, trailingMonthlyNet: 0, adjustedMonthlyNet: 0,
    appliedAdjustments: [],
    projection: [{ month: '2026-08', projectedCash: 12000 }, { month: '2026-09', projectedCash: 12000 }],
    horizonEndCash: 12000,
  };
  test('startingCash (and the flat projection it implies) is not data when trailing income/expense/net are zero', () => {
    expect(isEmptyResult('forecast', base)).toBe(true);
  });
  test('any non-zero trailing figure makes it non-empty again', () => {
    expect(isEmptyResult('forecast', { ...base, trailingMonthlyIncome: 100 })).toBe(false);
    expect(isEmptyResult('forecast', { ...base, trailingMonthlyExpense: -100 })).toBe(false);
    expect(isEmptyResult('forecast', { ...base, trailingMonthlyNet: -1 })).toBe(false);
  });
  test('a what-if adjustment on an otherwise empty window is still data', () => {
    expect(isEmptyResult('forecast', { ...base, appliedAdjustments: [{ label: 'x', monthlyImpact: 250 }] })).toBe(false);
  });
  test('end to end: the runner hands off as empty-result, no template answer', async () => {
    const r = rig(ok(base));
    const out = await r.run('forecast');
    expect(out.kind).toBe('handoff');
    if (out.kind === 'handoff') expect(out.reason).toBe('empty-result');
    expect(r.gens).toEqual([]);
  });
});

