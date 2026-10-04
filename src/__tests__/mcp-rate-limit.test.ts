import { describe, expect, test } from 'bun:test';
import { createTestDb, seedTestData } from './helpers.js';
import { count, firstTxnId, grantTools, makeUser, testScope } from './mcp-helpers.js';
import { RateLimiter, setLimiterFor, limiterFor, userKeyOf, DAILY_READ_ROWS, DAILY_READ_CHARS } from '../mcp/rate-limit.js';
import { callTool, grantLocalAccess, checkGrantCreationRate, rejectOperation, type CallResult } from '../mcp/engine.js';
import { insertTransactions } from '../db/queries.js';
import { toAgentOperationView } from '../mcp/operation-view.js';
import type { Database } from '../db/compat-sqlite.js';

/** A limiter on a fake clock the test advances by hand. */
function fakeClock(start = Date.UTC(2026, 9, 2, 12, 0, 0)) {
  const clock = { now: start };
  return { clock, limiter: new RateLimiter({ now: () => clock.now }) };
}

function setup() {
  const db = createTestDb();
  seedTestData(db);
  const { clock, limiter } = fakeClock();
  setLimiterFor(db, limiter);
  return { db, clock, limiter };
}

const search = (db: Database, scope: ReturnType<typeof testScope>, grantId: string, args: Record<string, unknown> = { query: 'groceries' }) =>
  callTool(db, scope, grantId, 'transaction_search', args, 'imperative');

const edit = (db: Database, scope: ReturnType<typeof testScope>, grantId: string, notes: string) =>
  callTool(db, scope, grantId, 'edit_transaction', { id: firstTxnId(db), notes }, 'imperative');

function expectLimited(res: CallResult, code = 'rate_limited') {
  expect(res.ok).toBe(false);
  if (res.ok) return;
  expect(res.status).toBe(429);
  expect<string>(res.code).toBe(code);
  expect(res.retryAfterSec).toBeGreaterThan(0);
}

describe('token bucket math', () => {
  test('a bucket allows `limit` calls back to back, then waits for a token', () => {
    const { clock, limiter } = fakeClock();
    const rule = { limit: 20, windowMs: 60_000 };
    for (let i = 0; i < 20; i++) expect(limiter.take('k', rule).ok).toBe(true);
    const denied = limiter.take('k', rule);
    expect(denied).toEqual({ ok: false, retryAfterSec: 3 });
    clock.now += 3_000;
    expect(limiter.take('k', rule).ok).toBe(true);
    expect(limiter.take('k', rule).ok).toBe(false);
  });

  test('a long idle refills to the limit and no further', () => {
    const { clock, limiter } = fakeClock();
    const rule = { limit: 5, windowMs: 60_000 };
    for (let i = 0; i < 5; i++) limiter.take('k', rule);
    clock.now += 10 * 60_000;
    for (let i = 0; i < 5; i++) expect(limiter.take('k', rule).ok).toBe(true);
    expect(limiter.take('k', rule).ok).toBe(false);
  });

  test('keys are independent', () => {
    const { limiter } = fakeClock();
    const rule = { limit: 1, windowMs: 60_000 };
    expect(limiter.take('a', rule).ok).toBe(true);
    expect(limiter.take('a', rule).ok).toBe(false);
    expect(limiter.take('b', rule).ok).toBe(true);
  });

  test('each database gets its own limiter, so profiles and tests never share state', () => {
    const a = createTestDb();
    const b = createTestDb();
    expect(limiterFor(a)).toBe(limiterFor(a));
    expect(limiterFor(a)).not.toBe(limiterFor(b));
  });

  test('userKeyOf is anon while auth is off', () => {
    expect(userKeyOf(null)).toBe('anon');
    expect(userKeyOf(7)).toBe('user:7');
  });
});

describe('read limits', () => {
  test('the 6th back-to-back transaction_search -> 429 with Retry-After (burst 5)', async () => {
    const { db } = setup();
    const scope = testScope();
    const grants = grantTools(db, scope, ['transaction_search']);
    for (let i = 0; i < 5; i++) expect((await search(db, scope, grants.transaction_search)).ok).toBe(true);
    expectLimited(await search(db, scope, grants.transaction_search));
  });

  test('a steady 20 transaction_search per minute is allowed indefinitely', async () => {
    const { db, clock } = setup();
    const scope = testScope();
    const grants = grantTools(db, scope, ['transaction_search']);
    for (let i = 0; i < 60; i++) {
      expect((await search(db, scope, grants.transaction_search)).ok).toBe(true);
      clock.now += 3_000;
    }
  });

  test('the limit is per tool: another read tool is unaffected', async () => {
    const { db } = setup();
    const scope = testScope();
    const grants = grantTools(db, scope, ['transaction_search', 'net_worth']);
    for (let i = 0; i < 21; i++) await search(db, scope, grants.transaction_search);
    const other = await callTool(db, scope, grants.net_worth, 'net_worth', { action: 'summary' }, 'imperative');
    expect(other.ok).toBe(true);
  });

  test('tokens come back as time passes', async () => {
    const { db, clock } = setup();
    const scope = testScope();
    const grants = grantTools(db, scope, ['transaction_search']);
    for (let i = 0; i < 5; i++) await search(db, scope, grants.transaction_search);
    expectLimited(await search(db, scope, grants.transaction_search));
    clock.now += 60_000;
    expect((await search(db, scope, grants.transaction_search)).ok).toBe(true);
  });

  test('rotating sessionGeneration cannot escape the per-user read limit', async () => {
    const { db, limiter } = setup();
    // Spend the user's 120 reads for this minute (a script rotating sessions would get here with fresh per-session buckets).
    for (let i = 0; i < 120; i++) expect(limiter.take('ur:anon', { limit: 120, windowMs: 60_000 }).ok).toBe(true);
    const scope = testScope(); // a brand new session, with its own untouched per-session buckets
    const grants = grantTools(db, scope, ['transaction_search']);
    expectLimited(await search(db, scope, grants.transaction_search));
  });

  test('rotating sessions are also capped at 10 new sessions per hour per user', async () => {
    const { db } = setup();
    for (let s = 0; s < 10; s++) grantTools(db, testScope(), ['transaction_search']);
    const refused = grantLocalAccess(db, testScope(), ['transaction_search']);
    expect(refused.ok).toBe(false);
  });

  test('the per-user limits are keyed by user: another user is unaffected', async () => {
    const { db, limiter } = setup();
    await makeUser(db, 'u1', 'viewer');
    await makeUser(db, 'u2', 'viewer');
    for (let i = 0; i < 120; i++) limiter.take('ur:user:1', { limit: 120, windowMs: 60_000 });
    const heavy = testScope({ userId: 1 });
    expectLimited(await search(db, heavy, grantTools(db, heavy, ['transaction_search']).transaction_search));
    const other = testScope({ userId: 2 });
    expect((await search(db, other, grantTools(db, other, ['transaction_search']).transaction_search)).ok).toBe(true);
  });
});

describe('pending approvals and prepares', () => {
  test('the 4th concurrent pending approval -> 429', async () => {
    const { db } = setup();
    const scope = testScope();
    const grants = grantTools(db, scope, ['edit_transaction']);
    for (let i = 0; i < 3; i++) expect((await edit(db, scope, grants.edit_transaction, `n${i}`)).ok).toBe(true);
    const fourth = await edit(db, scope, grants.edit_transaction, 'n3');
    expectLimited(fourth);
    if (!fourth.ok) expect(fourth.error).toContain('Too many pending approvals');
    expect(count(db, 'mcp_operations')).toBe(3);
  });

  test('resolving one frees a slot', async () => {
    const { db } = setup();
    const scope = testScope();
    const grants = grantTools(db, scope, ['edit_transaction']);
    const ops: string[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await edit(db, scope, grants.edit_transaction, `n${i}`);
      if (res.ok && res.kind === 'operation') ops.push(res.operation.id);
    }
    expectLimited(await edit(db, scope, grants.edit_transaction, 'blocked'));
    rejectOperation(db, ops[0]);
    expect((await edit(db, scope, grants.edit_transaction, 'free')).ok).toBe(true);
  });

  test('rotating sessionGeneration does not exceed the per-user pending cap (5)', async () => {
    const { db } = setup();
    const created: number[] = [];
    let denied: CallResult | undefined;
    for (let s = 0; s < 5 && !denied; s++) {
      const scope = testScope();
      const grants = grantTools(db, scope, ['edit_transaction']);
      for (let i = 0; i < 2 && !denied; i++) {
        const res = await edit(db, scope, grants.edit_transaction, `s${s}-${i}`);
        if (res.ok) created.push(1);
        else denied = res;
      }
    }
    expect(created).toHaveLength(5);
    expectLimited(denied!);
    expect(count(db, 'mcp_operations', "status = 'pending'")).toBe(5);
  });

  test('chat operations do not count against the agent caps', async () => {
    const { db } = setup();
    const { createOperation } = await import('../mcp/store.js');
    for (let i = 0; i < 6; i++) {
      createOperation(db, {
        source: 'chat', grantId: null, toolName: 'categorize', args: {}, before: null, after: null,
        transactionId: null, revisionAtPrepare: null, profile: 'test', origin: 'dashboard-chat',
        sessionGeneration: 'dashboard-chat', userId: null, role: 'admin',
      });
    }
    const scope = testScope();
    const grants = grantTools(db, scope, ['edit_transaction']);
    expect((await edit(db, scope, grants.edit_transaction, 'fine')).ok).toBe(true);
  });

  test('prepares are limited to 10 per minute per principal', async () => {
    const { db, clock } = setup();
    const scope = testScope();
    const grants = grantTools(db, scope, ['edit_transaction']);
    for (let i = 0; i < 10; i++) {
      const res = await edit(db, scope, grants.edit_transaction, `p${i}`);
      expect(res.ok).toBe(true);
      if (res.ok && res.kind === 'operation') rejectOperation(db, res.operation.id); // keep pending low
    }
    expectLimited(await edit(db, scope, grants.edit_transaction, 'eleventh'));
    clock.now += 6_000;
    expect((await edit(db, scope, grants.edit_transaction, 'later')).ok).toBe(true);
  });
});

describe('grant creation limits', () => {
  test('the 11th new sessionGeneration with grants in an hour -> 429', () => {
    const db = createTestDb();
    for (let i = 0; i < 10; i++) {
      expect(grantLocalAccess(db, testScope(), ['transaction_search']).ok).toBe(true);
    }
    const eleventh = grantLocalAccess(db, testScope(), ['transaction_search']);
    expect(eleventh.ok).toBe(false);
    if (!eleventh.ok) {
      expect(eleventh.status).toBe(429);
      expect(eleventh.code).toBe('rate_limited');
    }
  });

  test('an existing session can keep adding grants, and another user has their own allowance', () => {
    const db = createTestDb();
    const scope = testScope({ userId: 1 });
    for (let i = 0; i < 10; i++) grantLocalAccess(db, testScope({ userId: 1 }), ['transaction_search']);
    expect(grantLocalAccess(db, scope, ['transaction_search']).ok).toBe(false);
    // Re-granting on a session that already has grants is not a new session.
    const first = db.prepare('SELECT session_generation FROM mcp_grants LIMIT 1').get() as { session_generation: string };
    expect(grantLocalAccess(db, { ...scope, sessionGeneration: first.session_generation }, ['net_worth']).ok).toBe(true);
    expect(grantLocalAccess(db, testScope({ userId: 2 }), ['transaction_search']).ok).toBe(true);
  });

  test('POST /api/mcp/grants is limited to 20 per minute per user', () => {
    const { db, clock } = setup();
    const scope = testScope();
    for (let i = 0; i < 20; i++) expect(checkGrantCreationRate(db, scope)).toBeNull();
    const denied = checkGrantCreationRate(db, scope);
    expect(denied?.status).toBe(429);
    clock.now += 60_000;
    expect(checkGrantCreationRate(db, scope)).toBeNull();
  });
});

describe('daily read budget', () => {
  test('daily read budget (rows) -> read_budget_exceeded, with Retry-After to the next UTC midnight', async () => {
    const { db, clock, limiter } = setup();
    const scope = testScope();
    const grants = grantTools(db, scope, ['transaction_search']);
    expect((await search(db, scope, grants.transaction_search)).ok).toBe(true);
    limiter.consumeRead('anon', DAILY_READ_ROWS, 0);
    const res = await search(db, scope, grants.transaction_search);
    expectLimited(res, 'read_budget_exceeded');
    if (!res.ok) expect(res.retryAfterSec).toBe(12 * 3600); // clock starts at 12:00 UTC
    // The next UTC day starts a fresh budget.
    clock.now += 13 * 3600 * 1000;
    expect((await search(db, scope, grants.transaction_search)).ok).toBe(true);
  });

  test('the character budget trips it too', async () => {
    const { db, limiter } = setup();
    const scope = testScope();
    const grants = grantTools(db, scope, ['transaction_search']);
    limiter.consumeRead('anon', 0, DAILY_READ_CHARS);
    expectLimited(await search(db, scope, grants.transaction_search), 'read_budget_exceeded');
  });

  test('real reads draw the budget down, and rotating sessions share it', async () => {
    const { db, limiter } = setup();
    const a = testScope();
    const b = testScope();
    const ga = grantTools(db, a, ['transaction_search']);
    const gb = grantTools(db, b, ['transaction_search']);
    await search(db, a, ga.transaction_search);
    await search(db, b, gb.transaction_search);
    const used = limiter.readBudgetUsed('anon');
    expect(used.rows).toBe(4); // two searches x two grocery rows
    expect(used.chars).toBeGreaterThan(200);
  });

  test('the budget is per user', async () => {
    const { db, limiter } = setup();
    await makeUser(db, 'u1', 'viewer');
    await makeUser(db, 'u2', 'viewer');
    limiter.consumeRead(userKeyOf(1), DAILY_READ_ROWS, 0);
    const blocked = testScope({ userId: 1 });
    expectLimited(await search(db, blocked, grantTools(db, blocked, ['transaction_search']).transaction_search), 'read_budget_exceeded');
    const free = testScope({ userId: 2 });
    expect((await search(db, free, grantTools(db, free, ['transaction_search']).transaction_search)).ok).toBe(true);
  });

  test('concurrent reads cannot overshoot the daily budget (reserve before the await, settle after)', async () => {
    const { db, limiter } = setup();
    limiter.consumeRead('anon', DAILY_READ_ROWS - 3, 0);
    const scope = testScope();
    const grants = grantTools(db, scope, ['transaction_search']);
    const results = await Promise.all(
      Array.from({ length: 5 }, () => search(db, scope, grants.transaction_search, { query: 'groceries', limit: 1 })),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(3);
    for (const r of results.filter((x) => !x.ok)) expectLimited(r, 'read_budget_exceeded');
    expect(limiter.readBudgetUsed('anon').rows).toBeLessThanOrEqual(DAILY_READ_ROWS);
    expect(limiter.readBudgetUsed('anon').rows).toBe(DAILY_READ_ROWS);
  });

  test('a reservation is released when the read fails, and trued up to the real size when it succeeds', async () => {
    const { db, limiter } = setup();
    const scope = testScope();
    const grants = grantTools(db, scope, ['transaction_search']);
    // A cursor that does not match the arguments makes the read fail after the reservation.
    const bad = await search(db, scope, grants.transaction_search, { query: 'groceries', cursor: 'eyJvIjoxLCJoIjoibm9wZSJ9' });
    expect(bad.ok).toBe(false);
    expect(limiter.readBudgetUsed('anon')).toEqual({ rows: 0, chars: 0 });
    await search(db, scope, grants.transaction_search, { query: 'groceries', limit: 25 });
    expect(limiter.readBudgetUsed('anon').rows).toBe(2); // not the 25 that were reserved
  });

  test('budget exhausted: prepare returns no row text, so prepare+cancel is not a free read', async () => {
    const { db, limiter } = setup();
    limiter.consumeRead('anon', DAILY_READ_ROWS, DAILY_READ_CHARS);
    const scope = testScope();
    const grants = grantTools(db, scope, ['edit_transaction']);
    const id = firstTxnId(db);
    db.prepare("UPDATE transactions SET description = 'SECRET MERCHANT', notes = 'private note' WHERE id = @id").run({ id });
    const res = await edit(db, scope, grants.edit_transaction, 'still ok');
    expect(res.ok).toBe(true);
    if (!res.ok || res.kind !== 'operation') throw new Error('expected an operation');
    const agent = JSON.stringify(toAgentOperationView(db, res.operation, { sessionGeneration: scope.sessionGeneration }));
    expect(agent).not.toContain('SECRET MERCHANT');
    expect(agent).not.toContain('private note');
    expect(agent).not.toContain('still ok');
  });
});

describe('deep paging', () => {
  test('deep paging (>20 pages) writes a deep_paging sentinel, once', async () => {
    const { db, clock } = setup();
    insertTransactions(
      db,
      Array.from({ length: 600 }, (_, i) => ({ date: '2026-08-15', description: `Coffee ${i}`, amount: -4.5, category: 'Dining' })),
    );
    const scope = testScope();
    const grants = grantTools(db, scope, ['transaction_search']);
    let cursor: string | undefined;
    for (let page = 0; page < 24; page++) {
      const res = await search(db, scope, grants.transaction_search, { query: 'coffee', limit: 10, ...(cursor ? { cursor } : {}) });
      if (!res.ok || res.kind !== 'read') throw new Error(`page ${page} failed: ${JSON.stringify(res)}`);
      cursor = (res.data as { nextCursor?: string }).nextCursor;
      clock.now += 4_000; // stay under the per-tool rate limit
      if (!cursor) break;
    }
    const sentinels = db.prepare("SELECT * FROM mcp_audit_log WHERE decision = 'deep_paging'").all() as any[];
    expect(sentinels).toHaveLength(1);
    expect(sentinels[0].tier).toBe('sentinel');
    expect(sentinels[0].tool_name).toBe('transaction_search');
    // The reads themselves carry their page_index.
    const pages = db.prepare("SELECT page_index FROM mcp_audit_log WHERE decision = 'allowed' ORDER BY id").all() as { page_index: number }[];
    expect(pages[0].page_index).toBe(0);
    expect(pages[pages.length - 1].page_index).toBeGreaterThanOrEqual(21);
  });

  test('re-reading the same page over and over is not deep paging', async () => {
    const { db, clock } = setup();
    insertTransactions(db, Array.from({ length: 60 }, (_, i) => ({ date: '2026-08-15', description: `Coffee ${i}`, amount: -4.5, category: 'Dining' })));
    const scope = testScope();
    const grants = grantTools(db, scope, ['transaction_search']);
    const first = await search(db, scope, grants.transaction_search, { query: 'coffee', limit: 10 });
    const cursor = (first as any).data.nextCursor as string;
    for (let i = 0; i < 25; i++) {
      await search(db, scope, grants.transaction_search, { query: 'coffee', limit: 10, cursor });
      clock.now += 4_000;
    }
    expect(count(db, 'mcp_audit_log', "decision = 'deep_paging'")).toBe(0);
  });
});
