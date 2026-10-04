import { beforeAll, describe, expect, test } from 'bun:test';
import { Database } from '../db/compat-sqlite.js';
import { seedDrillFixture } from './spending-drill-fixtures.js';
import { createTestDb } from './helpers.js';
import { insertTransactions } from '../db/queries.js';
import {
  apiBudgetLimits,
  apiCategories,
  apiEntities,
  apiSpendingBreakdown,
  apiSpendingSeries,
  apiTransactions,
} from '../dashboard/api.js';
import { applySync, createMirrorSchema } from '../dashboard/ui/src/store/mirror-schema.js';
import { serveApiPath } from '../dashboard/ui/src/store/mirror-reads.js';
import { MirrorTestBinding } from './mirror-helpers.js';
import { isBadRequest } from '../dashboard/spending-params.js';
import type {
  MirrorBudgetRow,
  MirrorCategoryRow,
  MirrorEntityRow,
  MirrorTransactionRow,
} from '../dashboard/ui/src/store/types.js';

/**
 * Server-vs-mirror parity for the spending drill endpoints: for identical seed
 * data, serveApiPath over the local mirror must deep-equal the server handler
 * for every query — including the 400 BadRequest object for bad params. The
 * mirror is seeded from the server's own raw pulls (the sync-engine path).
 */

const fx = seedDrillFixture();
let mirror: MirrorTestBinding;

beforeAll(async () => {
  mirror = new MirrorTestBinding(new Database(':memory:'));
  await createMirrorSchema(mirror);
  await applySync(mirror, {
    profile: 'default',
    transactions: apiTransactions(fx.db, new URLSearchParams({ limit: String(10_000_000) })) as unknown as MirrorTransactionRow[],
    entities: apiEntities(fx.db) as unknown as MirrorEntityRow[],
    budgets: apiBudgetLimits(fx.db) as unknown as MirrorBudgetRow[],
    categories: apiCategories(fx.db) as unknown as MirrorCategoryRow[],
  });
});

const MAY = 'startDate=2026-05-01&endDate=2026-05-31';

describe('/api/spending/breakdown — mirror parity', () => {
  const queries = [
    '', // all time, defaults
    MAY,
    `${MAY}&limit=2`,
    `${MAY}&limit=2&offset=2`,
    `${MAY}&limit=5&offset=10`,
    `${MAY}&limit=200`,
    `${MAY}&cat=Dining`,
    `${MAY}&cat=Dining&by=detailed`,
    `${MAY}&cat=Dining&by=category`,
    `${MAY}&cat=Uncategorized`,
    `${MAY}&cat=Credit%20Card`,
    `${MAY}&cat=Groceries`,
    `${MAY}&by=merchant&limit=3`,
    `${MAY}&by=detailed`,
    'merchant=Chipotle',
    'merchant=Chip',
    `${MAY}&cat=Dining&merchant=Fancy%20Bistro`,
    `${MAY}&cat=Dining&merchant=Joe's%20Diner`,
    `${MAY}&accountId=${fx.accountId}`,
    `${MAY}&entityId=${fx.defaultEntityId}`,
    `${MAY}&entityId=${fx.bizEntityId}`,
    `${MAY}&compareStart=2026-03-01&compareEnd=2026-03-31`, // covered
    `${MAY}&compareStart=2026-04-01&compareEnd=2026-04-30`, // gap month → null
    `${MAY}&compareStart=2025-05-01&compareEnd=2025-05-31`, // before coverage → null
    `startDate=2026-06-01&endDate=2026-06-30&compareStart=2026-05-01&compareEnd=2026-05-03`, // partial same-days
    `${MAY}&cat=Dining&entityId=${fx.defaultEntityId}&compareStart=2026-01-01&compareEnd=2026-01-31`,
    'startDate=2030-01-01&endDate=2030-01-31', // empty range
    // Bad params: both sides return the identical BadRequest
    'by=vendor',
    'limit=0',
    'limit=201',
    'offset=-1',
    'startDate=2026-02-30',
    'startDate=2026-05-31&endDate=2026-05-01',
    'compareStart=2026-04-01',
    'accountId=abc',
  ];

  test.each(queries)('?%s', async (query) => {
    const fromServer = await apiSpendingBreakdown(fx.db, new URLSearchParams(query));
    const fromMirror = await serveApiPath(mirror, `/api/spending/breakdown?${query}`);
    expect(fromMirror).toEqual(fromServer);
  });

  test('the matrix exercises real data (not just empty results)', async () => {
    const r = await serveApiPath(mirror, `/api/spending/breakdown?${MAY}&compareStart=2026-03-01&compareEnd=2026-03-31`);
    expect(r).toMatchObject({ total: 429.25, prevTotal: 10, excludedTotal: 350 });
  });

  test('a bad param is the BadRequest shape on the mirror too', async () => {
    expect(isBadRequest(await serveApiPath(mirror, '/api/spending/breakdown?by=vendor'))).toBe(true);
  });
});

describe('/api/spending/series — mirror parity', () => {
  const queries = [
    '', // trailing 12 months at coverage end
    'startDate=2026-01-01&endDate=2026-06-30',
    'startDate=2025-11-01&endDate=2026-06-30',
    'startDate=2026-05-10&endDate=2026-06-30',
    'startDate=2026-01-01&endDate=2026-06-30&cat=Dining',
    'startDate=2026-01-01&endDate=2026-06-30&cat=Uncategorized',
    'startDate=2026-01-01&endDate=2026-06-30&merchant=Chipotle',
    `startDate=2026-01-01&endDate=2026-06-30&accountId=${fx.accountId}`,
    `startDate=2026-01-01&endDate=2026-06-30&entityId=${fx.defaultEntityId}`,
    `startDate=2025-11-01&endDate=2026-06-30&entityId=${fx.bizEntityId}`,
    'startDate=2026-01-01&endDate=2026-06-30&interval=month',
    // Bad params
    'interval=week',
    'startDate=2026-01-01',
    'startDate=2010-01-01&endDate=2026-12-31',
  ];

  test.each(queries)('?%s', async (query) => {
    const fromServer = await apiSpendingSeries(fx.db, new URLSearchParams(query));
    const fromMirror = await serveApiPath(mirror, `/api/spending/series?${query}`);
    expect(fromMirror).toEqual(fromServer);
  });

  test('the matrix exercises null-vs-0 coverage', async () => {
    const r = await serveApiPath(mirror, '/api/spending/series?startDate=2026-01-01&endDate=2026-06-30&cat=Dining');
    expect(r).toMatchObject({ values: [20, 0, 10, null, 125, 8] });
  });
});

describe("' Dining ' (untrimmed label) — server and mirror filter on the same TRIM'd key", () => {
  const db = createTestDb();
  insertTransactions(db, [
    { date: '2026-05-02', description: 'Chipotle', amount: -10, category: ' Dining ' },
    { date: '2026-05-03', description: 'Chipotle', amount: -5, category: 'Dining' },
    { date: '2026-05-04', description: 'Blank-ish', amount: -2, category: '  ' },
    { date: '2026-05-05', description: 'Refund', amount: 1, category: ' Dining ' },
  ]);
  let m: MirrorTestBinding;
  beforeAll(async () => {
    m = new MirrorTestBinding(new Database(':memory:'));
    await createMirrorSchema(m);
    await applySync(m, {
      profile: 'default',
      transactions: apiTransactions(db, new URLSearchParams({ limit: String(10_000_000) })) as unknown as MirrorTransactionRow[],
      entities: apiEntities(db) as unknown as MirrorEntityRow[],
      budgets: apiBudgetLimits(db) as unknown as MirrorBudgetRow[],
      categories: apiCategories(db) as unknown as MirrorCategoryRow[],
    });
  });

  const breakdowns = [MAY, `${MAY}&cat=Dining`, `${MAY}&cat=Dining&merchant=Chipotle`, `${MAY}&cat=Uncategorized`];
  test.each(breakdowns)('breakdown ?%s', async (query) => {
    const fromServer = await apiSpendingBreakdown(db, new URLSearchParams(query));
    expect(await serveApiPath(m, `/api/spending/breakdown?${query}`)).toEqual(fromServer);
  });

  test('L1 key, L2 total and series agree on both sides', async () => {
    const l1 = (await serveApiPath(m, `/api/spending/breakdown?${MAY}`)) as { rows: { key: string; total: number }[] };
    expect(l1.rows.find((r) => r.key === 'Dining')?.total).toBe(15);
    expect(await serveApiPath(m, `/api/spending/breakdown?${MAY}&cat=Dining`)).toMatchObject({ total: 15, count: 2 });
    const q = 'startDate=2026-05-01&endDate=2026-05-31&cat=Dining';
    const fromServer = await apiSpendingSeries(db, new URLSearchParams(q));
    expect(await serveApiPath(m, `/api/spending/series?${q}`)).toEqual(fromServer);
    expect(fromServer).toMatchObject({ values: [15] });
  });

  test('/api/transactions category filter (spendOnly) matches the same rows on both sides', async () => {
    const q = 'startDate=2026-05-01&endDate=2026-05-31&category=Dining&spendOnly=1';
    const fromServer = apiTransactions(db, new URLSearchParams(q)) as { amount: number }[];
    expect(fromServer.map((t) => t.amount).sort()).toEqual([-10, -5]);
    expect(await serveApiPath(m, `/api/transactions?${q}`)).toEqual(fromServer);
  });
});
