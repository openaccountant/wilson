import { describe, expect, test, beforeEach, afterEach, spyOn, mock } from 'bun:test';
import type { Database } from '../db/compat-sqlite.js';
import { initFireflyTool, fireflyImportTool } from '../tools/import/firefly.js';
import { getTransactions } from '../db/queries.js';
import { createTestDb } from './helpers.js';
import * as licenseModule from '../licensing/license.js';

/** Build a Firefly API response envelope. */
function makeFireflyResponse(
  splits: Array<{
    id: string;
    journal_id: string;
    type: string;
    date: string;
    amount: string;
    description: string;
    source_name?: string | null;
    destination_name?: string | null;
    category_name?: string | null;
    bill_name?: string | null;
    subscription_name?: string | null;
    tags?: string[];
    notes?: string | null;
  }>,
) {
  let groupId = 0;
  const data = splits.map((s) => ({
    type: 'transactions' as const,
    id: String(++groupId),
    attributes: {
      group_title: null,
      transactions: [
        {
          transaction_journal_id: s.journal_id,
          type: s.type,
          date: s.date,
          amount: s.amount,
          description: s.description,
          source_name: s.source_name ?? null,
          destination_name: s.destination_name ?? null,
          category_name: s.category_name ?? null,
          budget_name: null,
          bill_name: s.bill_name ?? null,
          tags: s.tags ?? [],
          notes: s.notes ?? null,
          internal_reference: null,
          external_url: null,
          subscription_name: s.subscription_name ?? null,
        },
      ],
    },
  }));
  return {
    data,
    meta: {
      pagination: {
        total: data.length,
        count: data.length,
        per_page: 50,
        current_page: 1,
        total_pages: 1,
      },
    },
  };
}

const SAMPLE_SPLITS = [
  {
    id: '1',
    journal_id: '101',
    type: 'withdrawal',
    date: '2026-01-03T00:00:00+00:00',
    amount: '42.67',
    description: 'Weekly groceries',
    destination_name: 'Corner Market',
    category_name: 'Groceries',
  },
  {
    id: '2',
    journal_id: '102',
    type: 'deposit',
    date: '2026-01-05T12:00:00+00:00',
    amount: '3200.00',
    description: 'Monthly payroll',
    source_name: 'Acme Corp',
    category_name: 'Income',
  },
  {
    id: '3',
    journal_id: '103',
    type: 'withdrawal',
    date: '2026-01-07T00:00:00+00:00',
    amount: '14.99',
    description: 'Streaming',
    destination_name: 'StreamCo',
    bill_name: 'StreamCo Subscription',
    tags: ['subscription', 'entertainment'],
  },
];

describe('firefly_import tool', () => {
  let db: Database;
  let licenseSpy: ReturnType<typeof spyOn>;
  let fetchSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    db = createTestDb();
    initFireflyTool(db);
    licenseSpy = spyOn(licenseModule, 'hasLicense').mockReturnValue(true);
    process.env.FIREFLY_API_URL = 'https://firefly.example.com';
    process.env.FIREFLY_API_TOKEN = 'test-token';
  });

  afterEach(() => {
    licenseSpy.mockRestore();
    fetchSpy?.mockRestore();
    delete process.env.FIREFLY_API_URL;
    delete process.env.FIREFLY_API_TOKEN;
  });

  function mockFetch(body: unknown, status = 200) {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/vnd.api+json' },
      }),
    );
  }

  test('imports withdrawals as negative amounts', async () => {
    mockFetch(makeFireflyResponse(SAMPLE_SPLITS));
    const raw = await fireflyImportTool.func({});
    const result = JSON.parse(raw as string);
    expect(result.data.success).toBe(true);
    expect(result.data.transactionsImported).toBe(3);

    const txns = getTransactions(db);
    const grocery = txns.find((t) => t.description === 'Corner Market');
    expect(grocery).toBeDefined();
    expect(grocery!.amount).toBe(-42.67);
    expect(grocery!.bank).toBe('firefly');
  });

  test('imports deposits as positive amounts', async () => {
    mockFetch(makeFireflyResponse(SAMPLE_SPLITS));
    await fireflyImportTool.func({});
    const txns = getTransactions(db);
    const payroll = txns.find((t) => t.description === 'Acme Corp');
    expect(payroll).toBeDefined();
    expect(payroll!.amount).toBe(3200);
  });

  test('withdrawal uses destination_name as description', async () => {
    mockFetch(makeFireflyResponse(SAMPLE_SPLITS));
    await fireflyImportTool.func({});
    const txns = getTransactions(db);
    expect(txns.some((t) => t.description === 'Corner Market')).toBe(true);
  });

  test('deposit uses source_name as description', async () => {
    mockFetch(makeFireflyResponse(SAMPLE_SPLITS));
    await fireflyImportTool.func({});
    const txns = getTransactions(db);
    expect(txns.some((t) => t.description === 'Acme Corp')).toBe(true);
  });

  test('date is normalized to YYYY-MM-DD', async () => {
    mockFetch(makeFireflyResponse(SAMPLE_SPLITS));
    await fireflyImportTool.func({});
    const txns = getTransactions(db);
    expect(txns.every((t) => /^\d{4}-\d{2}-\d{2}$/.test(t.date))).toBe(true);
  });

  test('recurring detected from bill_name', async () => {
    mockFetch(makeFireflyResponse(SAMPLE_SPLITS));
    await fireflyImportTool.func({});
    const txns = getTransactions(db);
    const streamCo = txns.find((t) => t.description === 'StreamCo');
    expect(streamCo!.is_recurring).toBe(1);
  });

  test('tags are joined as comma-separated string', async () => {
    mockFetch(makeFireflyResponse(SAMPLE_SPLITS));
    await fireflyImportTool.func({});
    const txns = getTransactions(db);
    const streamCo = txns.find((t) => t.description === 'StreamCo');
    expect(streamCo!.tags).toBe('subscription, entertainment');
  });

  test('external_id is set for dedup', async () => {
    mockFetch(makeFireflyResponse(SAMPLE_SPLITS));
    await fireflyImportTool.func({});
    const txns = getTransactions(db);
    const grocery = txns.find((t) => t.description === 'Corner Market');
    expect(grocery!.external_id).toBe('firefly:101');
  });

  test('transfers are skipped by default', async () => {
    const splits = [
      ...SAMPLE_SPLITS,
      {
        id: '4',
        journal_id: '104',
        type: 'transfer',
        date: '2026-01-10T00:00:00+00:00',
        amount: '500.00',
        description: 'Savings transfer',
      },
    ];
    mockFetch(makeFireflyResponse(splits));
    const raw = await fireflyImportTool.func({});
    const result = JSON.parse(raw as string);
    expect(result.data.transactionsImported).toBe(3);
    expect(result.data.skipped).toBe(1);
  });

  test('transfers are included when includeTransfers is true', async () => {
    const splits = [
      {
        id: '4',
        journal_id: '104',
        type: 'transfer',
        date: '2026-01-10T00:00:00+00:00',
        amount: '500.00',
        description: 'Savings transfer',
      },
    ];
    mockFetch(makeFireflyResponse(splits));
    const raw = await fireflyImportTool.func({ includeTransfers: true });
    const result = JSON.parse(raw as string);
    expect(result.data.transactionsImported).toBe(1);

    const txns = getTransactions(db);
    expect(txns[0].amount).toBe(-500);
  });

  test('reconciliation type is skipped', async () => {
    const splits = [
      {
        id: '5',
        journal_id: '105',
        type: 'reconciliation',
        date: '2026-01-15T00:00:00+00:00',
        amount: '0.01',
        description: 'Reconciliation',
      },
    ];
    mockFetch(makeFireflyResponse(splits));
    const raw = await fireflyImportTool.func({});
    const result = JSON.parse(raw as string);
    expect(result.data.transactionsImported).toBe(0);
    expect(result.data.skipped).toBe(1);
  });

  test('deduplication by external_id prevents re-import', async () => {
    mockFetch(makeFireflyResponse(SAMPLE_SPLITS));
    await fireflyImportTool.func({});

    // Re-import same data
    mockFetch(makeFireflyResponse(SAMPLE_SPLITS));
    const raw = await fireflyImportTool.func({});
    const result = JSON.parse(raw as string);
    expect(result.data.transactionsImported).toBe(0);
    expect(result.data.skipped).toBe(3);
  });

  test('empty response returns zero imports', async () => {
    mockFetch(makeFireflyResponse([]));
    const raw = await fireflyImportTool.func({});
    const result = JSON.parse(raw as string);
    expect(result.data.transactionsImported).toBe(0);
    expect(result.data.message).toContain('No transactions found');
  });

  test('API error returns error message', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('Unauthorized', { status: 401 }),
    );
    const raw = await fireflyImportTool.func({});
    const result = JSON.parse(raw as string);
    expect(result.data.error).toContain('Firefly API responded with 401');
  });

  test('missing env vars returns error', async () => {
    delete process.env.FIREFLY_API_URL;
    delete process.env.FIREFLY_API_TOKEN;
    const raw = await fireflyImportTool.func({});
    const result = JSON.parse(raw as string);
    expect(result.data.error).toContain('FIREFLY_API_URL');
  });

  test('license gate blocks without pro license', async () => {
    licenseSpy.mockReturnValue(false);
    const raw = await fireflyImportTool.func({});
    const result = JSON.parse(raw as string);
    expect(result.data.error).toContain('Pro feature');
  });

  test('date range is recorded in result', async () => {
    mockFetch(makeFireflyResponse(SAMPLE_SPLITS));
    const raw = await fireflyImportTool.func({});
    const result = JSON.parse(raw as string);
    expect(result.data.dateRange.start).toBe('2026-01-03');
    expect(result.data.dateRange.end).toBe('2026-01-07');
  });

  test('category is preserved from Firefly', async () => {
    mockFetch(makeFireflyResponse(SAMPLE_SPLITS));
    await fireflyImportTool.func({});
    const txns = getTransactions(db);
    const grocery = txns.find((t) => t.description === 'Corner Market');
    expect(grocery!.category).toBe('Groceries');
  });

  test('split transactions are imported individually', async () => {
    const response = {
      data: [
        {
          type: 'transactions',
          id: '5',
          attributes: {
            group_title: 'Office supplies split',
            transactions: [
              {
                transaction_journal_id: '105',
                type: 'withdrawal',
                date: '2026-01-12T00:00:00+00:00',
                amount: '89.50',
                description: 'Printer paper',
                source_name: 'Checking',
                destination_name: 'Office Depot',
                category_name: 'Office',
                budget_name: null,
                bill_name: null,
                tags: [],
                notes: null,
                internal_reference: null,
                external_url: null,
              },
              {
                transaction_journal_id: '106',
                type: 'withdrawal',
                date: '2026-01-12T00:00:00+00:00',
                amount: '34.99',
                description: 'USB cables',
                source_name: 'Checking',
                destination_name: 'Office Depot',
                category_name: 'Office',
                budget_name: null,
                bill_name: null,
                tags: [],
                notes: null,
                internal_reference: null,
                external_url: null,
              },
            ],
          },
        },
      ],
      meta: {
        pagination: { total: 1, count: 1, per_page: 50, current_page: 1, total_pages: 1 },
      },
    };
    mockFetch(response);
    const raw = await fireflyImportTool.func({});
    const result = JSON.parse(raw as string);
    expect(result.data.transactionsImported).toBe(2);

    const txns = getTransactions(db);
    expect(txns.find((t) => t.external_id === 'firefly:105')).toBeDefined();
    expect(txns.find((t) => t.external_id === 'firefly:106')).toBeDefined();
  });
});
