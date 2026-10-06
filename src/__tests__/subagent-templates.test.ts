import { describe, expect, test } from 'bun:test';
import { formatUsd, renderTemplate } from '../dashboard/ui/src/hybrid/subagent-templates.js';
import { hasForbiddenMarkup, isGrounded } from '../dashboard/ui/src/hybrid/subagent-core.js';
import { DEFAULT_SUBAGENT_LIMITS } from '../dashboard/ui/src/hybrid/worker-protocol.js';
import { ok, PNL, rig } from './subagent-round3-rig.js';

/**
 * Round 3 (specs/DECISIONS.md "Local answer writing"): deterministic per-tool templates write the
 * local answer. The data below has the shape the real read tools return (see mirror-tools.ts):
 * spending/P&L category totals are negative for expenses, the footer row only exists in `formatted`.
 */

const TODAY = '2026-07-15';

const PNL_JUNE = {
  period: 'June 2026',
  dateRange: { start: '2026-06-01', end: '2026-06-30' },
  totalIncome: 7900,
  totalExpenses: -4878.29,
  netProfitLoss: 3021.71,
  incomeByCategory: [
    { category: 'Client Income', total: 4200, count: 2 },
    { category: 'Payroll', total: 3100, count: 1 },
    { category: 'Transfers', total: 600, count: 1 },
  ],
  expensesByCategory: [
    { category: 'Groceries', total: -294, count: 3 },
    { category: 'Rent', total: -1800, count: 1 },
    { category: 'Taxes', total: -1200, count: 1 },
    { category: 'Travel', total: -412, count: 1 },
    { category: 'Software', total: -109.98, count: 2 },
  ],
  formatted: 'Profit & Loss: June 2026\n\n...\nTOTAL EXPENSES  -$4,878.29\nNET PROFIT  +$3,021.71',
};

const SPENDING = {
  period: 'June 2026',
  dateRange: { start: '2026-06-01', end: '2026-06-30' },
  totalSpending: -4878.29,
  transactionCount: 17,
  categories: [
    { category: 'Groceries', total: -294, count: 3 },
    { category: 'Rent', total: -1800, count: 1 },
    { category: 'Taxes', total: -1200, count: 1 },
    { category: 'Travel', total: -412, count: 1 },
    { category: 'Software', total: -109.98, count: 2 },
    { category: 'Dining', total: -50, count: 1 },
  ],
  previousPeriod: { label: 'May 2026', categories: [{ category: 'Rent', total: -1800, count: 1 }], totalSpending: -1800 },
  formatted: 'Spending Summary: June 2026\n...\nTOTAL  -$4,878.29',
};

const SEARCH = {
  query: 'Adobe in June',
  filtersApplied: { dateStart: '2026-06-01', dateEnd: '2026-06-30', merchant: 'Adobe' },
  count: 2,
  formatted: 'Found 2 transactions:',
  transactions: [
    { id: 5, date: '2026-06-05', description: 'ADOBE CREATIVE CLOUD', amount: -54.99, category: 'Software' },
    { id: 6, date: '2026-06-05', description: 'ADOBE CREATIVE CLOUD', amount: -54.99, category: null },
  ],
};

const NET_WORTH = {
  netWorth: 52000,
  totalAssets: 60000,
  totalLiabilities: 8000,
  assets: [
    { subtype: 'Checking', total: 5000, count: 1 },
    { subtype: 'Brokerage', total: 55000, count: 1 },
  ],
  liabilities: [{ subtype: 'Credit Card', total: 8000, count: 1 }],
};

const FORECAST = {
  trailingMonths: 3,
  horizonMonths: 3,
  startingCash: 12000,
  trailingMonthlyIncome: 6000,
  trailingMonthlyExpense: 5000,
  trailingMonthlyNet: 1000,
  adjustedMonthlyNet: 1000,
  appliedAdjustments: [],
  projection: [
    { month: '2026-08', projectedCash: 13000 },
    { month: '2026-09', projectedCash: 14000 },
    { month: '2026-10', projectedCash: 15000 },
  ],
  horizonEndCash: 15000,
};

describe('formatUsd', () => {
  test('dollars with thousands separators and two decimals; sign in front of the dollar sign', () => {
    expect(formatUsd(3021.71)).toBe('$3,021.71');
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(-1234567.5)).toBe('-$1,234,567.50');
    expect(formatUsd(7900)).toBe('$7,900.00');
    expect(formatUsd(-0.004)).toBe('$0.00');
    expect(formatUsd(0.1 + 0.2)).toBe('$0.30');
  });
});

describe('profit_loss template', () => {
  const text = renderTemplate('profit_loss', PNL_JUNE, { today: TODAY })!;

  test('labeled net with income and expenses, period stated', () => {
    expect(text).toContain('Net for June 2026: $3,021.71 (income $7,900.00, expenses $4,878.29)');
  });
  test('top expense and income categories by amount, never a TOTAL row', () => {
    expect(text).toContain('Top expense categories: Rent $1,800.00, Taxes $1,200.00, Travel $412.00');
    expect(text).toContain('Top income categories: Client Income $4,200.00, Payroll $3,100.00, Transfers $600.00');
    expect(text).not.toMatch(/\bTOTAL\b/i);
  });
  test('a negative net keeps its sign', () => {
    const t = renderTemplate('profit_loss', { ...PNL_JUNE, totalIncome: 1000, totalExpenses: -1120, netProfitLoss: -120 }, { today: TODAY })!;
    expect(t).toContain('Net for June 2026: -$120.00 (income $1,000.00, expenses $1,120.00)');
  });
  test('a category literally named TOTAL is dropped from the ranking', () => {
    const t = renderTemplate('profit_loss', { ...PNL_JUNE, expensesByCategory: [{ category: 'TOTAL', total: -9999, count: 0 }, ...PNL_JUNE.expensesByCategory] }, { today: TODAY })!;
    expect(t).not.toMatch(/TOTAL/);
    expect(t).toContain('Top expense categories: Rent');
  });
  test('output is grounded in its own data', () => {
    expect(isGrounded(text, [{ tool: 'profit_loss', data: PNL_JUNE }])).toBe(true);
  });
  test('accepts the legacy netProfit field name used by older fixtures', () => {
    const { netProfitLoss: _n, ...rest } = PNL_JUNE;
    const t = renderTemplate('profit_loss', { ...rest, netProfit: 3021.71 }, { today: TODAY })!;
    expect(t).toContain('Net for June 2026: $3,021.71');
  });
});

describe('spending_summary template', () => {
  const text = renderTemplate('spending_summary', SPENDING, { today: TODAY })!;

  test('period, total and transaction count are stated', () => {
    expect(text).toContain('Spending for June 2026: $4,878.29 across 17 transactions.');
  });
  test('top categories by amount, biggest first, at most five, no TOTAL', () => {
    expect(text).toContain('Top categories: Rent $1,800.00, Taxes $1,200.00, Travel $412.00, Groceries $294.00, Software $109.98.');
    expect(text).not.toContain('Dining');
    expect(text).not.toMatch(/\bTOTAL\b/i);
  });
  test('previous period total is shown when it has spending', () => {
    expect(text).toContain('Previous period (May 2026): $1,800.00.');
    const none = renderTemplate('spending_summary', { ...SPENDING, previousPeriod: { label: 'May 2026', categories: [], totalSpending: 0 } }, { today: TODAY })!;
    expect(none).not.toContain('Previous period');
  });
  test('singular transaction', () => {
    const t = renderTemplate('spending_summary', { ...SPENDING, transactionCount: 1, categories: [SPENDING.categories[0]], totalSpending: -294 }, { today: TODAY })!;
    expect(t).toContain('across 1 transaction.');
  });
  test('positive category totals (fixtures) read the same as negative ones', () => {
    const t = renderTemplate('spending_summary', { ...SPENDING, totalSpending: 190.75, categories: [{ category: 'Groceries', total: 88.5, count: 1 }, { category: 'Dining', total: 41.25, count: 1 }], previousPeriod: undefined }, { today: TODAY })!;
    expect(t).toContain('Top categories: Groceries $88.50, Dining $41.25.');
  });
  test('grounded', () => {
    expect(isGrounded(text, [{ tool: 'spending_summary', data: SPENDING }])).toBe(true);
  });
});

describe('transaction_search template', () => {
  const text = renderTemplate('transaction_search', SEARCH, { today: TODAY })!;

  test('count, date window and net are stated; every listed row has date, amount, description, category', () => {
    expect(text).toContain('Found 2 transactions (2026-06-01 to 2026-06-30), net -$109.98:');
    expect(text).toContain('- 2026-06-05: -$54.99, ADOBE CREATIVE CLOUD (Software)');
    expect(text).toContain('- 2026-06-05: -$54.99, ADOBE CREATIVE CLOUD (Uncategorized)');
  });
  test('no date filter says all dates', () => {
    const t = renderTemplate('transaction_search', { ...SEARCH, filtersApplied: { merchant: 'Adobe' } }, { today: TODAY })!;
    expect(t).toContain('(all dates)');
  });
  test('long lists are cut at 10 rows with the remainder counted', () => {
    const rows = Array.from({ length: 14 }, (_, i) => ({ id: i, date: '2026-06-02', description: `SHOP ${i}`, amount: -10, category: 'Dining' }));
    const t = renderTemplate('transaction_search', { ...SEARCH, count: 14, transactions: rows }, { today: TODAY })!;
    expect(t.split('\n').filter((l) => l.startsWith('- ')).length).toBe(10);
    expect(t).toContain('and 4 more');
    expect(t).toContain('net -$140.00');
  });
  test('when fewer rows came back than the count (100-row cap) the net is labeled as the listed rows', () => {
    const rows = Array.from({ length: 3 }, (_, i) => ({ id: i, date: '2026-06-02', description: `SHOP ${i}`, amount: -10, category: 'Dining' }));
    const t = renderTemplate('transaction_search', { ...SEARCH, count: 250, transactions: rows }, { today: TODAY })!;
    expect(t).toContain('Found 250 transactions');
    expect(t).toContain('net of the 3 rows returned -$30.00');
  });
  test('descriptions are cleaned: control characters stripped and length capped', () => {
    const t = renderTemplate('transaction_search', { ...SEARCH, count: 1, transactions: [{ id: 1, date: '2026-06-01', description: `A\u0007B${'x'.repeat(200)}`, amount: -1, category: 'Misc' }] }, { today: TODAY })!;
    expect(t).not.toContain('\u0007');
    expect(Math.max(...t.split('\n').map((l) => l.length))).toBeLessThan(120);
  });
  test('markup-free; every row amount is in the data (the net is a sum the template computes)', () => {
    expect(hasForbiddenMarkup(text)).toBe(false);
    expect(text).toContain('-$54.99');
  });
});

describe('net_worth template', () => {
  test('headline (no date: the result holds none), assets and liabilities breakdown', () => {
    const t = renderTemplate('net_worth', NET_WORTH, { today: TODAY })!;
    expect(t).toContain('Net worth: $52,000.00 (assets $60,000.00, liabilities $8,000.00).');
    expect(t).toContain('Assets: Brokerage $55,000.00, Checking $5,000.00.');
    expect(t).toContain('Liabilities: Credit Card $8,000.00.');
    expect(isGrounded(t, [{ tool: 'net_worth', data: NET_WORTH }])).toBe(true);
  });
  test('balance_sheet shaped rows (name + balance) work too', () => {
    const t = renderTemplate('net_worth', { netWorth: 100, assets: [{ id: 1, name: 'Main Checking', subtype: 'Checking', balance: 150 }], liabilities: [{ id: 2, name: 'Visa', subtype: 'Credit Card', balance: 50 }] }, { today: TODAY })!;
    expect(t).toContain('Net worth: $100.00.');
    expect(t).toContain('Assets: Main Checking $150.00.');
    expect(t).toContain('Liabilities: Visa $50.00.');
  });
});

describe('forecast template', () => {
  const t = renderTemplate('forecast', FORECAST, { today: TODAY })!;
  test('horizon, window and assumptions are stated', () => {
    expect(t).toContain('Cash forecast for the next 3 months (2026-08 to 2026-10), based on the last 3 months.');
    expect(t).toContain('Starting cash $12,000.00. Average monthly income $6,000.00, expenses $5,000.00, net $1,000.00.');
    expect(t).toContain('Projected cash: 2026-08 $13,000.00, 2026-09 $14,000.00, 2026-10 $15,000.00.');
    expect(t).toContain('Cash at the end of the horizon: $15,000.00.');
  });
  test('applied what-if adjustments are listed', () => {
    const w = renderTemplate('forecast', { ...FORECAST, appliedAdjustments: [{ description: 'drop Golf dues', monthlyImpact: 150 }], adjustedMonthlyNet: 1150 }, { today: TODAY })!;
    expect(w).toContain('What-if: drop Golf dues ($150.00 per month).');
  });
  test('grounded', () => {
    expect(isGrounded(t, [{ tool: 'forecast', data: FORECAST }])).toBe(true);
  });
});

describe('renderTemplate refuses what it cannot render', () => {
  test('unknown or malformed data returns null, never throws', () => {
    for (const tool of ['transaction_search', 'spending_summary', 'profit_loss', 'net_worth', 'forecast'] as const) {
      for (const data of [null, undefined, 'x', 5, [], {}, { foo: 1 }]) {
        expect(renderTemplate(tool, data, { today: TODAY }), `${tool} ${JSON.stringify(data)}`).toBeNull();
      }
    }
  });
});


describe('compose: template (the default)', () => {
  test('DEFAULT_SUBAGENT_LIMITS.compose is "template"', () => {
    expect(DEFAULT_SUBAGENT_LIMITS.compose).toBe('template');
  });

  test('the answer is written by the template from the tool result and no model call is made', async () => {
    const r = rig(PNL);
    const out = await r.run('Give me a P&L for June');
    expect(out.kind).toBe('answer');
    if (out.kind !== 'answer') return;
    expect(out.text).toContain('Net for June 2026: $3,021.71 (income $7,900.00, expenses $4,878.29)');
    expect(out.text).toContain('Top expense categories: Groceries $3,078.29, Rent $1,800.00');
    expect(out.text).not.toMatch(/\bTOTAL\b/i);
    expect(r.gens).toEqual([]);
    expect(out.steps.map((s) => s.tool)).toEqual(['profit_loss']);
    expect('data' in out.steps[0]).toBe(false);
  });

  test('the UI still sees the same step chips (gate, route, tool, compose)', async () => {
    const r = rig(PNL);
    await r.run('Give me a P&L for June');
    expect(r.events.map((e) => e.kind)).toEqual(['gate', 'route', 'tool', 'compose']);
  });

  test('a template is deterministic: same result, same text', async () => {
    const a = await rig(PNL).run('Give me a P&L for June');
    const b = await rig(PNL).run('Give me a P&L for June');
    expect(a).toEqual(b);
  });

  test('data the template cannot render hands off (no-answer) instead of guessing', async () => {
    const r = rig(ok({ foo: 1 }));
    const out = await r.run('Give me a P&L for June');
    expect(out.kind === 'handoff' && out.reason).toBe('no-answer');
    expect(r.gens).toEqual([]);
  });

  test('a link smuggled in through untrusted row text never reaches the answer', async () => {
    const r = rig(ok({
      query: 'x', count: 1, formatted: 'x', filtersApplied: {},
      transactions: [{ id: 1, date: '2026-06-01', description: 'See https://evil.example/pay now', amount: -9.99, category: 'Misc' }],
    }));
    const out = await r.run('Show me every Zzyzx Labs charge');
    expect(out.kind).toBe('handoff');
    if (out.kind === 'handoff') expect(out.reason).toBe('ungrounded');
  });
});

describe('compose: model (kept for comparison)', () => {
  test('the model composes, as before', async () => {
    const r = rig(PNL, { llm: () => 'Your net profit for June 2026 was $3,021.71.' });
    const out = await r.run('Give me a P&L for June', { compose: 'model' });
    expect(r.gens.map((g) => g.kind)).toEqual(['compose']);
    expect(out.kind === 'answer' && out.text).toBe('Your net profit for June 2026 was $3,021.71.');
  });

  test('grounding still applies: a figure the data does not support hands off', async () => {
    const r = rig(PNL, { llm: () => 'Your net profit for June 2026 was $9,999.00.' });
    const out = await r.run('Give me a P&L for June', { compose: 'model' });
    expect(out.kind === 'handoff' && out.reason).toBe('ungrounded');
  });

  test('claim checks still apply: a false "no results" on non-empty data hands off', async () => {
    const r = rig(PNL, { llm: () => 'No results found.' });
    const out = await r.run('Give me a P&L for June', { compose: 'model' });
    expect(out.kind).toBe('handoff');
  });
});

