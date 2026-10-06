import { afterAll, beforeAll, describe, expect, setSystemTime, test } from 'bun:test';
import { buildNetWorthFixture, buildParityFixture, PARITY_NOW, type ParityFixture } from './mirror-tool-fixtures.js';
import { initTransactionSearchTool, transactionSearchTool } from '../tools/query/transaction-search.js';
import { initSpendingSummaryTool, spendingSummaryTool } from '../tools/query/spending-summary.js';
import { initProfitLossTool, profitLossTool } from '../tools/query/profit-loss.js';
import { initNetWorthTool, netWorthTool } from '../tools/net-worth/net-worth.js';
import { computeForecast } from '../tools/query/forecast.js';
import { mirrorExecuteRead } from '../dashboard/ui/src/store/mirror-tools.js';

/**
 * THE tool-execution equivalence gate (spec D4 / §7.1): for the same seeded
 * data, the mirror's per-tool read must deep-equal the real server tool's
 * `.data` (what executeRead returns after unwrapping `{data}`), with the clock
 * pinned so both sides compute the same period windows.
 */

let fx: ParityFixture;

beforeAll(async () => {
  setSystemTime(new Date(PARITY_NOW));
  fx = await buildParityFixture();
  initTransactionSearchTool(fx.serverDb);
  initSpendingSummaryTool(fx.serverDb);
  initProfitLossTool(fx.serverDb);
});

afterAll(() => {
  setSystemTime();
});

async function serverData(func: (a: never) => Promise<string>, args: Record<string, unknown>): Promise<unknown> {
  return JSON.parse(await func(args as never)).data;
}

async function expectParity(
  tool: 'transaction_search' | 'spending_summary' | 'profit_loss',
  func: (a: never) => Promise<string>,
  args: Record<string, unknown>
): Promise<void> {
  const expected = await serverData(func, args);
  const got = await mirrorExecuteRead(fx.mirror, tool, args, new Date(), 'default');
  expect(got.servable).toBe(true);
  if (!got.servable) return;
  expect(got.profile).toBe('default');
  expect(got.data).toEqual(expected as object);
  // Stronger than toEqual: identical key order and no stray undefined keys.
  expect(JSON.stringify(got.data)).toBe(JSON.stringify(expected));
  expect(typeof got.summary).toBe('string');
  expect(got.summary.length).toBeGreaterThan(0);
  expect(got.summary.length).toBeLessThanOrEqual(1200);
}

describe('transaction_search parity', () => {
  test.each([
    'dining in June',
    'Groceries',
    'over $100',
    'under $20',
    'recurring charges',
    'subscription',
    'Netflix',
    'last month',
    'this month',
    'this year',
    'last year',
    'January 2026',
    'in Dec 2025',
    'Amazon purchases in March',
    'over $100 last month dining',
    'fees & interest',
    'Coffee Shop', // 120 rows: count 120, formatted + transactions capped at 100
    'show all transactions', // no filters at all: every row, capped
    'zzzqq nothing matches', // empty result
    '', // empty query
    'Whole Foods in June',
    'Adobe',
  ])('query %p', async (query) => {
    await expectParity('transaction_search', transactionSearchTool.func as never, { query });
  });

  test('the >100-row case really exercises the cap', async () => {
    const data = (await serverData(transactionSearchTool.func as never, { query: 'Coffee Shop' })) as { count: number; transactions: unknown[] };
    expect(data.count).toBe(120);
    expect(data.transactions).toHaveLength(100);
    const got = await mirrorExecuteRead(fx.mirror, 'transaction_search', { query: 'Coffee Shop' }, new Date(), 'default');
    if (!got.servable) throw new Error('not servable');
    expect((got.data as { count: number }).count).toBe(120);
  });

  test('summary is capped to 25 rows and never includes notes', async () => {
    const got = await mirrorExecuteRead(fx.mirror, 'transaction_search', { query: 'Coffee Shop' }, new Date(), 'default');
    if (!got.servable) throw new Error('not servable');
    const lines = got.summary.split('\n').filter((l) => l.startsWith('#'));
    expect(lines.length).toBeLessThanOrEqual(25);
    expect(got.summary).not.toContain('notes');
  });
});

describe('spending_summary parity (explicit args)', () => {
  const cases: Array<{ period: 'month' | 'quarter' | 'year'; compareWithPrevious: boolean }> = [];
  for (const period of ['month', 'quarter', 'year'] as const) {
    for (const compareWithPrevious of [true, false]) cases.push({ period, compareWithPrevious });
  }
  test.each(cases)('%o', async (args) => {
    await expectParity('spending_summary', spendingSummaryTool.func as never, args);
  });

  test('a quarter crossing a year boundary (clock pinned to February)', async () => {
    setSystemTime(new Date('2026-02-10T09:00:00'));
    try {
      await expectParity('spending_summary', spendingSummaryTool.func as never, { period: 'quarter', compareWithPrevious: true });
      await expectParity('spending_summary', spendingSummaryTool.func as never, { period: 'month', compareWithPrevious: true });
    } finally {
      setSystemTime(new Date(PARITY_NOW));
    }
  });
});

describe('profit_loss parity', () => {
  const cases: Array<{ period: 'month' | 'quarter' | 'year'; offset: number }> = [
    { period: 'month', offset: 0 },
    { period: 'month', offset: -1 },
    { period: 'month', offset: -4 },
    { period: 'month', offset: -9 }, // crosses into 2025
    { period: 'quarter', offset: 0 },
    { period: 'quarter', offset: -1 },
    { period: 'quarter', offset: -3 },
    { period: 'year', offset: 0 },
    { period: 'year', offset: -1 },
    { period: 'year', offset: -2 }, // 2024: single expense row, no income
  ];
  test.each(cases)('%o', async (args) => {
    await expectParity('profit_loss', profitLossTool.func as never, args);
  });

  test('has Income and Transfer rows in scope (guards the seed)', async () => {
    const data = (await serverData(profitLossTool.func as never, { period: 'month', offset: -4 })) as {
      totalIncome: number;
      expensesByCategory: Array<{ category: string }>;
    };
    expect(data.totalIncome).toBeGreaterThan(0);
    expect(data.expensesByCategory.map((r) => r.category)).not.toContain('Transfer');
  });
});


// ── Phase 2 (mirror v4): net_worth and forecast over accounts / loans ────────

describe('net_worth parity (mirror v4)', () => {
  let nw: ParityFixture;
  beforeAll(async () => {
    nw = await buildNetWorthFixture();
  });

  async function serverNetWorth(db: ParityFixture['serverDb'], args: Record<string, unknown>): Promise<unknown> {
    initNetWorthTool(db);
    return JSON.parse(await netWorthTool.func(args as never)).data;
  }

  async function expectNetWorthParity(book: ParityFixture, args: Record<string, unknown>): Promise<unknown> {
    const expected = await serverNetWorth(book.serverDb, args);
    const got = await mirrorExecuteRead(book.mirror, 'net_worth', args, new Date(), 'default');
    expect(got.servable).toBe(true);
    if (!got.servable) throw new Error('not servable');
    expect(got.profile).toBe('default');
    expect(got.data).toEqual(expected as object);
    // Identical key order and no stray undefined keys (equity is omitted when there are no loans).
    expect(JSON.stringify(got.data)).toBe(JSON.stringify(expected));
    expect(got.summary.length).toBeGreaterThan(0);
    expect(got.summary.length).toBeLessThanOrEqual(1200);
    return got.data;
  }

  test('summary', async () => {
    const data = (await expectNetWorthParity(nw, { action: 'summary' })) as { netWorth: number; totalAssets: number; assets: unknown[] };
    // Guards the seed: inactive accounts are really excluded.
    expect(data.totalAssets).toBe(4000.5 + 12000.25 + 250 + 50000.75 + 400000 + 15000);
    expect(data.assets.length).toBeGreaterThan(3);
  });

  test('balance_sheet, including equity rows from linked loans', async () => {
    const data = (await expectNetWorthParity(nw, { action: 'balance_sheet' })) as { equity?: Array<{ assetName: string }> };
    expect(data.equity?.map((e) => e.assetName).sort()).toEqual(['Car', 'House']);
  });

  test('empty book (no accounts): the same "No accounts configured" messages', async () => {
    await expectNetWorthParity(fx, { action: 'summary' });
    await expectNetWorthParity(fx, { action: 'balance_sheet' });
  });

  test('a balance sheet with accounts but no loans omits equity entirely', async () => {
    const book = await buildNetWorthFixture();
    book.serverDb.prepare('DELETE FROM loans').run();
    await book.mirror.exec('DELETE FROM loans');
    const data = (await expectNetWorthParity(book, { action: 'balance_sheet' })) as Record<string, unknown>;
    expect('equity' in data).toBe(false);
  });

  test('trend stays server-only: servable:false, why:licensed (asserted for every months value)', async () => {
    for (const args of [{ action: 'trend' }, { action: 'trend', months: 6 }, { action: 'trend', months: 24 }]) {
      const got = await mirrorExecuteRead(nw.mirror, 'net_worth', args, new Date(), 'default');
      expect(got).toEqual({ servable: false, why: 'licensed' });
    }
  });

  test('unknown or missing action -> unsupported-args', async () => {
    expect(await mirrorExecuteRead(nw.mirror, 'net_worth', { action: 'liquidate' }, new Date(), 'default')).toEqual({
      servable: false,
      why: 'unsupported-args',
    });
    expect(await mirrorExecuteRead(nw.mirror, 'net_worth', {}, new Date(), 'default')).toEqual({
      servable: false,
      why: 'unsupported-args',
    });
  });

  test('a mirror without the accounts table resolves missing-tables, not a throw', async () => {
    const book = await buildNetWorthFixture();
    await book.mirror.exec('DROP TABLE accounts');
    expect(await mirrorExecuteRead(book.mirror, 'net_worth', { action: 'summary' }, new Date(), 'default')).toEqual({
      servable: false,
      why: 'missing-tables',
    });
    expect(await mirrorExecuteRead(book.mirror, 'forecast', {}, new Date(), 'default')).toEqual({
      servable: false,
      why: 'missing-tables',
    });
  });
});

describe('forecast parity (mirror v4)', () => {
  let nw: ParityFixture;
  beforeAll(async () => {
    nw = await buildNetWorthFixture();
  });

  async function expectForecastParity(args: Record<string, unknown>, book: ParityFixture = nw): Promise<Record<string, unknown>> {
    const expected = computeForecast(book.serverDb, args as never);
    const got = await mirrorExecuteRead(book.mirror, 'forecast', args, new Date(), 'default');
    expect(got.servable).toBe(true);
    if (!got.servable) throw new Error('not servable');
    expect(got.profile).toBe('default');
    expect(got.data).toEqual(expected);
    expect(JSON.stringify(got.data)).toBe(JSON.stringify(expected));
    expect(got.summary.length).toBeGreaterThan(0);
    expect(got.summary.length).toBeLessThanOrEqual(1200);
    return got.data as Record<string, unknown>;
  }

  test('defaults (3 months trailing, 3 ahead): starting cash is checking + savings + cash only, active only', async () => {
    const data = await expectForecastParity({});
    expect(data.startingCash).toBe(4000.5 + 12000.25 + 250);
    expect((data.projection as unknown[]).length).toBe(3);
  });

  test.each([
    ['trailingMonths 1', { trailingMonths: 1 }],
    ['trailingMonths 24, horizon 24', { trailingMonths: 24, horizonMonths: 24 }],
    ['trailingMonths 0 clamps to 1', { trailingMonths: 0 }],
    ['trailingMonths 99 clamps to 24', { trailingMonths: 99, horizonMonths: 99 }],
    ['horizon 6', { horizonMonths: 6 }],
    ['adjust_category (spend less)', { whatIf: [{ type: 'adjust_category', category: 'Dining', monthlyDelta: -50 }] }],
    ['adjust_category (spend more, no delta)', { whatIf: [{ type: 'adjust_category', category: 'Dining' }] }],
    ['adjust_category without a category is ignored', { whatIf: [{ type: 'adjust_category', monthlyDelta: -50 }] }],
    ['drop_recurring Netflix', { whatIf: [{ type: 'drop_recurring', description: 'Netflix' }] }],
    ['drop_recurring is case-insensitive and substring', { trailingMonths: 6, whatIf: [{ type: 'drop_recurring', description: 'adobe' }] }],
    ['drop_recurring with no match', { whatIf: [{ type: 'drop_recurring', description: 'zzzqq' }] }],
    [
      'several adjustments together',
      {
        trailingMonths: 6,
        horizonMonths: 12,
        whatIf: [
          { type: 'adjust_category', category: 'Dining', monthlyDelta: -25.5 },
          { type: 'drop_recurring', description: 'Netflix' },
          { type: 'drop_recurring', description: 'Adobe' },
        ],
      },
    ],
  ] as const)('%s', async (_name, args) => {
    await expectForecastParity(args as unknown as Record<string, unknown>);
  });

  test('no accounts: starting cash 0, still the same projection', async () => {
    const data = await expectForecastParity({}, fx);
    expect(data.startingCash).toBe(0);
  });

  test('trailing window and month labels cross a year boundary (clock pinned to January)', async () => {
    setSystemTime(new Date('2026-01-20T09:00:00'));
    try {
      await expectForecastParity({ trailingMonths: 6, horizonMonths: 12 });
      await expectForecastParity({ trailingMonths: 3, whatIf: [{ type: 'drop_recurring', description: 'Netflix' }] });
    } finally {
      setSystemTime(new Date(PARITY_NOW));
    }
  });

  test('the clock is the injected one: a different `now` shifts the window and the labels', async () => {
    const early = await mirrorExecuteRead(nw.mirror, 'forecast', { horizonMonths: 2 }, new Date('2026-03-10T09:00:00'), 'default');
    const late = await mirrorExecuteRead(nw.mirror, 'forecast', { horizonMonths: 2 }, new Date('2026-07-10T09:00:00'), 'default');
    if (!early.servable || !late.servable) throw new Error('not servable');
    const months = (r: typeof early) => (r.data as { projection: Array<{ month: string }> }).projection.map((p) => p.month);
    expect(months(early)).toEqual(['2026-04', '2026-05']);
    expect(months(late)).toEqual(['2026-08', '2026-09']);
  });

  test('bad args resolve unsupported-args instead of throwing', async () => {
    for (const args of [{ trailingMonths: 'three' }, { horizonMonths: Number.NaN }, { whatIf: 'cut dining' }, { whatIf: [{ type: 'wish' }] }, { whatIf: [null] }]) {
      expect(await mirrorExecuteRead(nw.mirror, 'forecast', args as Record<string, unknown>, new Date(), 'default')).toEqual({
        servable: false,
        why: 'unsupported-args',
      });
    }
  });
});
