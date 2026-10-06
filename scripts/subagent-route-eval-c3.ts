/**
 * Slice 8, bar [C3] on the persona seed (no product code). For every row a
 * results.json routed to transaction_search, run fillArgs and then the REAL
 * server transaction_search on persona 1 ("comingled founder", June 2026,
 * rows copied from src/__tests__/subagent-args-persona.test.ts, now pinned to
 * 2026-07-15). An empty result is fine only because the loop turns it into
 * HANDOFF(empty-result); this reports how many land in each bucket.
 *
 *   HOME=<scratch> bun scripts/subagent-route-eval-c3.ts <results.json> <set>
 */
import { setSystemTime } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createTestDb } from '../src/__tests__/helpers.js';
import { insertTransactions, type TransactionInsert } from '../src/db/queries.js';
import { initTransactionSearchTool, transactionSearchTool } from '../src/tools/query/transaction-search.js';
import { CATEGORIES } from '../src/tools/categorize/categories.js';
import { fillArgs } from '../src/dashboard/ui/src/hybrid/subagent-args.js';

const [file, setName] = process.argv.slice(2);
const results = JSON.parse(readFileSync(file, 'utf8'));
const records = results.sets[setName].records as Array<{ q: string; expect: string; gate: string; route: string | null }>;

const NOW = new Date('2026-07-15T12:00:00');
setSystemTime(NOW);
const CHECKING: Array<[string, string, number]> = [
  ['2026-06-01', 'CLIENT PAYMT - STONEBRIDGE CONSULTING', 2400.0], ['2026-06-02', 'RENT PAYMENT', -1800.0],
  ['2026-06-03', 'WHOLE FOODS MARKET', -142.33], ['2026-06-04', 'TRANSFER TO CREDIT CARD XXXX-4471', -600.0],
  ['2026-06-05', 'ADOBE CREATIVE CLOUD', -54.99], ['2026-06-05', 'ADOBE CREATIVE CLOUD', -54.99],
  ['2026-06-08', 'PAYROLL DEP - DAYJOB INC', 3100.0], ['2026-06-10', 'CONED UTILITY', -96.4],
  ['2026-06-15', 'CLIENT PAYMT - HARBOR LOGISTICS', 1800.0], ['2026-06-18', 'GYM MEMBERSHIP', -45.0],
  ['2026-06-20', "TRADER JOE'S #229", -88.1], ['2026-06-24', 'STATE QUARTERLY TAX PMT', -1200.0],
  ['2026-06-27', 'GROCERY OUTLET', -63.55],
];
const CARD: Array<[string, string, number]> = [
  ['2026-06-01', 'STAPLES BUSINESS ADVANTAGE', -89.2], ['2026-06-03', 'UNION SQUARE CAFE - CLIENT DINNER', -156.4],
  ['2026-06-04', 'AMEX EPAYMENT - THANK YOU', 600.0], ['2026-06-06', 'DELTA AIR LINES - CONF TRAVEL', -412.0],
  ['2026-06-09', 'NETFLIX.COM', -15.49], ['2026-06-13', 'UBER TRIP HELP.UBER.COM', -22.1],
  ['2026-06-19', 'APPLE.COM/BILL', -2.99], ['2026-06-23', 'FEDEX OFFICE PRINT & SHIP', -34.75],
];
const db = createTestDb();
insertTransactions(db, [...CHECKING, ...CARD].map(([date, description, amount]) => ({ date, description, amount })) as TransactionInsert[]);
initTransactionSearchTool(db);

const out: Array<{ q: string; bucket: string; query?: string; count?: number }> = [];
for (const r of records) {
  if (r.gate !== 'route' || r.route !== 'transaction_search') continue;
  const f = fillArgs('transaction_search', r.q, NOW, CATEGORIES);
  if (!f.ok) { out.push({ q: r.q, bucket: 'args-unfillable' }); continue; }
  const query = String(f.args.query);
  const res = JSON.parse((await transactionSearchTool.func({ query } as never)) as string).data;
  out.push({ q: r.q, bucket: res.count >= 1 ? 'rows' : 'empty-result', query, count: res.count });
}
const tally: Record<string, number> = {};
for (const o of out) tally[o.bucket] = (tally[o.bucket] ?? 0) + 1;
console.log(JSON.stringify({ set: setName, routedToTransactionSearch: out.length, tally, rows: out }, null, 1));
