import { describe, expect, test } from 'bun:test';
import type { Database } from '../db/compat-sqlite.js';
import { Database as SqliteDatabase } from '../db/compat-sqlite.js';
import { createTestDb, daysAgo } from './helpers.js';
import {
  apiAlerts,
  apiBudgetLimits,
  apiBudgets,
  apiCashflowMonthly,
  apiCategories,
  apiCategoryOptions,
  apiEntities,
  apiPnl,
  apiSavings,
  apiSemanticSearch,
  apiSpendingByInstitution,
  apiStreak,
  apiSummary,
  apiTransactions,
  apiWeeklySummary,
} from '../dashboard/api.js';
import { getMonthlyCashflowData, getTransactions, insertTransactions, setBudget } from '../db/queries.js';
import { getStreak, getWeeklySummary } from '../db/daily-queries.js';
import { checkAlerts } from '../alerts/engine.js';
import { createEntity } from '../db/entity-queries.js';
import { searchTransactionsSemantic, upsertEmbeddings } from '../db/embedding-queries.js';
import { DEFAULT_EMBEDDING_MODEL, transactionEmbedText } from '../utils/embeddings.js';
import { createFakeEmbedder, fakeEmbedText } from './fake-embedder.js';
import { applySync, createMirrorSchema } from '../dashboard/ui/src/store/mirror-schema.js';
import { serveApiPath } from '../dashboard/ui/src/store/mirror-reads.js';
import { MirrorTestBinding } from './mirror-helpers.js';
import type {
  MirrorBudgetRow,
  MirrorCategoryRow,
  MirrorEntityRow,
  MirrorTransactionRow,
} from '../dashboard/ui/src/store/types.js';
import { categoryFilterOptions } from '../dashboard/ui/src/lib/categoryOptions.js';
import { budgetLimitScaleLabel, budgetTakeaway } from '../dashboard/ui/src/lib/budgetBars.js';
import { nextShowTable, tableToggleLabel } from '../dashboard/ui/src/charts/chartCardState.js';
import {
  buildHeatmapGrid,
  heatmapSummary,
  heatmapYearRange,
  isFilteredHeatmap,
  TALLY_DAYS,
} from '../dashboard/ui/src/lib/heatmapGrid.js';
import { entityScopedPath } from '../dashboard/ui/src/lib/overviewQueries.js';

// Verifier findings on Charting Batch 1 (M1–M3, L1–L7). Each block names the
// finding it pins.

/** YYYY-MM `monthsBack` months ago (local calendar, pinned to day 1). */
function monthYm(monthsBack: number): string {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - monthsBack);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function defaultEntityId(db: Database): number {
  return (db.prepare('SELECT id FROM entities WHERE is_default = 1').get() as { id: number }).id;
}

/** A mirror seeded from the server's own raw pulls (the sync-engine path). */
async function mirrorOf(serverDb: Database): Promise<MirrorTestBinding> {
  const binding = new MirrorTestBinding(new SqliteDatabase(':memory:'));
  await createMirrorSchema(binding);
  await applySync(binding, {
    profile: 'default',
    transactions: apiTransactions(serverDb, new URLSearchParams({ limit: String(10_000_000) })) as unknown as MirrorTransactionRow[],
    entities: apiEntities(serverDb) as unknown as MirrorEntityRow[],
    budgets: apiBudgetLimits(serverDb) as unknown as MirrorBudgetRow[],
    categories: apiCategories(serverDb) as unknown as MirrorCategoryRow[],
  });
  return binding;
}

// ── M1: header category options include non-spend categories ───────────────

describe('M1 — /api/category-options', () => {
  function seedCats(db: Database): void {
    insertTransactions(db, [
      { date: daysAgo(2), description: 'Dinner', amount: -40, category: 'Dining' },
      { date: daysAgo(2), description: 'To savings', amount: -100, category: 'Transfer' },
      { date: daysAgo(3), description: 'CARD PAYMENT', amount: -250, category: 'Credit Card' },
      { date: daysAgo(3), description: 'Loan pmt', amount: -90, category: 'Payment' },
      { date: daysAgo(4), description: 'Paycheck', amount: 3000, category: 'Income' },
      { date: daysAgo(5), description: 'Mystery', amount: -5 },
      { date: daysAgo(5), description: 'Blank', amount: -6, category: '' },
      { date: daysAgo(5), description: 'Literal', amount: -7, category: 'Uncategorized' },
    ]);
  }

  test('lists every category label in transactions, incl. non-spend and one Uncategorized', () => {
    const db = createTestDb();
    seedCats(db);
    const options = apiCategoryOptions(db);
    expect(options).toEqual(['Credit Card', 'Dining', 'Income', 'Payment', 'Transfer', 'Uncategorized']);
    // The spend summary (what the dropdown used to be built from) drops them.
    const summary = apiSummary(db, new URLSearchParams({ startDate: '2000-01-01', endDate: '2099-12-31' }));
    expect(summary.map((r) => r.category).sort()).toEqual(['Dining', 'Uncategorized']);
  });

  test('mirror parity', async () => {
    const db = createTestDb();
    seedCats(db);
    const mirror = await mirrorOf(db);
    expect(await serveApiPath(mirror, '/api/category-options')).toEqual(apiCategoryOptions(db));
  });

  test('dropdown helper keeps a deep-linked category selected and sorts/dedupes', () => {
    expect(categoryFilterOptions(null, 'Transfer')).toEqual(['Transfer']);
    expect(categoryFilterOptions(['Transfer', 'Dining'], 'Dining')).toEqual(['Dining', 'Transfer']);
    expect(categoryFilterOptions(['Dining', ''], 'Gone From Data')).toEqual(['Dining', 'Gone From Data']);
    expect(categoryFilterOptions(['Income'], null)).toEqual(['Income']);
  });
});

// ── M3: cash forecast series uses the dashboard rules (opt-in) ──────────────

describe('M3 — /api/cashflow/monthly uses dashboard rules; CLI path unchanged', () => {
  const m = monthYm(1);
  function seedCash(db: Database): void {
    insertTransactions(db, [
      { date: `${m}-03`, description: 'Paycheck', amount: 3000, category: 'Income' },
      // Importer stored a paycheck negative: dashboard income, legacy nets it out.
      { date: `${m}-04`, description: 'Paycheck (negative)', amount: -1500, category: 'Income' },
      { date: `${m}-10`, description: 'Groceries', amount: -400, category: 'Groceries' },
      // Card payment out of checking: never an expense on the dashboard.
      { date: `${m}-20`, description: 'CC PAYMENT', amount: -250, category: 'Credit Card Payment' },
      { date: `${m}-21`, description: 'Plaid card pmt', amount: -125, category: 'Credit Card' },
      { date: `${m}-22`, description: 'Refund', amount: 20, category: 'Groceries' },
    ]);
  }

  test('dashboard: negative-stored Income adds to income, card payments are not expenses', () => {
    const db = createTestDb();
    seedCash(db);
    const row = apiCashflowMonthly(db, new URLSearchParams()).find((r) => r.month === m)!;
    expect(row.income).toBe(3000 + 1500 + 20);
    expect(row.expenses).toBe(400);
  });

  test('parity with the dashboard P&L and savings cards for the same month', () => {
    const db = createTestDb();
    seedCash(db);
    const row = apiCashflowMonthly(db, new URLSearchParams()).find((r) => r.month === m)!;
    const pnl = apiPnl(db, new URLSearchParams({ month: m }));
    expect(row.income).toBe(pnl.totalIncome);
    expect(row.expenses).toBe(-pnl.totalExpenses);
    const savings = apiSavings(db, new URLSearchParams({ months: '24' })).find((r) => r.month === m)!;
    expect(row.income).toBe(savings.income);
    expect(row.expenses).toBe(savings.expenses);
  });

  test('CLI / no-rules caller keeps the historical classification byte-for-byte', () => {
    const db = createTestDb();
    seedCash(db);
    const row = getMonthlyCashflowData(db).find((r) => r.month === m)!;
    // Legacy: income = SUM(amount) over (amount > 0 OR Income) → 3000 - 1500 + 20.
    expect(row.income).toBe(1520);
    // Legacy: expenses exclude only Income/Transfer → card payments count.
    expect(row.expenses).toBe(400 + 250 + 125);
    expect(Object.keys(row).sort()).toEqual(['expenses', 'income', 'month']);
  });
});

// ── L4: dashboard semantic search uses the dashboard filter semantics ───────

describe('L4 — semantic search category/entity semantics', () => {
  function seedSearch(db: Database): { biz: number; def: number } {
    insertTransactions(db, [
      { date: '2026-01-15', description: 'coffee null category', amount: -5 },
      { date: '2026-01-15', description: 'coffee blank category', amount: -5, category: '' },
      { date: '2026-01-15', description: 'coffee dining', amount: -5, category: 'Dining' },
    ]);
    const biz = createEntity(db, { name: 'Biz' });
    db.prepare(`UPDATE transactions SET entity_id = @id WHERE description = 'coffee dining'`).run({ id: biz });
    const rows = getTransactions(db) as Array<{ id: number; description: string; merchant_name: string | null }>;
    upsertEmbeddings(
      db,
      rows.map((t) => ({
        sourceType: 'transaction' as const,
        sourceId: t.id,
        model: DEFAULT_EMBEDDING_MODEL,
        vec: fakeEmbedText(transactionEmbedText({ merchant_name: t.merchant_name, description: t.description })),
      }))
    );
    return { biz, def: defaultEntityId(db) };
  }

  const descs = (rows: Array<Record<string, unknown>>) => rows.map((r) => r.description as string).sort();

  test("dashboard: category=Uncategorized matches NULL and blank rows", async () => {
    const db = createTestDb();
    seedSearch(db);
    const res = await apiSemanticSearch(db, new URLSearchParams({ q: 'coffee', category: 'Uncategorized' }), createFakeEmbedder().embed);
    expect(descs(res.results)).toEqual(['coffee blank category', 'coffee null category']);
  });

  test('dashboard: the default entity owns NULL-entity rows', async () => {
    const db = createTestDb();
    const { def, biz } = seedSearch(db);
    const res = await apiSemanticSearch(db, new URLSearchParams({ q: 'coffee', entityId: String(def) }), createFakeEmbedder().embed);
    expect(descs(res.results)).toEqual(['coffee blank category', 'coffee null category']);
    const bizRes = await apiSemanticSearch(db, new URLSearchParams({ q: 'coffee', entityId: String(biz) }), createFakeEmbedder().embed);
    expect(descs(bizRes.results)).toEqual(['coffee dining']);
  });

  test('no-rules caller (CLI tool path) keeps exact matching', () => {
    const db = createTestDb();
    const { def } = seedSearch(db);
    const q = fakeEmbedText('coffee');
    expect(searchTransactionsSemantic(db, q, { category: 'Uncategorized' }, 10)).toHaveLength(0);
    expect(searchTransactionsSemantic(db, q, { entityId: def }, 10)).toHaveLength(0);
  });
});

// ── L5: dashboard alert text uses thousands separators ──────────────────────

describe('L5 — /api/alerts money formatting', () => {
  function seedAlerts(db: Database): void {
    const utcMonth = new Date().toISOString().slice(0, 7);
    setBudget(db, 'Groceries', 100);
    insertTransactions(db, [
      { date: `${utcMonth}-01`, description: 'Warehouse club', amount: -1135, category: 'Groceries' },
      { date: daysAgo(1), description: 'Annual software', amount: -1234.56, category: 'Software', is_recurring: 1 },
    ]);
  }

  test('dashboard messages: $1,035 and $1,234.56', () => {
    const db = createTestDb();
    seedAlerts(db);
    const messages = apiAlerts(db).map((a) => a.message);
    expect(messages).toContain('Groceries budget exceeded by $1,035 (1135% used)');
    expect(messages).toContain('New recurring charge: Annual software $1,234.56/mo');
  });

  test('CLI / reports keep the historical text', () => {
    const db = createTestDb();
    seedAlerts(db);
    const messages = checkAlerts(db).map((a) => a.message);
    expect(messages).toContain('Groceries budget exceeded by $1035 (1135% used)');
    expect(messages).toContain('New recurring charge: Annual software $1234.56/mo');
  });
});

// ── L7: streak / weekly honor entityId; by-institution uses dashboard rules ─

describe('L7 — entity-scoped streak/weekly and dashboard by-institution', () => {
  function seedEntity(db: Database): { biz: number; def: number } {
    insertTransactions(db, [
      { date: daysAgo(0), description: 'Biz lunch', amount: -400, category: 'Dining', bank: 'Chase' },
      { date: daysAgo(0), description: 'Home groceries', amount: -10, category: 'Groceries', bank: 'Amex' },
      { date: daysAgo(1), description: 'CARD PAYMENT', amount: -900, category: 'Credit Card', bank: 'Chase' },
      { date: daysAgo(1), description: 'Blank cat', amount: -3, category: '', bank: 'Amex' },
    ]);
    const biz = createEntity(db, { name: 'Biz' });
    db.prepare(`UPDATE transactions SET entity_id = @id WHERE description = 'Biz lunch'`).run({ id: biz });
    setBudget(db, 'Dining', 3000); // ~$100/day all-budgets daily budget
    return { biz, def: defaultEntityId(db) };
  }

  test('weekly summary: ?entityId scopes the totals (default entity owns NULL rows)', () => {
    const db = createTestDb();
    const { biz, def } = seedEntity(db);
    const all = apiWeeklySummary(db);
    const bizWeek = apiWeeklySummary(db, new URLSearchParams({ entityId: String(biz) }));
    const defWeek = apiWeeklySummary(db, new URLSearchParams({ entityId: String(def) }));
    expect(bizWeek.thisWeek.total + defWeek.thisWeek.total).toBe(all.thisWeek.total);
    expect(bizWeek.thisWeek.byCategory.map((c) => c.category)).not.toContain('Groceries');
    expect(defWeek.thisWeek.byCategory.map((c) => c.category)).not.toContain('Dining');
    // CLI callers (no opts) are unchanged.
    expect(getWeeklySummary(db)).toEqual(getWeeklySummary(db, undefined, undefined));
  });

  test('streak: ?entityId scopes the days; the daily budget stays all-budgets', () => {
    const db = createTestDb();
    const { biz, def } = seedEntity(db);
    const bizStreak = apiStreak(db, new URLSearchParams({ entityId: String(biz) }));
    const defStreak = apiStreak(db, new URLSearchParams({ entityId: String(def) }));
    expect(bizStreak.dailyBudget).toBe(apiStreak(db).dailyBudget);
    // Today: biz spent $400 (> budget) → streak 0; default spent $10 → streak > 0.
    expect(bizStreak.current).toBe(0);
    expect(defStreak.current).toBeGreaterThan(0);
    expect(apiStreak(db)).toEqual(getStreak(db, undefined, undefined, { excludeNonSpend: true, normalizedIncome: true, labelGrouping: true, uncategorizedMatchesBlank: true, defaultEntityIncludesNull: true }));
  });

  test('mirror parity for entity-scoped streak and weekly summary', async () => {
    const db = createTestDb();
    const { biz, def } = seedEntity(db);
    const mirror = await mirrorOf(db);
    for (const id of [biz, def]) {
      const q = new URLSearchParams({ entityId: String(id) });
      expect(await serveApiPath(mirror, `/api/streak?${q}`)).toEqual(apiStreak(db, q));
      expect(await serveApiPath(mirror, `/api/weekly-summary?${q}`)).toEqual(apiWeeklySummary(db, q));
    }
  });

  test('UI paths send only the entity', () => {
    expect(entityScopedPath('/api/streak', null)).toBe('/api/streak');
    expect(entityScopedPath('/api/weekly-summary', 4)).toBe('/api/weekly-summary?entityId=4');
  });

  test('spending-by-institution: SPEND rule, Uncategorized matches blank, entityId honored', () => {
    const db = createTestDb();
    const { biz } = seedEntity(db);
    const range = { startDate: daysAgo(3), endDate: daysAgo(0) };
    const all = apiSpendingByInstitution(db, new URLSearchParams(range));
    const chase = all.find((r) => r.institution === 'Chase')!;
    expect(chase.total).toBe(-400); // the -900 card payment is not spending
    const uncat = apiSpendingByInstitution(db, new URLSearchParams({ ...range, category: 'Uncategorized' }));
    expect(uncat).toEqual([{ institution: 'Amex', total: -3, count: 1 }]);
    const bizOnly = apiSpendingByInstitution(db, new URLSearchParams({ ...range, entityId: String(biz) }));
    expect(bizOnly).toEqual([{ institution: 'Chase', total: -400, count: 1 }]);
  });
});

// ── L6: budget limits prorate partial months by day ─────────────────────────

describe('L6 — prorated range budgets', () => {
  test('a 2-day range across a month boundary scales the limit by days, not 2×', () => {
    const db = createTestDb();
    setBudget(db, 'Groceries', 310);
    const rows = apiBudgets(db, new URLSearchParams({ startDate: '2026-01-31', endDate: '2026-02-01' }));
    const g = rows.find((r) => r.category === 'Groceries')!;
    expect(g.months).toBeCloseTo(1 / 31 + 1 / 28, 12);
    expect(g.limit).toBeCloseTo(310 * (1 / 31 + 1 / 28), 9);
    expect(g.monthly_limit).toBe(310);
  });

  test('whole months stay exact', () => {
    const db = createTestDb();
    setBudget(db, 'Groceries', 300);
    const g = apiBudgets(db, new URLSearchParams({ startDate: '2026-01-01', endDate: '2026-03-31' })).find(
      (r) => r.category === 'Groceries'
    )!;
    expect(g.months).toBe(3);
    expect(g.limit).toBe(900);
  });

  test('BudgetBars label exposes the scaling', () => {
    expect(budgetLimitScaleLabel([])).toBeUndefined();
    expect(budgetLimitScaleLabel([{ months: undefined }])).toBeUndefined();
    expect(budgetLimitScaleLabel([{ months: 1 }])).toBe('Monthly limits');
    expect(budgetLimitScaleLabel([{ months: 3 }])).toBe('Limits × 3 months (prorated by day)');
    expect(budgetLimitScaleLabel([{ months: 1 / 31 + 1 / 28 }])).toBe('Limits × 0.07 months (prorated by day)');
    expect(budgetLimitScaleLabel([{ months: 9 + 2 / 31 }])).toBe('Limits × 9.06 months (prorated by day)');
  });
});

// ── L2: BudgetBars takeaway counts by `over`, not rounded percent ───────────

describe('L2 — budget takeaway', () => {
  test('a row that rounds to 100% but is over counts as over', () => {
    // actual 100.40 / limit 100 → percent_used rounds to 100, over = true.
    expect(budgetTakeaway([{ over: true }, { over: false }])).toBe('1 of 2 budgets over limit.');
    expect(budgetTakeaway([{ over: false }])).toBe('All 1 budgets within limit.');
    expect(budgetTakeaway([])).toBeUndefined();
  });
});

// ── L1: ChartCard Table toggle ──────────────────────────────────────────────

describe('L1 — ChartCard table toggle', () => {
  test('accessible name names the chart', () => {
    expect(tableToggleLabel('Spending Heatmap')).toBe('Show Spending Heatmap as table');
  });

  test('resets when the table can no longer be shown', () => {
    expect(nextShowTable(true, false)).toBe(false);
    expect(nextShowTable(true, true)).toBe(true);
    expect(nextShowTable(false, true)).toBe(false);
  });
});

// ── L3: heatmap tally window and filtered view ──────────────────────────────

describe('L3 — heatmap tally', () => {
  const now = new Date(2026, 8, 30, 12); // Wed Sep 30 2026, local

  test('the tally never exceeds 365 days even though the grid starts on a Sunday', () => {
    const { startDate, endDate } = heatmapYearRange(now);
    const grid = buildHeatmapGrid({ startDate, endDate, spending: new Map(), dailyBudget: 50, now });
    const drawn = grid.weeks.flat().filter((d) => !d.future).length;
    expect(drawn).toBeGreaterThan(TALLY_DAYS); // Sunday lead-in days are drawn…
    expect(grid.totalDays).toBe(TALLY_DAYS); // …but not counted
    expect(grid.underBudgetDays).toBe(TALLY_DAYS);
  });

  test('filtered views hide the all-budgets under-budget tally', () => {
    expect(isFilteredHeatmap({ accountId: null, entityId: null, category: null })).toBe(false);
    expect(isFilteredHeatmap({ accountId: 2, entityId: null, category: null })).toBe(true);
    expect(isFilteredHeatmap({ accountId: null, entityId: 1, category: null })).toBe(true);
    expect(isFilteredHeatmap({ accountId: null, entityId: null, category: 'Dining' })).toBe(true);

    const grid = { underBudgetDays: 300, totalDays: 365 };
    const plain = heatmapSummary(grid, '$50.00', false);
    expect(plain.tally).toEqual({ under: 300, total: 365 });
    expect(plain.takeaway).toBe('Under the $50.00 daily budget on 300 of 365 days with imported data.');
    const filtered = heatmapSummary(grid, '$50.00', true);
    expect(filtered.tally).toBeNull();
    expect(filtered.takeaway).not.toContain('300');
    expect(heatmapSummary({ underBudgetDays: 0, totalDays: 0 }, '$50.00', false).tally).toBeNull();
  });
});
