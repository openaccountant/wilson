import { afterAll, beforeAll, describe, expect, setSystemTime, test } from 'bun:test';
import { createTestDb } from './helpers.js';
import { insertTransactions, type TransactionInsert } from '../db/queries.js';
import type { Database } from '../db/compat-sqlite.js';
import { initTransactionSearchTool, transactionSearchTool } from '../tools/query/transaction-search.js';
import { CATEGORIES } from '../tools/categorize/categories.js';
import { fillArgs } from '../dashboard/ui/src/hybrid/subagent-args.js';
import gold from './fixtures/subagent-route-gold.json';

/**
 * [C3] Arg filling against the REAL server transaction_search on persona 1
 * ("comingled founder", June 2026): the answer to "show me every Whole Foods
 * charge" must not be 0 rows because the raw question was used as a merchant.
 *
 * The rows below are copied from the synthetic persona CSVs
 * (scripts/demos/personas/1-comingled-founder/{checking,card}.csv in the
 * fix+profile-switch-dashboard worktree). Descriptions are kept verbatim
 * (UPPER CASE); the card file lists charges as positive amounts, so they are
 * negated here exactly as the card importer does. Nothing here touches a real
 * profile.
 */

const CHECKING: Array<[string, string, number]> = [
  ['2026-06-01', 'CLIENT PAYMT - STONEBRIDGE CONSULTING', 2400.0],
  ['2026-06-02', 'RENT PAYMENT', -1800.0],
  ['2026-06-03', 'WHOLE FOODS MARKET', -142.33],
  ['2026-06-04', 'TRANSFER TO CREDIT CARD XXXX-4471', -600.0],
  ['2026-06-05', 'ADOBE CREATIVE CLOUD', -54.99],
  ['2026-06-05', 'ADOBE CREATIVE CLOUD', -54.99],
  ['2026-06-08', 'PAYROLL DEP - DAYJOB INC', 3100.0],
  ['2026-06-10', 'CONED UTILITY', -96.4],
  ['2026-06-15', 'CLIENT PAYMT - HARBOR LOGISTICS', 1800.0],
  ['2026-06-18', 'GYM MEMBERSHIP', -45.0],
  ['2026-06-20', "TRADER JOE'S #229", -88.1],
  ['2026-06-24', 'STATE QUARTERLY TAX PMT', -1200.0],
  ['2026-06-27', 'GROCERY OUTLET', -63.55],
];
const CARD: Array<[string, string, number]> = [
  ['2026-06-01', 'STAPLES BUSINESS ADVANTAGE', -89.2],
  ['2026-06-03', 'UNION SQUARE CAFE - CLIENT DINNER', -156.4],
  ['2026-06-04', 'AMEX EPAYMENT - THANK YOU', 600.0],
  ['2026-06-06', 'DELTA AIR LINES - CONF TRAVEL', -412.0],
  ['2026-06-09', 'NETFLIX.COM', -15.49],
  ['2026-06-13', 'UBER TRIP HELP.UBER.COM', -22.1],
  ['2026-06-19', 'APPLE.COM/BILL', -2.99],
  ['2026-06-23', 'FEDEX OFFICE PRINT & SHIP', -34.75],
];

const NOW = new Date('2026-07-15T12:00:00');
let serverDb: Database;

beforeAll(() => {
  setSystemTime(NOW);
  serverDb = createTestDb();
  const rows: TransactionInsert[] = [...CHECKING, ...CARD].map(([date, description, amount]) => ({
    date,
    description,
    amount,
  })) as TransactionInsert[];
  insertTransactions(serverDb, rows);
  initTransactionSearchTool(serverDb);
});

afterAll(() => {
  setSystemTime();
});

async function runServerSearch(query: string): Promise<{ count: number; transactions: Array<{ description: string; amount: number }> }> {
  const raw = await transactionSearchTool.func({ query } as never);
  return JSON.parse(raw as string).data;
}

const goldSearchRows = (gold.rows as Array<{ question: string; expected: string }>).filter(
  (r) => r.expected === 'transaction_search'
);

// Merchants the founder persona simply does not have: an empty result is the TRUE answer
// here, and the loop turns it into HANDOFF(empty-result) instead of a confident local "none".
const ABSENT_FROM_PERSONA = ['Comcast', 'Ticketmaster', 'Costco'];

describe('[C3] transaction_search arg filling against persona 1', () => {
  test('the gold set has transaction_search rows to test', () => {
    expect(goldSearchRows.length).toBe(8);
  });

  test('every gold transaction_search row is ≥1 row, args-unfillable, or a merchant the persona lacks', async () => {
    const outcomes: Record<string, string> = {};
    for (const r of goldSearchRows) {
      const filled = fillArgs('transaction_search', r.question, NOW, CATEGORIES);
      if (!filled.ok) {
        outcomes[r.question] = 'args-unfillable';
        continue;
      }
      const res = await runServerSearch(String(filled.args.query));
      if (res.count >= 1) {
        outcomes[r.question] = 'rows';
        continue;
      }
      // 0 rows: only acceptable when the persona genuinely lacks the merchant.
      const lacking = ABSENT_FROM_PERSONA.some((m) => r.question.includes(m));
      expect(lacking, `0 rows for a merchant the persona HAS: ${r.question} -> ${JSON.stringify(filled.args)}`).toBe(true);
      outcomes[r.question] = 'empty-result';
    }
    // The point of C3: the common questions return rows, not empty.
    expect(outcomes['Show me every Whole Foods charge last month']).toBe('rows');
    expect(outcomes['Did I get charged twice by Adobe?']).toBe('rows');
    expect(outcomes['Find all transactions over $200 in June']).toBe('rows');
    expect(outcomes['List my Uber rides this year']).toBe('rows');
    expect(outcomes['Pull up my rent payments from the last three months']).toBe('args-unfillable');
  });

  test('"Show me every Whole Foods charge in June" -> canonical "Whole Foods in June" -> the $142.33 row', async () => {
    const filled = fillArgs('transaction_search', 'Show me every Whole Foods charge in June', NOW, CATEGORIES);
    expect(filled).toEqual({ ok: true, args: { query: 'Whole Foods in June' } });
    const res = await runServerSearch('Whole Foods in June');
    expect(res.count).toBe(1);
    expect(res.transactions[0].amount).toBe(-142.33);
  });

  test('the raw question really does return 0 rows (the bug the canonicalisation avoids)', async () => {
    const raw = await runServerSearch('Show me every Whole Foods charge in June');
    expect(raw.count).toBe(0);
  });

  test('"Did I get charged twice by Adobe?" -> "Adobe" -> both 54.99 rows', async () => {
    const filled = fillArgs('transaction_search', 'Did I get charged twice by Adobe?', NOW, CATEGORIES);
    expect(filled).toEqual({ ok: true, args: { query: 'Adobe' } });
    const res = await runServerSearch('Adobe');
    expect(res.count).toBe(2);
    expect(res.transactions.every((t) => t.amount === -54.99)).toBe(true);
  });

  test('a merchant that does not exist fills fine and returns 0 rows (-> empty-result in the loop)', async () => {
    const filled = fillArgs('transaction_search', 'Show me every Zzyzx Labs charge', NOW, CATEGORIES);
    expect(filled.ok).toBe(true);
    if (filled.ok) expect((await runServerSearch(String(filled.args.query))).count).toBe(0);
  });
});
