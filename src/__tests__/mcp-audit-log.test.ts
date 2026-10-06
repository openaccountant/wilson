import { describe, expect, test, afterEach } from 'bun:test';
import { createTestDb, seedTestData } from './helpers.js';
import { count, firstTxnId, grantTools, testScope } from './mcp-helpers.js';
import { appendAudit, listAudit, previewArgs, principalFor, sweepAudit, type AuditInput } from '../mcp/audit.js';
import { callTool, getPendingOperations, getOperationById, approveWebMcpOperation } from '../mcp/engine.js';
import { startDashboardServer, stopDashboardServer } from '../dashboard/server.js';
import { setInitialProfile, closeAll } from '../dashboard/db-manager.js';
import type { Database } from '../db/compat-sqlite.js';

/**
 * Every agent tool call lands in mcp_audit_log: reads as well as writes,
 * denied calls as well as allowed ones (noise folded into per-minute rows).
 */

type Row = Record<string, any>;
const rows = (db: Database, where = '1=1', params: Record<string, unknown> = {}) =>
  db.prepare(`SELECT * FROM mcp_audit_log WHERE ${where} ORDER BY id`).all(params) as Row[];

const servers: Awaited<ReturnType<typeof startDashboardServer>>['server'][] = [];
afterEach(() => {
  for (const s of servers) {
    try { stopDashboardServer(s); } catch { /* */ }
  }
  servers.length = 0;
  closeAll();
});

function base(overrides: Partial<AuditInput> = {}): AuditInput {
  return {
    transport: 'imperative',
    principalKind: 'tab',
    principalId: 'abcd1234abcd1234',
    userId: null,
    role: 'admin',
    origin: 'http://localhost:3141',
    toolName: 'search_transactions',
    classification: 'read',
    decision: 'allowed',
    ...overrides,
  };
}

describe('what callTool writes', () => {
  async function setup() {
    const db = createTestDb();
    seedTestData(db);
    const scope = testScope();
    const grants = grantTools(db, scope, ['search_transactions', 'update_transaction']);
    return { db, scope, grants };
  }

  test('an allowed read writes one signal row with result_chars and page_index', async () => {
    const { db, scope, grants } = await setup();
    const res = await callTool(db, scope, grants.search_transactions, 'search_transactions', { query: 'groceries' }, 'imperative');
    expect(res.ok).toBe(true);
    const log = rows(db);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      tier: 'signal', decision: 'allowed', tool_name: 'search_transactions', classification: 'read',
      transport: 'imperative', principal_kind: 'tab', page_index: 0, count: 1,
    });
    expect(log[0].result_chars).toBe(JSON.stringify((res as any).data).length);
    expect(log[0].duration_ms).toBeGreaterThanOrEqual(0);
    expect(log[0].args_preview).toContain('groceries');
  });

  test('invalid_args, denied_grant and rate_limited each aggregate into one noise row per minute with a count', async () => {
    const { db, scope, grants } = await setup();
    for (let i = 0; i < 4; i++) {
      await callTool(db, scope, grants.update_transaction, 'update_transaction', { id: 'x' }, 'imperative'); // invalid_args
    }
    for (let i = 0; i < 3; i++) {
      await callTool(db, scope, crypto.randomUUID(), 'search_transactions', { query: 'a' }, 'imperative'); // denied_grant
    }
    for (let i = 0; i < 25; i++) {
      await callTool(db, scope, grants.search_transactions, 'search_transactions', { query: 'a' }, 'imperative'); // 5 ok (burst), then rate_limited
    }
    const noise = rows(db, "tier = 'noise'");
    const byDecision = Object.fromEntries(noise.map((r) => [r.decision, r.count]));
    expect(byDecision).toEqual({ invalid_args: 4, denied_grant: 3, rate_limited: 20 });
    expect(noise).toHaveLength(3);
    expect(rows(db, "decision = 'allowed'")).toHaveLength(5);
  });

  test('a denied call is audited even when the tool name is made up', async () => {
    const { db, scope } = await setup();
    const res = await callTool(db, scope, null, 'delete_everything', {}, 'imperative');
    expect(res.ok).toBe(false);
    const log = rows(db);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ tool_name: '<unknown>', classification: 'unknown', tier: 'noise', error_code: 'unknown_tool' });
  });

  test('invented tool names and rotating sessions cannot mint noise rows: one row per decision, keyed by the user', async () => {
    const { db } = await setup();
    for (let i = 0; i < 300; i++) {
      const rotating = testScope(); // a fresh, never-granted session every time
      await callTool(db, rotating, crypto.randomUUID(), `invented_tool_${i}`, {}, 'imperative'); // unknown_tool
      await callTool(db, rotating, crypto.randomUUID(), 'search_transactions', { query: 'a' }, 'imperative'); // denied_grant
      await callTool(db, rotating, null, 'update_transaction', { id: 'x' }, 'imperative'); // invalid_args
    }
    const noise = rows(db, "tier = 'noise'");
    expect(noise.length).toBeLessThanOrEqual(4); // unknown tool, denied_grant, invalid_args (a minute boundary may split them)
    expect(new Set(noise.map((r) => r.principal_id))).toEqual(new Set(['user:anon']));
    expect(noise.some((r) => r.tool_name.startsWith('invented'))).toBe(false);
    expect(noise.reduce((n, r) => n + r.count, 0)).toBe(900);
  });

  test('a client-supplied session string can never make rows look like the chat or a client token', async () => {
    expect(principalFor('dashboard-chat')).toMatchObject({ kind: 'tab' });
    expect(principalFor('dashboard-chat').id).toMatch(/^[0-9a-f]{16}$/);
    expect(principalFor('tok:victimid')).toMatchObject({ kind: 'tab' });
    expect(principalFor('tok:victimid').id).not.toContain('victimid');

    const { db } = await setup();
    const scope = testScope({ sessionGeneration: 'dashboard-chat' }); // as if a legacy client had smuggled it in
    const g = grantTools(db, scope, ['search_transactions']);
    await callTool(db, scope, g.search_transactions, 'search_transactions', { query: 'a' }, 'imperative');
    expect(rows(db).every((r) => r.principal_kind !== 'chat' && r.principal_kind !== 'client_token')).toBe(true);
    expect(rows(db, "principal_id = 'chat'")).toHaveLength(0);
  });

  test('a pending operation that lapses is audited as expired by the sweep, once', async () => {
    const { db, scope, grants } = await setup();
    const res = await callTool(db, scope, grants.update_transaction, 'update_transaction', { id: firstTxnId(db), notes: 'n' }, 'imperative');
    if (!res.ok || res.kind !== 'operation') throw new Error('expected an operation');
    db.prepare("UPDATE mcp_operations SET expires_at = @t WHERE id = @id").run({ t: new Date(Date.now() - 1000).toISOString(), id: res.operation.id });
    expect(getPendingOperations(db)).toHaveLength(0); // the sweep that the queue read runs
    expect(getOperationById(db, res.operation.id)?.status).toBe('expired');
    getPendingOperations(db);
    const expired = rows(db, "decision = 'expired'");
    expect(expired).toHaveLength(1);
    expect(expired[0].operation_id).toBe(res.operation.id);
  });

  test('a viewer scope using an admin grant is refused and audited', async () => {
    const db = createTestDb();
    seedTestData(db);
    const admin = testScope({ role: 'admin' });
    const grants = grantTools(db, admin, ['update_transaction']);
    // Same grant id, but the live role is viewer: the grant's scope check refuses it.
    const res = await callTool(db, { ...admin, role: 'viewer' }, grants.update_transaction, 'update_transaction', { id: 1, notes: 'x' }, 'imperative');
    expect(res.ok).toBe(false);
    expect(rows(db, "tier = 'noise'")).toHaveLength(1);
    expect(rows(db)[0].decision).toBe('denied_grant');
  });

  test('a viewer who somehow holds a mutating grant is denied_role, audited, and no operation is created', async () => {
    const db = createTestDb();
    seedTestData(db);
    const viewer = testScope({ role: 'viewer' });
    // grantLocalAccess refuses this; build the row directly to prove the role check is a second line of defense.
    const { createGrants } = await import('../mcp/store.js');
    const { schemaDigest } = await import('../mcp/tool-catalog.js');
    const [grant] = createGrants(db, {
      tools: [{ name: 'update_transaction', schemaDigest: schemaDigest('update_transaction') }],
      userId: viewer.userId, role: 'viewer', profile: viewer.profile, origin: viewer.origin, sessionGeneration: viewer.sessionGeneration,
    });
    const res = await callTool(db, viewer, grant.id, 'update_transaction', { id: firstTxnId(db), notes: 'x' }, 'imperative');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(403);
      expect(res.code).toBe('role_forbidden');
    }
    expect(rows(db)[0].decision).toBe('denied_role');
    expect(count(db, 'mcp_operations')).toBe(0);
  });

  test('mutation lifecycle logs operation_created -> approved -> committed with the same operation_id', async () => {
    const { db, scope, grants } = await setup();
    const res = await callTool(db, scope, grants.update_transaction, 'update_transaction', { id: firstTxnId(db), notes: 'audit me' }, 'imperative');
    if (!res.ok || res.kind !== 'operation') throw new Error('expected an operation');
    approveWebMcpOperation(db, res.operation.id, 'test');
    const lifecycle = rows(db, 'operation_id = @id', { id: res.operation.id });
    expect(lifecycle.map((r) => r.decision)).toEqual(['operation_created', 'approved', 'committed']);
    expect(lifecycle[0].transport).toBe('imperative');
    expect(lifecycle[1].transport).toBe('rest');
  });

  test('a rejected, expired and cancelled operation each log their own decision', async () => {
    const { db, scope, grants } = await setup();
    const { rejectOperation, cancelOperation } = await import('../mcp/engine.js');
    const make = async (notes: string) => {
      const res = await callTool(db, scope, grants.update_transaction, 'update_transaction', { id: firstTxnId(db), notes }, 'imperative');
      if (!res.ok || res.kind !== 'operation') throw new Error('expected an operation');
      return res.operation;
    };
    const a = await make('a');
    rejectOperation(db, a.id);
    const b = await make('b');
    cancelOperation(db, scope, b.id);
    const c = await make('c');
    db.prepare('UPDATE mcp_operations SET expires_at = @t WHERE id = @id').run({ id: c.id, t: new Date(Date.now() - 1000).toISOString() });
    approveWebMcpOperation(db, c.id, 'test');
    expect(rows(db, 'operation_id = @id', { id: a.id }).map((r) => r.decision)).toEqual(['operation_created', 'rejected']);
    expect(rows(db, 'operation_id = @id', { id: b.id }).map((r) => r.decision)).toEqual(['operation_created', 'cancelled']);
    expect(rows(db, 'operation_id = @id', { id: c.id }).map((r) => r.decision)).toEqual(['operation_created', 'expired']);
  });

  test('a prepare that fails validation or hits a missing transaction creates no operation and is audited', async () => {
    const { db, scope, grants } = await setup();
    const missing = await callTool(db, scope, grants.update_transaction, 'update_transaction', { id: 987654, notes: 'x' }, 'imperative');
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.code).toBe('not_found');
    expect(count(db, 'mcp_operations')).toBe(0);
    expect(rows(db, "error_code = 'not_found'")).toHaveLength(1);
  });

  test('the raw sessionGeneration is never stored, in any column', async () => {
    const { db, scope, grants } = await setup();
    await callTool(db, scope, grants.search_transactions, 'search_transactions', { query: 'groceries' }, 'imperative');
    await callTool(db, scope, grants.update_transaction, 'update_transaction', { id: firstTxnId(db), notes: 'n' }, 'imperative');
    const dump = JSON.stringify(rows(db));
    expect(dump).not.toContain(scope.sessionGeneration);
    expect(rows(db)[0].principal_id).toBe(principalFor(scope.sessionGeneration).id);
    expect(rows(db)[0].principal_id).toMatch(/^[0-9a-f]{16}$/);
  });

  test('args_preview is PII-masked, sanitized and at most 512 characters', async () => {
    const { db, scope, grants } = await setup();
    await callTool(db, scope, grants.search_transactions, 'search_transactions', { query: 'acct 123456789012 for jane@example.com' }, 'imperative');
    const preview = rows(db)[0].args_preview as string;
    expect(preview).toContain('•••9012');
    expect(preview).toContain('[email]');
    expect(preview).not.toContain('123456789012');
    expect(preview).not.toContain('jane@example.com');

    expect(previewArgs({ q: 'x'.repeat(2000) }).length).toBeLessThanOrEqual(512);
    expect(previewArgs({ q: 'bad\u202echar' })).not.toContain('\u202e');
  });

  test('a failure while writing the audit row does not turn a decided call into a crash', async () => {
    const { db, scope, grants } = await setup();
    db.exec('DROP TABLE mcp_audit_log');
    const original = console.error;
    console.error = () => {};
    try {
      const res = await callTool(db, scope, grants.search_transactions, 'search_transactions', { query: 'groceries' }, 'imperative');
      expect(res.ok).toBe(true);
    } finally {
      console.error = original;
    }
  });
});

describe('sweepAudit', () => {
  const DAY = 86_400_000;
  const iso = (msAgo: number, now = Date.now()) => new Date(now - msAgo).toISOString();

  test('sweep enforces retention (all tiers) and clamps it to 7-365 days', () => {
    const db = createTestDb();
    appendAudit(db, base({ ts: iso(100 * DAY) }));
    appendAudit(db, base({ ts: iso(100 * DAY), decision: 'rate_limited' }));
    appendAudit(db, base({ ts: iso(30 * DAY) }));
    appendAudit(db, base({ ts: iso(1 * DAY) }));
    expect(sweepAudit(db, { retentionDays: 90 }).expired).toBe(2);
    expect(count(db, 'mcp_audit_log')).toBe(2);
    // 1 day is clamped up to 7: the 30-day-old row goes, yesterday's stays.
    sweepAudit(db, { retentionDays: 1 });
    expect(count(db, 'mcp_audit_log')).toBe(1);
    // 9999 is clamped down to 365.
    appendAudit(db, base({ ts: iso(400 * DAY) }));
    sweepAudit(db, { retentionDays: 9999 });
    expect(count(db, 'mcp_audit_log')).toBe(1);
  });

  test('200k rate_limited calls from one principal fold into one row and do not evict an allowed row from 1h ago', () => {
    const db = createTestDb();
    const hourAgo = iso(3_600_000);
    appendAudit(db, base({ ts: hourAgo, argsPreview: '{"query":"the exfiltration"}' }));
    const ts = new Date().toISOString();
    db.transaction(() => {
      for (let i = 0; i < 200_000; i++) appendAudit(db, base({ decision: 'rate_limited', ts }));
    })();
    const noise = rows(db, "tier = 'noise'");
    expect(noise).toHaveLength(1);
    expect(noise[0].count).toBe(200_000);
    sweepAudit(db);
    expect(rows(db, "decision = 'allowed'")).toHaveLength(1);
  }, 30_000); // 200k inserts: ~3 s locally, more on shared CI runners

  test('a flood of noise from many rotating principals is trimmed first; signal rows survive the soft cap', () => {
    const db = createTestDb();
    appendAudit(db, base({ ts: iso(3_600_000), argsPreview: 'the exfiltration' }));
    db.transaction(() => {
      for (let i = 0; i < 150; i++) {
        appendAudit(db, base({ decision: 'rate_limited', principalId: String(i).padStart(16, '0') }));
      }
    })();
    const result = sweepAudit(db, { maxRows: 100 });
    expect(result.noiseEvicted).toBe(51);
    // 100 rows kept, plus the audit_evicted sentinel the eviction leaves.
    expect(count(db, 'mcp_audit_log')).toBe(101);
    expect(rows(db, "decision = 'allowed'")).toHaveLength(1);
    const sentinel = rows(db, "decision = 'audit_evicted'");
    expect(sentinel).toHaveLength(1);
    expect(sentinel[0]).toMatchObject({ tier: 'sentinel', count: 51 });
  });

  test('over-cap signal rows older than 24h compact into hourly summaries and write a sentinel; the last 24h is untouched', () => {
    const db = createTestDb();
    const now = Date.now();
    for (let i = 0; i < 30; i++) {
      appendAudit(db, base({ ts: iso(2 * DAY + (i % 3) * 3_600_000 + i * 1000, now), resultChars: 100 }));
    }
    for (let i = 0; i < 5; i++) appendAudit(db, base({ ts: iso(3_600_000 + i * 1000, now), resultChars: 7 }));
    const result = sweepAudit(db, { maxRows: 10, now });
    expect(result.compacted).toBe(30);
    expect(rows(db, "tier = 'signal'")).toHaveLength(5);
    const summaries = rows(db, "tier = 'summary'");
    expect(summaries.length).toBeGreaterThan(0);
    expect(summaries.reduce((n, r) => n + r.count, 0)).toBe(30);
    expect(summaries.reduce((n, r) => n + r.result_chars, 0)).toBe(3000);
    const sentinel = rows(db, "decision = 'audit_compacted'");
    expect(sentinel).toHaveLength(1);
    expect(sentinel[0].tier).toBe('sentinel');
    expect(sentinel[0].count).toBe(30);
  });

  test('only past the hard ceiling are the oldest rows deleted, and an audit_evicted sentinel says so', () => {
    const db = createTestDb();
    const now = Date.now();
    for (let i = 0; i < 20; i++) appendAudit(db, base({ ts: iso(3_600_000 - i * 1000, now) }));
    const result = sweepAudit(db, { maxRows: 5, hardCeiling: 8, now });
    expect(result.compacted).toBe(0); // everything is inside 24h
    expect(result.evicted).toBe(12);
    const sentinel = rows(db, "decision = 'audit_evicted'");
    expect(sentinel).toHaveLength(1);
    expect(sentinel[0].count).toBe(12);
    expect(count(db, 'mcp_audit_log')).toBe(9);
  });

  test('a sweep with nothing to do changes nothing', () => {
    const db = createTestDb();
    appendAudit(db, base());
    expect(sweepAudit(db)).toEqual({ expired: 0, noiseEvicted: 0, compacted: 0, evicted: 0 });
    expect(count(db, 'mcp_audit_log')).toBe(1);
  });
});

describe('listAudit', () => {
  test('viewer listAudit sees own rows only; paging by cursor', () => {
    const db = createTestDb();
    for (let i = 0; i < 5; i++) appendAudit(db, base({ userId: 1 }));
    for (let i = 0; i < 3; i++) appendAudit(db, base({ userId: 2 }));
    expect(listAudit(db, { restrictToUserId: 2 }).entries).toHaveLength(3);
    expect(listAudit(db, { restrictToUserId: 1 }).entries).toHaveLength(5);
    expect(listAudit(db).entries).toHaveLength(8);

    const page1 = listAudit(db, { limit: 5 });
    expect(page1.entries).toHaveLength(5);
    expect(page1.nextCursor).toBeDefined();
    const page2 = listAudit(db, { limit: 5, cursor: page1.nextCursor });
    expect(page2.entries).toHaveLength(3);
    expect(page2.nextCursor).toBeUndefined();
  });

  test('filters by tool, decision, transport and since; never returns grant_id', () => {
    const db = createTestDb();
    appendAudit(db, base({ toolName: 'a', grantId: 'grant-secret' }));
    appendAudit(db, base({ toolName: 'b', decision: 'invalid_args' }));
    appendAudit(db, base({ toolName: 'b', transport: 'http-mcp' }));
    expect(listAudit(db, { tool: 'b' }).entries).toHaveLength(2);
    expect(listAudit(db, { decision: 'invalid_args' }).entries).toHaveLength(1);
    expect(listAudit(db, { transport: 'http-mcp' }).entries).toHaveLength(1);
    expect(listAudit(db, { since: new Date(Date.now() + 60_000).toISOString() }).entries).toHaveLength(0);
    expect(JSON.stringify(listAudit(db))).not.toContain('grant-secret');
  });
});

describe('REST exports', () => {
  test('an export route writes a transport=rest row', async () => {
    const db = createTestDb();
    seedTestData(db);
    setInitialProfile('test', db);
    const { server } = await startDashboardServer(db, 0);
    servers.push(server);
    const res = await fetch(`http://localhost:${server.port}/api/export/csv`);
    expect(res.status).toBe(200);
    const log = rows(db, "transport = 'rest'");
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ decision: 'rest_export', tool_name: '/api/export/csv', classification: 'read', principal_kind: 'user', principal_id: 'user:anon' });
  });

  test('every export route is GET-only: POST and PATCH get 405 and no ledger body', async () => {
    const db = createTestDb();
    seedTestData(db);
    setInitialProfile('test', db);
    const { server } = await startDashboardServer(db, 0);
    servers.push(server);
    for (const route of ['/api/export/csv', '/api/export/xlsx', '/api/export/pnl', '/api/export/net-worth', '/api/export/training/sft', '/api/export/training/dpo', '/api/export/training/stats']) {
      for (const method of ['POST', 'PATCH', 'DELETE']) {
        const res = await fetch(`http://localhost:${server.port}${route}`, { method, body: method === 'DELETE' ? undefined : '{}' });
        expect(res.status).toBe(405);
        expect(res.headers.get('Allow')).toBe('GET');
        expect(res.headers.get('Content-Disposition')).toBeNull();
        expect(res.headers.get('Content-Type') ?? '').not.toContain('text/csv');
      }
    }
  });

  test('a refused non-GET export attempt is still audited, and a GET writes exactly one row', async () => {
    const db = createTestDb();
    seedTestData(db);
    setInitialProfile('test', db);
    const { server } = await startDashboardServer(db, 0);
    servers.push(server);
    const post = await fetch(`http://localhost:${server.port}/api/export/csv`, { method: 'POST', body: 'x' });
    expect(post.status).toBe(405);
    expect(rows(db, "decision = 'rest_export'")).toHaveLength(1); // the refused attempt
    const before = rows(db, "decision = 'rest_export'").reduce((n, r) => n + Number(r.count), 0);
    const get = await fetch(`http://localhost:${server.port}/api/export/csv`);
    expect(get.status).toBe(200);
    const after = rows(db, "decision = 'rest_export'").reduce((n, r) => n + Number(r.count), 0);
    expect(after).toBe(before + 1);
  });
});
