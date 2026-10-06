import { describe, test, expect, afterEach } from 'bun:test';
import type { Database } from '../db/compat-sqlite.js';
import { createTestDb, seedTestData } from './helpers.js';
import {
  createGrants, validateGrant, revokeGrant, revokeGrantsForSession, revokeGrantsForUser,
  createOperation, getOperation, listPendingOperations, markOperationStatus,
  issueApprovalToken, consumeApprovalToken,
  listGrantsForSession, cleanExpiredGrants, cleanExpiredApprovalTokens, sweepOperations, expireStaleOperations,
  pendingCountForPrincipal, pendingCountForUser, isOperationExpired,
} from '../mcp/store.js';
import { appendAudit } from '../mcp/audit.js';
import { runMcpMaintenance } from '../mcp/maintenance.js';
import { startDashboardServer, stopDashboardServer } from '../dashboard/server.js';
import { setInitialProfile, closeAll } from '../dashboard/db-manager.js';

/**
 * A test DB with the dashboard users the grant fixtures are bound to: a
 * grant whose user_id has no active dashboard user never validates.
 */
function storeDb(): Database {
  const db = createTestDb();
  db.prepare(
    "INSERT INTO dashboard_users (id, username, password_hash, role) VALUES (1, 'user1', 'x', 'admin'), (42, 'user42', 'x', 'admin')"
  ).run();
  return db;
}

function makeGrant(db: Database, overrides: Partial<Parameters<typeof createGrants>[1]> = {}) {
  return createGrants(db, {
    tools: [{ name: 'edit_transaction', schemaDigest: 'digest-1' }],
    userId: 1,
    role: 'admin',
    profile: 'default',
    origin: 'http://localhost:3141',
    sessionGeneration: 'tab-a',
    ...overrides,
  })[0];
}

describe('mcp grants', () => {
  test('a fresh grant validates against its exact scope', () => {
    const db = storeDb();
    const grant = makeGrant(db);
    const result = validateGrant(db, grant.id, 'edit_transaction', 'digest-1', {
      userId: 1, role: 'admin', profile: 'default', origin: 'http://localhost:3141', sessionGeneration: 'tab-a',
    });
    expect(result.ok).toBe(true);
  });

  test('two grants created for the same batch get independent ids', () => {
    const db = storeDb();
    const [a, b] = createGrants(db, {
      tools: [{ name: 'edit_transaction', schemaDigest: 'd1' }, { name: 'transaction_search', schemaDigest: 'd2' }],
      userId: 1, role: 'admin', profile: 'default', origin: 'http://localhost:3141', sessionGeneration: 'tab-a',
    });
    expect(a.id).not.toBe(b.id);
    expect(a.batch_id).toBe(b.batch_id);
  });

  test('wrong tool name fails scope_mismatch', () => {
    const db = storeDb();
    const grant = makeGrant(db);
    const result = validateGrant(db, grant.id, 'delete_transaction', 'digest-1', {
      userId: 1, role: 'admin', profile: 'default', origin: 'http://localhost:3141', sessionGeneration: 'tab-a',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('scope_mismatch');
  });

  test('schema digest change invalidates the grant', () => {
    const db = storeDb();
    const grant = makeGrant(db);
    const result = validateGrant(db, grant.id, 'edit_transaction', 'digest-CHANGED', {
      userId: 1, role: 'admin', profile: 'default', origin: 'http://localhost:3141', sessionGeneration: 'tab-a',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('schema_changed');
  });

  test('profile switch invalidates the grant', () => {
    const db = storeDb();
    const grant = makeGrant(db, { profile: 'personal' });
    const result = validateGrant(db, grant.id, 'edit_transaction', 'digest-1', {
      userId: 1, role: 'admin', profile: 'business', origin: 'http://localhost:3141', sessionGeneration: 'tab-a',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('scope_mismatch');
  });

  test('foreign origin invalidates the grant', () => {
    const db = storeDb();
    const grant = makeGrant(db);
    const result = validateGrant(db, grant.id, 'edit_transaction', 'digest-1', {
      userId: 1, role: 'admin', profile: 'default', origin: 'http://evil.example', sessionGeneration: 'tab-a',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('scope_mismatch');
  });

  test('a different browser tab (session generation) cannot use another tab\'s grant', () => {
    const db = storeDb();
    const grant = makeGrant(db, { sessionGeneration: 'tab-a' });
    const result = validateGrant(db, grant.id, 'edit_transaction', 'digest-1', {
      userId: 1, role: 'admin', profile: 'default', origin: 'http://localhost:3141', sessionGeneration: 'tab-b',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('scope_mismatch');
  });

  test('viewer role cannot use an admin-scoped grant', () => {
    const db = storeDb();
    const grant = makeGrant(db, { role: 'admin' });
    const result = validateGrant(db, grant.id, 'edit_transaction', 'digest-1', {
      userId: 1, role: 'viewer', profile: 'default', origin: 'http://localhost:3141', sessionGeneration: 'tab-a',
    });
    expect(result.ok).toBe(false);
  });

  test('revokeGrant invalidates immediately', () => {
    const db = storeDb();
    const grant = makeGrant(db);
    revokeGrant(db, grant.id);
    const result = validateGrant(db, grant.id, 'edit_transaction', 'digest-1', {
      userId: 1, role: 'admin', profile: 'default', origin: 'http://localhost:3141', sessionGeneration: 'tab-a',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('revoked');
  });

  test('revokeGrantsForSession only touches that session\'s grants', () => {
    const db = storeDb();
    const grantA = makeGrant(db, { sessionGeneration: 'tab-a' });
    const grantB = makeGrant(db, { sessionGeneration: 'tab-b' });
    revokeGrantsForSession(db, 'tab-a');
    expect(validateGrant(db, grantA.id, 'edit_transaction', 'digest-1', {
      userId: 1, role: 'admin', profile: 'default', origin: 'http://localhost:3141', sessionGeneration: 'tab-a',
    }).ok).toBe(false);
    expect(validateGrant(db, grantB.id, 'edit_transaction', 'digest-1', {
      userId: 1, role: 'admin', profile: 'default', origin: 'http://localhost:3141', sessionGeneration: 'tab-b',
    }).ok).toBe(true);
  });

  test('logout (revokeGrantsForUser) kills every grant for that user regardless of tab', () => {
    const db = storeDb();
    const grantA = makeGrant(db, { userId: 42, sessionGeneration: 'tab-a' });
    const grantB = makeGrant(db, { userId: 42, sessionGeneration: 'tab-b' });
    revokeGrantsForUser(db, 42);
    for (const [grant, sessionGeneration] of [[grantA, 'tab-a'], [grantB, 'tab-b']] as const) {
      const result = validateGrant(db, grant.id, 'edit_transaction', 'digest-1', {
        userId: 42, role: 'admin', profile: 'default', origin: 'http://localhost:3141', sessionGeneration,
      });
      expect(result.ok).toBe(false);
    }
  });
});

describe('mcp expiry honoured to the second (#151)', () => {
  // expires_at is ISO ('T' separator); datetime('now') uses a space, so a plain
  // text compare treats anything expiring later the same UTC day as still live.
  const op = (db: Database, ttlMs: number) => createOperation(db, {
    source: 'webmcp', grantId: 'g', toolName: 'edit_transaction', args: {}, before: null, after: null,
    transactionId: 1, revisionAtPrepare: 1, profile: 'default',
    origin: 'http://localhost:3141', sessionGeneration: 'tab-a', userId: 1, role: 'admin', ttlMs,
  });

  test('a grant that expired seconds ago is not listed for its session', () => {
    const db = storeDb();
    const expired = makeGrant(db, { ttlMs: -5_000 });
    const live = makeGrant(db, { ttlMs: 60_000 });
    expect(listGrantsForSession(db, 'tab-a').map((g) => g.id)).toEqual([live.id]);
    expect(expired.id).not.toBe(live.id);
  });

  test('cleanExpiredGrants deletes a grant that expired seconds ago', () => {
    const db = storeDb();
    makeGrant(db, { ttlMs: -5_000 });
    makeGrant(db, { ttlMs: 60_000 });
    // No grace period: WebMCP keeps recently expired rows for 7 days by default (Activity), which would hide the check.
    expect(cleanExpiredGrants(db, 0)).toBe(1);
  });

  test('a pending operation that expired seconds ago leaves the queue and is swept', () => {
    const db = storeDb();
    const stale = op(db, -5_000);
    const live = op(db, 60_000);
    expect(listPendingOperations(db).map((o) => o.id)).toEqual([live.id]);
    expect(expireStaleOperations(db)).toBe(1);
    expect(getOperation(db, stale.id)?.status).toBe('expired');
    expect(getOperation(db, live.id)?.status).toBe('pending');
  });
});

describe('mcp operations + approval tokens', () => {
  function makeOperation(db: Database) {
    return createOperation(db, {
      source: 'webmcp',
      grantId: 'grant-1',
      toolName: 'edit_transaction',
      args: { id: 1, notes: 'hi' },
      before: { notes: null },
      after: { notes: 'hi' },
      transactionId: 1,
      revisionAtPrepare: 1,
      profile: 'default',
      origin: 'http://localhost:3141',
      sessionGeneration: 'tab-a',
      userId: 1,
      role: 'admin',
    });
  }

  test('a prepared operation starts pending and appears in the queue', () => {
    const db = storeDb();
    const op = makeOperation(db);
    expect(op.status).toBe('pending');
    expect(listPendingOperations(db).map((o) => o.id)).toContain(op.id);
  });

  test('createOperation persists the server-computed summary (what the confirmation card names the change by)', () => {
    const db = storeDb();
    const op = createOperation(db, {
      source: 'webmcp',
      grantId: 'grant-1',
      toolName: 'categorize_transaction',
      args: { id: 1, category: 'Home' },
      before: { category: null },
      after: { category: 'Home' },
      summary: 'Categorize "MAPLE AVE APARTMENTS RENT" (2026-08-01) as "Home"',
      transactionId: 1,
      revisionAtPrepare: 1,
      profile: 'default',
      origin: 'http://localhost:3141',
      sessionGeneration: 'tab-a',
      userId: 1,
      role: 'admin',
    });
    expect(op.summary).toBe('Categorize "MAPLE AVE APARTMENTS RENT" (2026-08-01) as "Home"');
    // Chat-shaped ops pass no summary — it persists as null, not a crash.
    const bare = createOperation(db, {
      source: 'chat', grantId: null, toolName: 'categorize', args: {},
      before: null, after: null, transactionId: null, revisionAtPrepare: null,
      profile: 'default', origin: 'dashboard-chat', sessionGeneration: 'chat',
      userId: null, role: 'admin',
    });
    expect(bare.summary).toBeNull();
  });

  test('marking an operation resolved removes it from the pending queue', () => {
    const db = storeDb();
    const op = makeOperation(db);
    markOperationStatus(db, op.id, 'committed', { ok: true });
    expect(listPendingOperations(db).map((o) => o.id)).not.toContain(op.id);
    expect(getOperation(db, op.id)?.status).toBe('committed');
  });

  test('an approval token can only be consumed once (duplicate commit attempt)', () => {
    const db = storeDb();
    const op = makeOperation(db);
    const { token } = issueApprovalToken(db, op.id);

    const first = consumeApprovalToken(db, token);
    expect(first.ok).toBe(true);

    const second = consumeApprovalToken(db, token);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe('already_used');
  });

  test('an unknown token is rejected', () => {
    const db = storeDb();
    const result = consumeApprovalToken(db, 'not-a-real-token');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('not_found');
  });
});


// ── P0a: cleanup, ownership scoping, expiry arithmetic ──────────────────────

const DAY = 86_400_000;
const isoAgo = (ms: number) => new Date(Date.now() - ms).toISOString();

function insertGrantRow(db: Database, id: string, expiresAt: string, overrides: Record<string, unknown> = {}) {
  db.prepare(`
    INSERT INTO mcp_grants (id, batch_id, tool_name, schema_digest, user_id, role, profile, origin, session_generation, expires_at)
    VALUES (@id, 'b', 'edit_transaction', 'd', @userId, 'admin', 'default', 'http://localhost:3141', @session, @expiresAt)
  `).run({ id, expiresAt, userId: 1, session: 'tab-a', ...overrides });
}

function opRow(db: Database, overrides: Partial<Parameters<typeof createOperation>[1]> = {}) {
  return createOperation(db, {
    source: 'webmcp', grantId: 'grant-1', toolName: 'edit_transaction', args: { id: 1, notes: 'x' },
    before: null, after: null, transactionId: 1, revisionAtPrepare: 1, profile: 'default',
    origin: 'http://localhost:3141', sessionGeneration: 'tab-a', userId: 1, role: 'admin', ...overrides,
  });
}

describe('expiry arithmetic (ISO timestamps, not text compared with datetime())', () => {
  test('an operation that expired a second ago, today, is not pending', () => {
    const db = createTestDb();
    const op = opRow(db, { ttlMs: -1000 });
    expect(isOperationExpired(op)).toBe(true);
    expect(listPendingOperations(db).map((o) => o.id)).not.toContain(op.id);
    expect(expireStaleOperations(db)).toBe(1);
    expect(getOperation(db, op.id)!.status).toBe('expired');
  });

  test('a grant that expired a second ago, today, is not listed', () => {
    const db = createTestDb();
    insertGrantRow(db, 'g-old', isoAgo(1000));
    insertGrantRow(db, 'g-live', new Date(Date.now() + 60_000).toISOString());
    expect(listGrantsForSession(db, 'tab-a').map((g) => g.id)).toEqual(['g-live']);
  });
});

describe('cleanup sweeps', () => {
  test('cleanExpiredGrants keeps rows within the 7-day grace', () => {
    const db = createTestDb();
    insertGrantRow(db, 'g-live', new Date(Date.now() + DAY).toISOString());
    insertGrantRow(db, 'g-1d', isoAgo(1 * DAY));
    insertGrantRow(db, 'g-6d', isoAgo(6 * DAY));
    insertGrantRow(db, 'g-8d', isoAgo(8 * DAY));
    insertGrantRow(db, 'g-30d', isoAgo(30 * DAY));
    expect(cleanExpiredGrants(db)).toBe(2);
    const left = (db.prepare('SELECT id FROM mcp_grants ORDER BY id').all() as { id: string }[]).map((r) => r.id);
    expect(left).toEqual(['g-1d', 'g-6d', 'g-live']);
    expect(cleanExpiredGrants(db, 0)).toBe(2);
  });

  test('sweepOperations deletes resolved ops older than 7 days, keeps pending and recent ones', () => {
    const db = createTestDb();
    const oldDone = opRow(db);
    const recentDone = opRow(db);
    const pending = opRow(db);
    markOperationStatus(db, oldDone.id, 'committed', { ok: true });
    markOperationStatus(db, recentDone.id, 'rejected');
    db.prepare("UPDATE mcp_operations SET resolved_at = datetime('now', '-8 days') WHERE id = @id").run({ id: oldDone.id });
    db.prepare("UPDATE mcp_operations SET resolved_at = datetime('now', '-2 days') WHERE id = @id").run({ id: recentDone.id });
    expect(sweepOperations(db)).toBe(1);
    expect(getOperation(db, oldDone.id)).toBeNull();
    expect(getOperation(db, recentDone.id)).not.toBeNull();
    expect(getOperation(db, pending.id)!.status).toBe('pending');
  });

  test('sweepOperations first expires stale pending ops, and takes their approval tokens with them', () => {
    const db = createTestDb();
    const op = opRow(db, { ttlMs: -1000 });
    const { token } = issueApprovalToken(db, op.id);
    sweepOperations(db);
    expect(getOperation(db, op.id)!.status).toBe('expired');
    // Backdate the resolution: the next sweep deletes the op, and the token goes with it (ON DELETE CASCADE).
    db.prepare("UPDATE mcp_operations SET resolved_at = datetime('now', '-9 days') WHERE id = @id").run({ id: op.id });
    sweepOperations(db);
    expect(getOperation(db, op.id)).toBeNull();
    expect(consumeApprovalToken(db, token).ok).toBe(false);
  });

  test('cleanExpiredApprovalTokens removes only expired tokens', () => {
    const db = createTestDb();
    const op = opRow(db);
    const live = issueApprovalToken(db, op.id);
    const dead = issueApprovalToken(db, op.id);
    db.prepare('UPDATE mcp_approval_tokens SET expires_at = @t WHERE token = @token').run({ t: isoAgo(1000), token: dead.token });
    expect(cleanExpiredApprovalTokens(db)).toBe(1);
    expect(consumeApprovalToken(db, live.token).ok).toBe(true);
  });
});

describe('ownership-scoped grant helpers', () => {
  const owner = { userId: 1, profile: 'default', origin: 'http://localhost:3141' };

  test('listGrantsForSession and revokeGrant honor the owner filter', () => {
    const db = createTestDb();
    const grant = makeGrant(db, { userId: 1 });
    expect(listGrantsForSession(db, 'tab-a', owner)).toHaveLength(1);
    expect(listGrantsForSession(db, 'tab-a', { ...owner, userId: 2 })).toHaveLength(0);
    expect(listGrantsForSession(db, 'tab-a', { ...owner, profile: 'other' })).toHaveLength(0);
    expect(listGrantsForSession(db, 'tab-a', { ...owner, origin: 'http://evil.example' })).toHaveLength(0);
    expect(revokeGrant(db, grant.id, { ...owner, userId: 2 })).toBe(0);
    expect(revokeGrant(db, grant.id, owner)).toBe(1);
    expect(revokeGrant(db, grant.id, owner)).toBe(0); // already revoked
  });

  test('a NULL user (auth off) matches only NULL-user grants', () => {
    const db = createTestDb();
    makeGrant(db, { userId: null });
    const noAuth = { userId: null, profile: 'default', origin: 'http://localhost:3141' };
    expect(listGrantsForSession(db, 'tab-a', noAuth)).toHaveLength(1);
    expect(listGrantsForSession(db, 'tab-a', owner)).toHaveLength(0);
  });

  test('revokeGrantsForSession with an owner revokes only that owner\'s rows', () => {
    const db = createTestDb();
    makeGrant(db, { userId: 1 });
    expect(revokeGrantsForSession(db, 'tab-a', { ...owner, userId: 2 })).toBe(0);
    expect(revokeGrantsForSession(db, 'tab-a', owner)).toBe(1);
  });

  test('the unscoped forms keep working', () => {
    const db = createTestDb();
    const grant = makeGrant(db);
    expect(listGrantsForSession(db, 'tab-a')).toHaveLength(1);
    expect(revokeGrant(db, grant.id)).toBe(1);
  });
});

describe('pending counts', () => {
  test('per principal and per user, excluding chat and resolved operations', () => {
    const db = createTestDb();
    opRow(db, { sessionGeneration: 'tab-a', userId: 1 });
    opRow(db, { sessionGeneration: 'tab-a', userId: 1 });
    opRow(db, { sessionGeneration: 'tab-b', userId: 1 });
    opRow(db, { sessionGeneration: 'tab-c', userId: null });
    opRow(db, { source: 'chat', sessionGeneration: 'dashboard-chat', userId: 1 });
    const done = opRow(db, { sessionGeneration: 'tab-a', userId: 1 });
    markOperationStatus(db, done.id, 'rejected');
    expect(pendingCountForPrincipal(db, 'tab-a')).toBe(2);
    expect(pendingCountForPrincipal(db, 'tab-b')).toBe(1);
    expect(pendingCountForUser(db, 1)).toBe(3);
    expect(pendingCountForUser(db, null)).toBe(1);
  });
});

describe('server startup and maintenance', () => {
  const servers: Awaited<ReturnType<typeof startDashboardServer>>['server'][] = [];
  afterEach(() => {
    for (const sv of servers) {
      try { stopDashboardServer(sv); } catch { /* */ }
    }
    servers.length = 0;
    closeAll();
  });

  function seedOldRows(db: Database) {
    insertGrantRow(db, 'g-ancient', isoAgo(30 * DAY));
    insertGrantRow(db, 'g-recent', isoAgo(1 * DAY));
    const op = opRow(db);
    markOperationStatus(db, op.id, 'committed');
    db.prepare("UPDATE mcp_operations SET resolved_at = datetime('now', '-10 days') WHERE id = @id").run({ id: op.id });
    const live = opRow(db);
    const tokenOp = opRow(db);
    const { token } = issueApprovalToken(db, tokenOp.id);
    db.prepare('UPDATE mcp_approval_tokens SET expires_at = @t WHERE token = @token').run({ t: isoAgo(1000), token });
    appendAudit(db, {
      transport: 'imperative', principalKind: 'tab', principalId: 'abcd', userId: null, role: 'admin', origin: 'o',
      toolName: 't', classification: 'read', decision: 'allowed', ts: isoAgo(200 * DAY),
    });
    return { op, live, tokenOp };
  }

  test('runMcpMaintenance runs every sweep', () => {
    const db = createTestDb();
    const { op, live } = seedOldRows(db);
    const result = runMcpMaintenance(db);
    expect(result.grants).toBe(1);
    expect(result.approvalTokens).toBe(1);
    expect(result.operations).toBe(1);
    expect(result.audit?.expired).toBe(1);
    expect(getOperation(db, op.id)).toBeNull();
    expect(getOperation(db, live.id)!.status).toBe('pending');
  });

  test('server startup invokes the sweeps', async () => {
    const db = createTestDb();
    seedTestData(db);
    const { op } = seedOldRows(db);
    setInitialProfile('test', db);
    const { server } = await startDashboardServer(db, 0);
    servers.push(server);
    expect(getOperation(db, op.id)).toBeNull();
    expect((db.prepare("SELECT COUNT(*) AS n FROM mcp_grants WHERE id = 'g-ancient'").get() as { n: number }).n).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS n FROM mcp_grants WHERE id = 'g-recent'").get() as { n: number }).n).toBe(1);
    expect((db.prepare('SELECT COUNT(*) AS n FROM mcp_approval_tokens').get() as { n: number }).n).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS n FROM mcp_audit_log WHERE decision = 'allowed'").get() as { n: number }).n).toBe(0);
  });

  test('stopDashboardServer clears the 6-hourly timer (no leaked interval keeps the process alive)', async () => {
    const db = createTestDb();
    setInitialProfile('test', db);
    const realSet = globalThis.setInterval;
    const realClear = globalThis.clearInterval;
    const set: unknown[] = [];
    const cleared: unknown[] = [];
    globalThis.setInterval = ((fn: any, ms: any, ...rest: any[]) => {
      const handle = realSet(fn, ms, ...rest);
      if (ms === 6 * 60 * 60 * 1000) set.push(handle);
      return handle;
    }) as typeof setInterval;
    globalThis.clearInterval = ((h: any) => {
      cleared.push(h);
      return realClear(h);
    }) as typeof clearInterval;
    try {
      const { server } = await startDashboardServer(db, 0);
      expect(set).toHaveLength(1);
      stopDashboardServer(server);
      expect(cleared).toContain(set[0]);
    } finally {
      globalThis.setInterval = realSet;
      globalThis.clearInterval = realClear;
    }
  });
});
