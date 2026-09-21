import { describe, test, expect } from 'bun:test';
import type { Database } from '../db/compat-sqlite.js';
import { createTestDb } from './helpers.js';
import {
  createGrants, validateGrant, revokeGrant, revokeGrantsForSession, revokeGrantsForUser,
  createOperation, getOperation, listPendingOperations, markOperationStatus,
  issueApprovalToken, consumeApprovalToken,
} from '../mcp/store.js';

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
    const db = createTestDb();
    const grant = makeGrant(db);
    const result = validateGrant(db, grant.id, 'edit_transaction', 'digest-1', {
      userId: 1, role: 'admin', profile: 'default', origin: 'http://localhost:3141', sessionGeneration: 'tab-a',
    });
    expect(result.ok).toBe(true);
  });

  test('two grants created for the same batch get independent ids', () => {
    const db = createTestDb();
    const [a, b] = createGrants(db, {
      tools: [{ name: 'edit_transaction', schemaDigest: 'd1' }, { name: 'transaction_search', schemaDigest: 'd2' }],
      userId: 1, role: 'admin', profile: 'default', origin: 'http://localhost:3141', sessionGeneration: 'tab-a',
    });
    expect(a.id).not.toBe(b.id);
    expect(a.batch_id).toBe(b.batch_id);
  });

  test('wrong tool name fails scope_mismatch', () => {
    const db = createTestDb();
    const grant = makeGrant(db);
    const result = validateGrant(db, grant.id, 'delete_transaction', 'digest-1', {
      userId: 1, role: 'admin', profile: 'default', origin: 'http://localhost:3141', sessionGeneration: 'tab-a',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('scope_mismatch');
  });

  test('schema digest change invalidates the grant', () => {
    const db = createTestDb();
    const grant = makeGrant(db);
    const result = validateGrant(db, grant.id, 'edit_transaction', 'digest-CHANGED', {
      userId: 1, role: 'admin', profile: 'default', origin: 'http://localhost:3141', sessionGeneration: 'tab-a',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('schema_changed');
  });

  test('profile switch invalidates the grant', () => {
    const db = createTestDb();
    const grant = makeGrant(db, { profile: 'personal' });
    const result = validateGrant(db, grant.id, 'edit_transaction', 'digest-1', {
      userId: 1, role: 'admin', profile: 'business', origin: 'http://localhost:3141', sessionGeneration: 'tab-a',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('scope_mismatch');
  });

  test('foreign origin invalidates the grant', () => {
    const db = createTestDb();
    const grant = makeGrant(db);
    const result = validateGrant(db, grant.id, 'edit_transaction', 'digest-1', {
      userId: 1, role: 'admin', profile: 'default', origin: 'http://evil.example', sessionGeneration: 'tab-a',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('scope_mismatch');
  });

  test('a different browser tab (session generation) cannot use another tab\'s grant', () => {
    const db = createTestDb();
    const grant = makeGrant(db, { sessionGeneration: 'tab-a' });
    const result = validateGrant(db, grant.id, 'edit_transaction', 'digest-1', {
      userId: 1, role: 'admin', profile: 'default', origin: 'http://localhost:3141', sessionGeneration: 'tab-b',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('scope_mismatch');
  });

  test('viewer role cannot use an admin-scoped grant', () => {
    const db = createTestDb();
    const grant = makeGrant(db, { role: 'admin' });
    const result = validateGrant(db, grant.id, 'edit_transaction', 'digest-1', {
      userId: 1, role: 'viewer', profile: 'default', origin: 'http://localhost:3141', sessionGeneration: 'tab-a',
    });
    expect(result.ok).toBe(false);
  });

  test('revokeGrant invalidates immediately', () => {
    const db = createTestDb();
    const grant = makeGrant(db);
    revokeGrant(db, grant.id);
    const result = validateGrant(db, grant.id, 'edit_transaction', 'digest-1', {
      userId: 1, role: 'admin', profile: 'default', origin: 'http://localhost:3141', sessionGeneration: 'tab-a',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('revoked');
  });

  test('revokeGrantsForSession only touches that session\'s grants', () => {
    const db = createTestDb();
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
    const db = createTestDb();
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
    const db = createTestDb();
    const op = makeOperation(db);
    expect(op.status).toBe('pending');
    expect(listPendingOperations(db).map((o) => o.id)).toContain(op.id);
  });

  test('marking an operation resolved removes it from the pending queue', () => {
    const db = createTestDb();
    const op = makeOperation(db);
    markOperationStatus(db, op.id, 'committed', { ok: true });
    expect(listPendingOperations(db).map((o) => o.id)).not.toContain(op.id);
    expect(getOperation(db, op.id)?.status).toBe('committed');
  });

  test('an approval token can only be consumed once (duplicate commit attempt)', () => {
    const db = createTestDb();
    const op = makeOperation(db);
    const { token } = issueApprovalToken(db, op.id);

    const first = consumeApprovalToken(db, token);
    expect(first.ok).toBe(true);

    const second = consumeApprovalToken(db, token);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe('already_used');
  });

  test('an unknown token is rejected', () => {
    const db = createTestDb();
    const result = consumeApprovalToken(db, 'not-a-real-token');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('not_found');
  });
});
