import { describe, expect, test } from 'bun:test';
import { isEmptyResult } from '../dashboard/ui/src/hybrid/subagent-empty.js';
import { keywordRoute } from '../dashboard/ui/src/hybrid/subagent-core.js';
import type { ReadToolName } from '../dashboard/ui/src/store/mirror-tools.js';
import { EMPTY, rig } from './subagent-round3-rig.js';

/** Round 3 (specs/DECISIONS.md "Empty results"): an empty or all-zero result from ANY tool hands off. */

const SEARCH = {
  query: 'Adobe in June',
  filtersApplied: {},
  count: 2,
  formatted: 'Found 2 transactions:',
  transactions: [{ id: 5, date: '2026-06-05', description: 'ADOBE CREATIVE CLOUD', amount: -54.99, category: 'Software' }],
};
const SPENDING = { period: 'June 2026', totalSpending: -294, transactionCount: 3, categories: [{ category: 'Groceries', total: -294, count: 3 }] };
const PNL_JUNE = { period: 'June 2026', totalIncome: 7900, totalExpenses: -4878.29, netProfitLoss: 3021.71, incomeByCategory: [{ category: 'X', total: 7900, count: 1 }], expensesByCategory: [] };
const NET_WORTH = { netWorth: 52000, totalAssets: 60000, totalLiabilities: 8000, assets: [{ subtype: 'Checking', total: 60000, count: 1 }], liabilities: [] };
const FORECAST = {
  trailingMonths: 3, horizonMonths: 3, startingCash: 12000, trailingMonthlyIncome: 6000, trailingMonthlyExpense: 5000, trailingMonthlyNet: 1000, adjustedMonthlyNet: 1000,
  appliedAdjustments: [], projection: [{ month: '2026-08', projectedCash: 13000 }], horizonEndCash: 15000,
};

describe('isEmptyResult: empty or all-zero results from ANY tool', () => {
  test('transaction_search: zero rows', () => {
    expect(isEmptyResult('transaction_search', { count: 0, transactions: [], formatted: 'No transactions found matching your query.' })).toBe(true);
    expect(isEmptyResult('transaction_search', SEARCH)).toBe(false);
  });
  test('spending_summary: no categories and a zero total (the October-2026 persona case)', () => {
    expect(isEmptyResult('spending_summary', { period: 'October 2026', totalSpending: 0, transactionCount: 0, categories: [], previousPeriod: { label: 'September 2026', categories: [], totalSpending: 0 } })).toBe(true);
    expect(isEmptyResult('spending_summary', SPENDING)).toBe(false);
  });
  test('spending_summary: current period empty even when the previous one has data', () => {
    expect(isEmptyResult('spending_summary', { period: 'October 2026', totalSpending: 0, transactionCount: 0, categories: [], previousPeriod: { label: 'September 2026', categories: [{ category: 'Rent', total: -1, count: 1 }], totalSpending: -1 } })).toBe(true);
  });
  test('profit_loss: zero income, zero expenses', () => {
    expect(isEmptyResult('profit_loss', { period: 'September 2026', totalIncome: 0, totalExpenses: 0, netProfitLoss: 0, incomeByCategory: [], expensesByCategory: [], formatted: 'x' })).toBe(true);
    expect(isEmptyResult('profit_loss', PNL_JUNE)).toBe(false);
  });
  test('net_worth: the no-accounts message and an all-zero book', () => {
    expect(isEmptyResult('net_worth', { message: 'No accounts configured. Add accounts to track net worth.' })).toBe(true);
    expect(isEmptyResult('net_worth', { netWorth: 0, totalAssets: 0, totalLiabilities: 0, assets: [], liabilities: [] })).toBe(true);
    expect(isEmptyResult('net_worth', NET_WORTH)).toBe(false);
  });
  test('forecast: structural months and horizon do not make an all-$0 forecast non-empty', () => {
    const zero = {
      ...FORECAST,
      startingCash: 0, trailingMonthlyIncome: 0, trailingMonthlyExpense: 0, trailingMonthlyNet: 0, adjustedMonthlyNet: 0, horizonEndCash: 0,
      projection: FORECAST.projection.map((p) => ({ ...p, projectedCash: 0 })),
    };
    expect(isEmptyResult('forecast', zero)).toBe(true);
    expect(isEmptyResult('forecast', FORECAST)).toBe(false);
  });
  test('no data at all is empty', () => {
    expect(isEmptyResult('profit_loss', null)).toBe(true);
    expect(isEmptyResult('spending_summary', undefined)).toBe(true);
  });
});

describe('empty or all-zero results from ANY tool hand off', () => {
  for (const tool of Object.keys(EMPTY) as ReadToolName[]) {
    for (const compose of ['template', 'model'] as const) {
      test(`${tool} (${compose}): empty result -> handoff(empty-result) with the step, no compose`, async () => {
        const r = rig(EMPTY[tool].res);
        const out = await r.run(EMPTY[tool].q, { compose });
        expect(out.kind).toBe('handoff');
        if (out.kind !== 'handoff') return;
        expect(out.reason).toBe('empty-result');
        expect(out.handoff.steps.map((s) => s.tool)).toEqual([tool]);
        expect(r.gens).toEqual([]);
        expect(r.events.some((e) => e.kind === 'compose')).toBe(false);
      });
    }
  }

  test('fixtures really route to the tool they claim (guards the fixtures)', () => {
    for (const tool of Object.keys(EMPTY) as ReadToolName[]) expect(keywordRoute(EMPTY[tool].q), tool).toEqual([tool]);
  });
});

