import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createTestDb } from './helpers.js';
import { seedDrillFixture, type DrillFixture } from './spending-drill-fixtures.js';
import { apiSpendingBreakdown, apiSpendingSeries, apiTransactions } from '../dashboard/api.js';
import {
  composeBreakdownSql,
  detailedLabel,
  roundMoney,
  type SpendingBreakdownResult,
  type SpendingSeriesResult,
} from '../db/spending-drill-sql.js';
import {
  isBadRequest,
  MAX_CAT_LEN,
  MAX_MERCHANT_LEN,
  parseSpendingBreakdownParams,
  parseSpendingSeriesParams,
} from '../dashboard/spending-params.js';
import { computeCompareWindow } from '../db/compare-window.js';
import { getSpendingSummary, getTransactions, insertTransactions } from '../db/queries.js';
import { mirroredHttpErrorMessage } from '../dashboard/ui/src/store/offline-writes.js';
import { startDashboardServer, stopDashboardServer } from '../dashboard/server.js';
import { closeAll, setInitialProfile } from '../dashboard/db-manager.js';

// GET /api/spending/breakdown + /api/spending/series (src/db/spending-drill-sql.ts)
// on the seeded drill fixture. Server-vs-mirror parity lives in
// spending-drill-parity.test.ts.

const fx: DrillFixture = seedDrillFixture();
const MAY = 'startDate=2026-05-01&endDate=2026-05-31';

async function breakdown(query: string): Promise<SpendingBreakdownResult> {
  const r = await apiSpendingBreakdown(fx.db, new URLSearchParams(query));
  if (isBadRequest(r)) throw new Error(`unexpected 400: ${r.error}`);
  return r;
}

async function series(query: string): Promise<SpendingSeriesResult> {
  const r = await apiSpendingSeries(fx.db, new URLSearchParams(query));
  if (isBadRequest(r)) throw new Error(`unexpected 400: ${r.error}`);
  return r;
}

describe('breakdown L1 — by category', () => {
  test('ranked category totals as positive spend, one Uncategorized bucket, non-spend excluded', async () => {
    const r = await breakdown(`${MAY}&limit=50`);
    expect(r.by).toBe('category');
    expect(r.rows.map((x) => [x.key, x.total, x.count])).toEqual([
      ['Travel', 200, 1],
      ['Dining', 125, 5],
      ['Groceries', 60.5, 1], // the +12.50 refund is not spend
      ['Shopping', 30, 1],
      ['Uncategorized', 12.75, 3], // NULL + '' + literal 'Uncategorized'
      ['Other', 1, 1], // a REAL category named Other is just a row
    ]);
    expect(r.total).toBe(429.25);
    expect(r.count).toBe(12);
    expect(r.groupCount).toBe(6);
    // Income (incl. the negative-stored paycheck), Credit Card and Transfer are never rows.
    expect(r.rows.some((x) => ['Income', 'Credit Card', 'Transfer'].includes(x.key))).toBe(false);
    expect(r.rows.find((x) => x.key === 'Dining')!.last).toBe('2026-05-16');
    expect(r.rows.every((x) => x.label === x.key)).toBe(true);
  });

  test('excludedTotal = transfers & card payments only (not the negative-stored paycheck)', async () => {
    const r = await breakdown(MAY);
    expect(r.excludedTotal).toBe(350);
  });

  test('no comparison requested → prevTotal null everywhere', async () => {
    const r = await breakdown(MAY);
    expect(r.prevTotal).toBeNull();
    expect(r.rows.every((x) => x.prevTotal === null)).toBe(true);
  });

  test('hasDetailed across the whole filtered set', async () => {
    expect((await breakdown(MAY)).hasDetailed).toBe(true);
  });
});

describe('breakdown — limit / offset / other*', () => {
  test('default limit is 12', async () => {
    const q = parseSpendingBreakdownParams(new URLSearchParams(MAY));
    expect(isBadRequest(q) ? null : q.limit).toBe(12);
  });

  test('limit=2: the rest rolls into otherTotal / otherCount (groups) / otherTxnCount', async () => {
    const r = await breakdown(`${MAY}&limit=2`);
    expect(r.rows.map((x) => x.key)).toEqual(['Travel', 'Dining']);
    expect(r.otherTotal).toBe(104.25);
    expect(r.otherCount).toBe(4);
    expect(r.otherTxnCount).toBe(6);
    expect(r.total).toBe(429.25); // totals always cover every group
    expect(r.groupCount).toBe(6);
  });

  test('offset pages through the same ranking; other* covers only groups after the page', async () => {
    const r = await breakdown(`${MAY}&limit=2&offset=2`);
    expect(r.rows.map((x) => x.key)).toEqual(['Groceries', 'Shopping']);
    expect(r.otherTotal).toBe(13.75);
    expect(r.otherCount).toBe(2);
    expect(r.otherTxnCount).toBe(4);
  });

  test('past the end: empty page, nothing after it', async () => {
    const r = await breakdown(`${MAY}&limit=5&offset=10`);
    expect(r.rows).toEqual([]);
    expect(r.otherTotal).toBe(0);
    expect(r.otherCount).toBe(0);
  });

  test('page rows + otherTotal = total when offset is 0', async () => {
    const r = await breakdown(`${MAY}&limit=3`);
    expect(roundMoney(r.rows.reduce((s, x) => s + x.total, 0) + r.otherTotal)).toBe(r.total);
  });
});

describe('breakdown L2 — cat=X groups by merchant key', () => {
  test('merchant key = trimmed merchant_name, else description', async () => {
    const r = await breakdown(`${MAY}&cat=Dining`);
    expect(r.by).toBe('merchant');
    expect(r.rows.map((x) => [x.key, x.total, x.count, x.last])).toEqual([
      ['Fancy Bistro', 80, 1, '2026-05-04'], // blank merchant_name falls back to description
      ['Chipotle', 27.75, 2, '2026-05-03'], // two descriptions, one merchant_name
      ['KFC', 9.75, 1, '2026-05-05'], // NULL merchant_name → description
      ["Joe's Diner", 7.5, 1, '2026-05-16'], // quote-safe (parameterized)
    ]);
    expect(r.total).toBe(125);
    expect(r.excludedTotal).toBe(0);
  });

  test('cat=Uncategorized matches NULL, blank and the literal label', async () => {
    const r = await breakdown(`${MAY}&cat=Uncategorized`);
    expect(r.rows.map((x) => [x.key, x.total])).toEqual([
      ['Mystery', 5],
      ['Blank cat', 4.5],
      ['Literal', 3.25],
    ]);
    expect(r.total).toBe(12.75);
  });

  test('a non-spend category drills to nothing (but reports its excluded outflow)', async () => {
    const r = await breakdown(`${MAY}&cat=Credit%20Card`);
    expect(r.rows).toEqual([]);
    expect(r.total).toBe(0);
    expect(r.excludedTotal).toBe(250);
  });

  test('by=detailed groups by category_detailed with humanized PFC labels; hasDetailed', async () => {
    const r = await breakdown(`${MAY}&cat=Dining&by=detailed`);
    expect(r.by).toBe('detailed');
    expect(r.rows.map((x) => [x.key, x.label, x.total])).toEqual([
      ['FOOD_AND_DRINK_RESTAURANT', 'Restaurant', 87.5],
      ['FOOD_AND_DRINK_FAST_FOOD', 'Fast Food', 27.75],
      ['', 'No detail', 9.75],
    ]);
    expect(r.hasDetailed).toBe(true);
  });

  test('hasDetailed is false with ≤ 1 distinct non-blank category_detailed', async () => {
    expect((await breakdown(`${MAY}&cat=Groceries`)).hasDetailed).toBe(false); // none
    expect((await breakdown(`${MAY}&cat=Travel`)).hasDetailed).toBe(false); // exactly one
  });

  test('explicit by=category under a cat collapses to the one category', async () => {
    const r = await breakdown(`${MAY}&cat=Dining&by=category`);
    expect(r.rows.map((x) => x.key)).toEqual(['Dining']);
  });
});

describe('breakdown L3 — merchant is EXACT (merchantExact), never fuzzy', () => {
  test('merchant key matches every row of that merchant ("all Chipotle", no cat)', async () => {
    const r = await breakdown('merchant=Chipotle');
    expect(r.total).toBe(55.75);
    expect(r.count).toBe(4);
    expect(r.rows.map((x) => [x.key, x.total])).toEqual([['Dining', 55.75]]);
  });

  test('a merchant prefix matches nothing (the fuzzy LIKE would have matched)', async () => {
    const r = await breakdown('merchant=Chip');
    expect(r.total).toBe(0);
    expect(r.rows).toEqual([]);
    // Contrast: the legacy fuzzy filter DOES match — the drill must never use it.
    expect(getTransactions(fx.db, { merchant: 'CHIP' }).length).toBeGreaterThan(0);
  });

  test('merchant key from a description fallback round-trips', async () => {
    const r = await breakdown(`${MAY}&cat=Dining&merchant=Fancy%20Bistro`);
    expect(r.total).toBe(80);
  });
});

describe('breakdown — account / entity scope', () => {
  test('accountId', async () => {
    const r = await breakdown(`${MAY}&accountId=${fx.accountId}`);
    expect(r.total).toBe(200);
    expect(r.rows.map((x) => x.key)).toEqual(['Travel']);
  });

  test('the default entity includes NULL-entity rows and its explicit rows', async () => {
    const r = await breakdown(`${MAY}&entityId=${fx.defaultEntityId}&limit=50`);
    expect(r.total).toBe(399.25); // everything except the Side Business Shopping row
    expect(r.rows.map((x) => x.key)).toContain('Travel'); // explicit default row
    expect(r.rows.map((x) => x.key)).toContain('Dining'); // NULL-entity rows
    expect(r.rows.map((x) => x.key)).not.toContain('Shopping');
  });

  test('a non-default entity sees only its own rows', async () => {
    const r = await breakdown(`${MAY}&entityId=${fx.bizEntityId}`);
    expect(r.total).toBe(30);
    expect(r.rows.map((x) => x.key)).toEqual(['Shopping']);
  });
});

describe('breakdown — comparison window', () => {
  test('covered comparison: prevTotal per key (0 when the key had no spend there)', async () => {
    const r = await breakdown(`${MAY}&compareStart=2026-03-01&compareEnd=2026-03-31`);
    expect(r.prevTotal).toBe(10);
    const prev = Object.fromEntries(r.rows.map((x) => [x.key, x.prevTotal]));
    expect(prev).toEqual({ Travel: 0, Dining: 10, Groceries: 0, Shopping: 0, Uncategorized: 0, Other: 0 });
  });

  test('comparison window in a gap month (no imports) → null, distinct from 0', async () => {
    const r = await breakdown(`${MAY}&compareStart=2026-04-01&compareEnd=2026-04-30`);
    expect(r.prevTotal).toBeNull();
    expect(r.rows.every((x) => x.prevTotal === null)).toBe(true);
  });

  test('comparison window before the first import → null', async () => {
    const r = await breakdown(`${MAY}&compareStart=2025-05-01&compareEnd=2025-05-31`);
    expect(r.prevTotal).toBeNull();
  });

  test('covered window with no spend for the filter → 0, not null', async () => {
    const r = await breakdown(`startDate=2026-03-01&endDate=2026-03-31&cat=Dining&compareStart=2026-02-01&compareEnd=2026-02-28`);
    expect(r.prevTotal).toBe(0);
    expect(r.rows[0].prevTotal).toBe(0);
  });

  test('PARTIAL period: June-to-date (3 days) compares against May 1–3, not all of May', async () => {
    const window = computeCompareWindow({ start: '2026-06-01', end: '2026-06-30' }, 'prev', '2026-06-03')!;
    expect(window).toMatchObject({ start: '2026-05-01', end: '2026-05-03', partial: true });
    const r = await breakdown(
      `startDate=2026-06-01&endDate=2026-06-30&compareStart=${window.start}&compareEnd=${window.end}`
    );
    expect(r.total).toBe(8);
    expect(r.prevTotal).toBe(27.75); // 05-02 + 05-03 only (full May would be 429.25)
    expect(r.rows).toEqual([
      { key: 'Dining', label: 'Dining', total: 8, count: 1, last: '2026-06-01', prevTotal: 27.75 },
    ]);
  });

  test('per-key prevTotal honors the other filters (cat + entity)', async () => {
    const r = await breakdown(
      `${MAY}&cat=Dining&entityId=${fx.defaultEntityId}&compareStart=2026-01-01&compareEnd=2026-01-31`
    );
    expect(r.prevTotal).toBe(20);
    expect(r.rows.find((x) => x.key === 'Chipotle')!.prevTotal).toBe(20);
    expect(r.rows.find((x) => x.key === 'KFC')!.prevTotal).toBe(0);
  });
});

describe('series — null outside coverage, 0 inside', () => {
  test('explicit window: gap month null, covered months summed', async () => {
    const r = await series('startDate=2026-01-01&endDate=2026-06-30');
    expect(r.periods).toEqual(['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06']);
    expect(r.values).toEqual([70, 40, 10, null, 429.25, 8]);
    expect(r.coverageStart).toBe('2026-01-10');
    expect(r.coverageEnd).toBe('2026-06-01');
  });

  test('a filtered month with no spend inside coverage is 0', async () => {
    const r = await series('startDate=2026-01-01&endDate=2026-06-30&cat=Dining');
    expect(r.values).toEqual([20, 0, 10, null, 125, 8]);
  });

  test('months before the first import are null; coverage stays UNFILTERED', async () => {
    const r = await series(`startDate=2025-11-01&endDate=2026-06-30&entityId=${fx.bizEntityId}`);
    expect(r.values).toEqual([null, null, 0, 0, 0, null, 30, 0]);
  });

  test('merchant (exact) series', async () => {
    const r = await series('startDate=2026-01-01&endDate=2026-06-30&merchant=Chipotle');
    expect(r.values).toEqual([20, 0, 0, null, 27.75, 8]);
  });

  test('window edges clip the first/last month to the given days', async () => {
    const r = await series('startDate=2026-05-10&endDate=2026-06-30');
    expect(r.periods).toEqual(['2026-05', '2026-06']);
    expect(r.values).toEqual([238.5, 8]);
  });

  test('no dates → trailing 12 months ending at the coverage end month', async () => {
    const r = await series('');
    expect(r.periods).toHaveLength(12);
    expect(r.periods[0]).toBe('2025-07');
    expect(r.periods[11]).toBe('2026-06');
    expect(r.values).toEqual([null, null, null, null, null, null, 70, 40, 10, null, 429.25, 8]);
  });

  test('nothing imported → empty series, null coverage', async () => {
    const empty = createTestDb();
    const r = await apiSpendingSeries(empty, new URLSearchParams(''));
    expect(r).toEqual({ periods: [], values: [], coverageStart: null, coverageEnd: null });
    const withDates = await apiSpendingSeries(empty, new URLSearchParams('startDate=2026-01-01&endDate=2026-02-28'));
    expect(withDates).toEqual({ periods: ['2026-01', '2026-02'], values: [null, null], coverageStart: null, coverageEnd: null });
  });
});

describe('param validation — bad params are 400, never 500', () => {
  const badBreakdown = [
    'by=vendor',
    'limit=0',
    'limit=201',
    'limit=abc',
    'limit=1.5',
    'offset=-1',
    'offset=x',
    'startDate=2026-13-01',
    'startDate=2026-02-30',
    'startDate=05/01/2026',
    'startDate=2026-05-31&endDate=2026-05-01',
    'compareStart=2026-04-01',
    'compareEnd=2026-04-30',
    'compareStart=2026-04-30&compareEnd=2026-04-01',
    'compareStart=nope&compareEnd=2026-04-30',
    'accountId=abc',
    'accountId=-3',
    'entityId=0',
    `cat=${'x'.repeat(MAX_CAT_LEN + 1)}`,
    `merchant=${'x'.repeat(MAX_MERCHANT_LEN + 1)}`,
  ];
  test.each(badBreakdown)('breakdown ?%s → BadRequest', async (query) => {
    const r = await apiSpendingBreakdown(fx.db, new URLSearchParams(query));
    expect(isBadRequest(r)).toBe(true);
  });

  const badSeries = [
    'interval=week',
    'startDate=2026-01-01',
    'endDate=2026-01-31',
    'startDate=2010-01-01&endDate=2026-12-31', // > 120 months
    'startDate=2026-06-01&endDate=2026-01-01',
    'entityId=1e3',
  ];
  test.each(badSeries)('series ?%s → BadRequest', async (query) => {
    const r = await apiSpendingSeries(fx.db, new URLSearchParams(query));
    expect(isBadRequest(r)).toBe(true);
  });

  test('empty params are treated as absent (not errors)', () => {
    const q = parseSpendingBreakdownParams(new URLSearchParams('cat=&merchant=&by=&limit=&offset=&accountId='));
    expect(q).toEqual({ by: 'category', limit: 12, offset: 0 });
    expect(parseSpendingSeriesParams(new URLSearchParams('interval=month'))).toEqual({ interval: 'month' });
  });

  test('mirrored BadRequest becomes the same "API 400" message the online seam throws', () => {
    expect(mirroredHttpErrorMessage({ status: 400, error: 'by must be one of category, merchant, detailed' })).toBe(
      'API 400: {"error":"by must be one of category, merchant, detailed"}'
    );
    expect(mirroredHttpErrorMessage({ status: 400, error: 'x', rows: [] })).toBeNull(); // data, not an error
    expect(mirroredHttpErrorMessage({ error: 'startDate and endDate required' })).toBeNull(); // legacy 200 shape
    expect(mirroredHttpErrorMessage([])).toBeNull();
  });
});

describe('long keys drill (never a 400 on real data)', () => {
  test('a 1,000-character description is a merchant key the drill accepts end to end', async () => {
    const db = createTestDb();
    const longDesc = `POS PURCHASE ${'ACME WIDGETS INTERNATIONAL '.repeat(40)}`.slice(0, 1000);
    const longCat = `Household ${'and garden '.repeat(30)}`.trim();
    insertTransactions(db, [{ date: '2026-05-02', description: longDesc, amount: -42, category: longCat }]);
    const l1 = await apiSpendingBreakdown(db, new URLSearchParams(MAY));
    if (isBadRequest(l1)) throw new Error(l1.error);
    const cat = l1.rows[0].key;
    expect(cat).toBe(longCat);
    const l2 = await apiSpendingBreakdown(db, new URLSearchParams({ startDate: '2026-05-01', endDate: '2026-05-31', cat }));
    if (isBadRequest(l2)) throw new Error(l2.error);
    expect(l2.rows[0].key).toBe(longDesc);
    const l3 = await apiSpendingBreakdown(
      db,
      new URLSearchParams({ startDate: '2026-05-01', endDate: '2026-05-31', cat, merchant: l2.rows[0].key }),
    );
    if (isBadRequest(l3)) throw new Error(l3.error);
    expect(l3).toMatchObject({ total: 42, count: 1 });
    expect(MAX_MERCHANT_LEN).toBeGreaterThanOrEqual(1000);
  });
});

describe('drill key = the TRIM\'d label at every level (dashboard only)', () => {
  const db = createTestDb();
  insertTransactions(db, [
    { date: '2026-05-02', description: 'Chipotle', amount: -10, category: ' Dining ' },
    { date: '2026-05-03', description: 'Chipotle', amount: -5, category: 'Dining' },
    { date: '2026-05-04', description: 'Blank-ish', amount: -2, category: '  ' },
    { date: '2026-05-05', description: 'Refund', amount: 1, category: ' Dining ' },
  ]);
  const q = (extra: Record<string, string>) =>
    new URLSearchParams({ startDate: '2026-05-01', endDate: '2026-05-31', ...extra });

  test("L1 groups ' Dining ' into 'Dining'; L2/L3 filtered by that key sum the same rows", async () => {
    const l1 = await apiSpendingBreakdown(db, q({}));
    if (isBadRequest(l1)) throw new Error(l1.error);
    const dining = l1.rows.find((r) => r.key === 'Dining')!;
    expect(dining).toMatchObject({ total: 15, count: 2 });
    const l2 = await apiSpendingBreakdown(db, q({ cat: 'Dining' }));
    if (isBadRequest(l2)) throw new Error(l2.error);
    expect(l2).toMatchObject({ total: 15, count: 2 });
    const l3 = await apiSpendingBreakdown(db, q({ cat: 'Dining', merchant: 'Chipotle' }));
    if (isBadRequest(l3)) throw new Error(l3.error);
    expect(l3).toMatchObject({ total: 15, count: 2 });
    const s = await apiSpendingSeries(db, q({ cat: 'Dining' }));
    if (isBadRequest(s)) throw new Error(s.error);
    expect(s.values).toEqual([15]);
  });

  test('the /api/transactions dashboard filter matches the same rows (spendOnly and not)', () => {
    const spend = apiTransactions(db, q({ category: 'Dining', spendOnly: '1' })) as { amount: number }[];
    expect(spend.map((t) => t.amount).sort()).toEqual([-10, -5]);
    const all = apiTransactions(db, q({ category: 'Dining' })) as { amount: number }[];
    expect(all).toHaveLength(3);
    const uncat = apiTransactions(db, q({ category: 'Uncategorized' })) as { description: string }[];
    expect(uncat.map((t) => t.description)).toEqual(['Blank-ish']);
  });

  test('the CLI category filter is unchanged (exact column match, untrimmed)', () => {
    expect(getTransactions(db, { category: 'Dining' }).map((t) => t.amount)).toEqual([-5]);
  });
});

describe('HTTP routes', () => {
  let server: Awaited<ReturnType<typeof startDashboardServer>>['server'];
  let base = '';

  beforeAll(async () => {
    const { db } = seedDrillFixture();
    setInitialProfile('test', db);
    server = (await startDashboardServer(db, 0)).server;
    base = `http://localhost:${server.port}`;
  });

  afterAll(() => {
    try {
      stopDashboardServer(server);
    } catch {
      /* already stopped */
    }
    closeAll();
  });

  test('GET /api/spending/breakdown → 200 JSON', async () => {
    const res = await fetch(`${base}/api/spending/breakdown?${MAY}&limit=1`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as SpendingBreakdownResult;
    expect(body.rows.map((x) => x.key)).toEqual(['Travel']);
  });

  test('GET /api/spending/series → 200 JSON', async () => {
    const res = await fetch(`${base}/api/spending/series?startDate=2026-03-01&endDate=2026-05-31`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as SpendingSeriesResult).values).toEqual([10, null, 429.25]);
  });

  test.each([
    '/api/spending/breakdown?limit=9999',
    '/api/spending/breakdown?by=x',
    '/api/spending/breakdown?startDate=garbage',
    '/api/spending/series?interval=day',
    '/api/spending/series?startDate=2026-01-01',
  ])('%s → 400 { error }', async (path) => {
    const res = await fetch(base + path);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(typeof body.error).toBe('string');
    expect(Object.keys(body)).toEqual(['error']);
  });
});

describe('dashboard-only: CLI semantics untouched', () => {
  test('the CLI spending summary still counts card payments / transfers as spending (legacy amount < 0)', () => {
    const rows = getSpendingSummary(fx.db, '2026-05-01', '2026-05-31');
    const cats = rows.map((r) => r.category);
    expect(cats).toContain('Credit Card');
    expect(cats).toContain('Transfer');
  });

  test('every drill statement carries the dashboard spend rule', () => {
    const q = parseSpendingBreakdownParams(new URLSearchParams(MAY));
    if (isBadRequest(q)) throw new Error('bad');
    const s = composeBreakdownSql(q);
    for (const stmt of [s.totals, s.page, s.rest, s.detailed]) {
      expect(stmt.sql).toContain("NOT IN ('Income', 'Transfer'");
    }
  });

  test('detailedLabel', () => {
    expect(detailedLabel('TRAVEL')).toBe('Travel');
    expect(detailedLabel('TRANSPORTATION_TAXIS_AND_RIDE_SHARES')).toBe('Taxis & Ride Shares');
    expect(detailedLabel('Coffee shops')).toBe('Coffee shops');
    expect(detailedLabel('')).toBe('No detail');
  });
});
