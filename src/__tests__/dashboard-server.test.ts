import { describe, expect, test, afterEach } from 'bun:test';
import { createTestDb } from './helpers.js';
import { startDashboardServer, stopDashboardServer } from '../dashboard/server.js';
import { setInitialProfile, closeAll } from '../dashboard/db-manager.js';
import { createUser, enableAuth } from '../dashboard/auth.js';
import { insertTransactions } from '../db/queries.js';
import { insertAccount } from '../db/net-worth-queries.js';
import type { Database } from '../db/compat-sqlite.js';

/** Spin up a fresh server with an in-memory DB. */
async function createServer() {
  const db = createTestDb();
  setInitialProfile('test', db);
  const result = await startDashboardServer(db, 0);
  return { db, server: result.server, base: `http://localhost:${result.server.port}` };
}

describe('dashboard server', () => {
  const servers: Awaited<ReturnType<typeof startDashboardServer>>['server'][] = [];

  afterEach(() => {
    for (const s of servers) {
      try { stopDashboardServer(s); } catch { /* */ }
    }
    servers.length = 0;
    closeAll();
  });

  async function start() {
    const ctx = await createServer();
    servers.push(ctx.server);
    return ctx;
  }

  // ── Basic routes ─────────────────────────────────────────────────────────

  describe('basic routes', () => {
    test('GET / returns HTML', async () => {
      const { base } = await start();
      const res = await fetch(base + '/');
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/html');
      const text = await res.text();
      expect(text).toContain('Open Accountant Dashboard');
    });

    test('GET /api/summary returns JSON', async () => {
      const { base } = await start();
      const res = await fetch(base + '/api/summary');
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toBeDefined();
    });

    test('GET /unknown returns 404', async () => {
      const { base } = await start();
      const res = await fetch(base + '/unknown');
      expect(res.status).toBe(404);
    });

    test('OPTIONS returns 204 with CORS headers', async () => {
      const { base } = await start();
      const res = await fetch(base + '/api/summary', { method: 'OPTIONS' });
      expect(res.status).toBe(204);
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
      expect(res.headers.get('Access-Control-Allow-Methods')).toContain('GET');
    });
  });

  // ── Auth routes ──────────────────────────────────────────────────────────

  describe('auth API', () => {
    test('GET /api/auth/status returns auth disabled by default', async () => {
      const { base } = await start();
      const res = await fetch(base + '/api/auth/status');
      const data = await res.json();
      expect(data.authEnabled).toBe(false);
      expect(data.user).toBeNull();
      expect(data.userCount).toBe(0);
    });

    test('POST /api/auth/setup creates first admin', async () => {
      const { base } = await start();
      const res = await fetch(base + '/api/auth/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'adminpass' }),
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.user.username).toBe('admin');
      expect(data.user.role).toBe('admin');
      expect(data.token).toBeDefined();
      expect(data.token.length).toBe(64);
    });

    test('POST /api/auth/setup rejects when admin exists', async () => {
      const { db, base } = await start();
      await createUser(db, 'existing', 'pass', 'admin');
      const res = await fetch(base + '/api/auth/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'another', password: 'pass' }),
      });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain('Admin already exists');
    });

    test('POST /api/auth/login returns token', async () => {
      const { db, base } = await start();
      await createUser(db, 'loginuser', 'mypassword', 'admin');
      enableAuth(db);
      const res = await fetch(base + '/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'loginuser', password: 'mypassword' }),
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.token).toBeDefined();
      expect(data.user.username).toBe('loginuser');
    });

    test('POST /api/auth/login rejects bad credentials', async () => {
      const { db, base } = await start();
      await createUser(db, 'loginuser', 'mypassword');
      enableAuth(db);
      const res = await fetch(base + '/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'loginuser', password: 'wrong' }),
      });
      expect(res.status).toBe(401);
    });

    test('POST /api/auth/logout revokes token', async () => {
      const { db, base } = await start();
      await createUser(db, 'logoutuser', 'pass');
      enableAuth(db);
      const loginRes = await fetch(base + '/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'logoutuser', password: 'pass' }),
      });
      const { token } = await loginRes.json();

      const logoutRes = await fetch(base + '/api/auth/logout', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(logoutRes.status).toBe(200);

      // Token should now be invalid
      const checkRes = await fetch(base + '/api/summary', {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(checkRes.status).toBe(401);
    });
  });

  // ── RBAC ─────────────────────────────────────────────────────────────────

  describe('RBAC enforcement', () => {
    async function setupRbac() {
      const { db, base } = await start();
      await createUser(db, 'admin', 'adminpass', 'admin');
      await createUser(db, 'viewer', 'viewerpass', 'viewer');
      enableAuth(db);

      const adminLogin = await fetch(base + '/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'adminpass' }),
      });
      const adminToken = (await adminLogin.json()).token;

      const viewerLogin = await fetch(base + '/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'viewer', password: 'viewerpass' }),
      });
      const viewerToken = (await viewerLogin.json()).token;

      // Seed a transaction for edit/delete tests
      insertTransactions(db, [
        { date: '2026-01-01', description: 'RBAC Test', amount: -10, category: 'Test' },
      ]);

      return { db, base, adminToken, viewerToken };
    }

    test('unauthenticated request to protected route returns 401', async () => {
      const { base } = await setupRbac();
      const res = await fetch(base + '/api/summary');
      expect(res.status).toBe(401);
    });

    test('authenticated viewer can read data', async () => {
      const { base, viewerToken } = await setupRbac();
      const res = await fetch(base + '/api/summary', {
        headers: { Authorization: `Bearer ${viewerToken}` },
      });
      expect(res.status).toBe(200);
    });

    test('authenticated admin can read data', async () => {
      const { base, adminToken } = await setupRbac();
      const res = await fetch(base + '/api/summary', {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      expect(res.status).toBe(200);
    });

    test('viewer cannot edit transactions', async () => {
      const { db, base, viewerToken } = await setupRbac();
      const rows = db.prepare('SELECT id FROM transactions LIMIT 1').all() as { id: number }[];

      const res = await fetch(base + `/api/transactions/${rows[0].id}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${viewerToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ category: 'Hacked' }),
      });
      expect(res.status).toBe(403);
    });

    test('admin can edit transactions', async () => {
      const { db, base, adminToken } = await setupRbac();
      const rows = db.prepare('SELECT id FROM transactions LIMIT 1').all() as { id: number }[];

      const res = await fetch(base + `/api/transactions/${rows[0].id}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ category: 'Updated' }),
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
    });

    test('viewer cannot delete transactions', async () => {
      const { db, base, viewerToken } = await setupRbac();
      const rows = db.prepare('SELECT id FROM transactions LIMIT 1').all() as { id: number }[];

      const res = await fetch(base + `/api/transactions/${rows[0].id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${viewerToken}` },
      });
      expect(res.status).toBe(403);
    });

    test('admin can delete transactions', async () => {
      const { db, base, adminToken } = await setupRbac();
      const rows = db.prepare('SELECT id FROM transactions LIMIT 1').all() as { id: number }[];

      const res = await fetch(base + `/api/transactions/${rows[0].id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      expect(res.status).toBe(200);
    });

    test('viewer cannot manage users', async () => {
      const { base, viewerToken } = await setupRbac();
      const res = await fetch(base + '/api/auth/users', {
        headers: { Authorization: `Bearer ${viewerToken}` },
      });
      expect(res.status).toBe(403);
    });

    test('admin can list users', async () => {
      const { base, adminToken } = await setupRbac();
      const res = await fetch(base + '/api/auth/users', {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toHaveLength(2);
    });

    test('admin can create users', async () => {
      const { base, adminToken } = await setupRbac();
      const res = await fetch(base + '/api/auth/users', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ username: 'newuser', password: 'newpass', role: 'viewer' }),
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.username).toBe('newuser');
      expect(data.role).toBe('viewer');
    });

    test('viewer cannot toggle auth config', async () => {
      const { base, viewerToken } = await setupRbac();
      const res = await fetch(base + '/api/auth/config', {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${viewerToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ auth_enabled: false }),
      });
      expect(res.status).toBe(403);
    });

    test('viewer cannot switch profiles', async () => {
      const { base, viewerToken } = await setupRbac();
      const res = await fetch(base + '/api/profiles/switch', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${viewerToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: 'other' }),
      });
      expect(res.status).toBe(403);
    });

    test('token via query param works', async () => {
      const { base, viewerToken } = await setupRbac();
      const res = await fetch(base + `/api/summary?token=${viewerToken}`);
      expect(res.status).toBe(200);
    });

    test('public auth routes accessible without token when auth enabled', async () => {
      const { base } = await setupRbac();
      const statusRes = await fetch(base + '/api/auth/status');
      expect(statusRes.status).toBe(200);

      const loginRes = await fetch(base + '/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'adminpass' }),
      });
      expect(loginRes.status).toBe(200);
    });

    test('HTML page accessible without token (login page renders)', async () => {
      const { base } = await setupRbac();
      const res = await fetch(base + '/');
      expect(res.status).toBe(200);
    });
  });

  // ── Accounts & Net Worth routes ──────────────────────────────────────────

  describe('accounts and net worth', () => {
    test('GET /api/accounts returns active accounts', async () => {
      const { db, base } = await start();
      insertAccount(db, {
        name: 'Checking',
        account_type: 'asset',
        account_subtype: 'checking',
        current_balance: 5000,
      });
      insertAccount(db, {
        name: 'Savings',
        account_type: 'asset',
        account_subtype: 'savings',
        current_balance: 10000,
      });

      const res = await fetch(base + '/api/accounts');
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toHaveLength(2);
    });

    test('GET /api/net-worth returns summary', async () => {
      const { db, base } = await start();
      insertAccount(db, {
        name: 'Checking',
        account_type: 'asset',
        account_subtype: 'checking',
        current_balance: 10000,
      });
      insertAccount(db, {
        name: 'Credit Card',
        account_type: 'liability',
        account_subtype: 'credit_card',
        current_balance: 2000,
      });

      const res = await fetch(base + '/api/net-worth');
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.totalAssets).toBe(10000);
      expect(data.totalLiabilities).toBe(2000);
      expect(data.netWorth).toBe(8000);
    });

    test('GET /api/net-worth/trend returns array', async () => {
      const { base } = await start();
      const res = await fetch(base + '/api/net-worth/trend?months=6');
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(Array.isArray(data)).toBe(true);
    });

    test('GET /api/accounts/:id/transactions returns filtered txns', async () => {
      const { db, base } = await start();
      const accountId = insertAccount(db, {
        name: 'Test Card',
        account_type: 'liability',
        account_subtype: 'credit_card',
      });
      insertTransactions(db, [
        { date: '2026-01-01', description: 'Linked', amount: -50, category: 'Food' },
        { date: '2026-01-02', description: 'Unlinked', amount: -30, category: 'Food' },
      ]);
      db.prepare('UPDATE transactions SET account_id = @accountId WHERE description = @desc')
        .run({ accountId, desc: 'Linked' });

      const res = await fetch(base + `/api/accounts/${accountId}/transactions`);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toHaveLength(1);
      expect(data[0].description).toBe('Linked');
    });
  });

  // ── Export routes ────────────────────────────────────────────────────────

  describe('export', () => {
    test('GET /api/export/csv returns CSV', async () => {
      const { db, base } = await start();
      insertTransactions(db, [
        { date: '2026-01-15', description: 'Test', amount: -25, category: 'Food' },
      ]);
      const res = await fetch(base + '/api/export/csv');
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/csv');
      expect(res.headers.get('content-disposition')).toContain('transactions.csv');
      const text = await res.text();
      expect(text).toContain('Date,Description,Amount,Category');
      expect(text).toContain('Test');
    });

    test('GET /api/export/pnl returns P&L CSV', async () => {
      const { db, base } = await start();
      insertTransactions(db, [
        { date: '2026-02-15', description: 'Income', amount: 3000, category: 'Salary' },
        { date: '2026-02-16', description: 'Expense', amount: -100, category: 'Food' },
      ]);
      const res = await fetch(base + '/api/export/pnl?month=2026-02');
      expect(res.status).toBe(200);
      expect(res.headers.get('content-disposition')).toContain('pnl.csv');
      const text = await res.text();
      expect(text).toContain('Type,Category,Amount,Count');
    });

    test('GET /api/export/net-worth returns net worth CSV', async () => {
      const { db, base } = await start();
      insertAccount(db, {
        name: 'My Account',
        account_type: 'asset',
        account_subtype: 'checking',
        current_balance: 5000,
      });
      const res = await fetch(base + '/api/export/net-worth');
      expect(res.status).toBe(200);
      expect(res.headers.get('content-disposition')).toContain('net-worth.csv');
      const text = await res.text();
      expect(text).toContain('Name,Type,Subtype,Institution,Balance');
      expect(text).toContain('My Account');
    });
  });

  // ── Profile routes ───────────────────────────────────────────────────────

  describe('profiles', () => {
    test('GET /api/profiles returns profiles and active', async () => {
      const { base } = await start();
      const res = await fetch(base + '/api/profiles');
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.profiles).toBeDefined();
      expect(data.active).toBeDefined();
    });
  });

  // ── accountId filtering ──────────────────────────────────────────────────

  describe('accountId filtering', () => {
    test('GET /api/transactions?accountId filters results', async () => {
      const { db, base } = await start();
      const accountId = insertAccount(db, {
        name: 'Filter Test',
        account_type: 'asset',
        account_subtype: 'checking',
      });
      insertTransactions(db, [
        { date: '2026-01-01', description: 'In Account', amount: -50 },
        { date: '2026-01-02', description: 'Not In Account', amount: -30 },
      ]);
      db.prepare('UPDATE transactions SET account_id = @accountId WHERE description = @desc')
        .run({ accountId, desc: 'In Account' });

      const res = await fetch(base + `/api/transactions?accountId=${accountId}`);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toHaveLength(1);
      expect(data[0].description).toBe('In Account');
    });

    test('GET /api/summary?accountId scopes to account', async () => {
      const { db, base } = await start();
      const accountId = insertAccount(db, {
        name: 'Scoped',
        account_type: 'asset',
        account_subtype: 'checking',
      });
      insertTransactions(db, [
        { date: '2026-02-15', description: 'Scoped Expense', amount: -100, category: 'Food' },
        { date: '2026-02-16', description: 'Other Expense', amount: -200, category: 'Food' },
      ]);
      db.prepare('UPDATE transactions SET account_id = @accountId WHERE description = @desc')
        .run({ accountId, desc: 'Scoped Expense' });

      const res = await fetch(base + `/api/summary?month=2026-02&accountId=${accountId}`);
      expect(res.status).toBe(200);
      const data = await res.json() as { category: string; total: number }[];
      // Should only contain the scoped expense, not the "Other Expense"
      const total = data.reduce((sum, row) => sum + row.total, 0);
      expect(total).toBe(-100);
    });
  });

  // ── Auth validation edge cases ──────────────────────────────────────

  describe('auth validation', () => {
    test('POST /api/auth/setup rejects missing username', async () => {
      const { base } = await start();
      const res = await fetch(base + '/api/auth/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'pass' }),
      });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain('username and password required');
    });

    test('POST /api/auth/login rejects missing credentials', async () => {
      const { base } = await start();
      const res = await fetch(base + '/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'user' }),
      });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain('username and password required');
    });

    test('POST /api/auth/users rejects missing credentials', async () => {
      const { base } = await start();
      const res = await fetch(base + '/api/auth/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'onlyname' }),
      });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain('username and password required');
    });

    test('DELETE /api/auth/users/:id deactivates user', async () => {
      const { db, base } = await start();
      const user = await createUser(db, 'todelete', 'pass');
      const res = await fetch(base + `/api/auth/users/${user.id}`, {
        method: 'DELETE',
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
    });

    test('PATCH /api/auth/config toggles auth', async () => {
      const { base } = await start();
      const res = await fetch(base + '/api/auth/config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ auth_enabled: true }),
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.auth_enabled).toBe(true);
    });

    test('POST /api/profiles/switch changes profile', async () => {
      const { base } = await start();
      const res = await fetch(base + '/api/profiles/switch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'test' }),
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.active).toBeDefined();
    });

    test('POST /api/profiles/switch rejects missing name', async () => {
      const { base } = await start();
      const res = await fetch(base + '/api/profiles/switch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain('name required');
    });
  });

  // ── Data API routes ─────────────────────────────────────────────────

  describe('data API routes', () => {
    test('GET /api/pnl returns data', async () => {
      const { base } = await start();
      const res = await fetch(base + '/api/pnl');
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toBeDefined();
    });

    test('GET /api/budgets returns data', async () => {
      const { base } = await start();
      const res = await fetch(base + '/api/budgets');
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toBeDefined();
    });

    test('GET /api/savings returns data', async () => {
      const { base } = await start();
      const res = await fetch(base + '/api/savings');
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toBeDefined();
    });

    test('GET /api/alerts returns data', async () => {
      const { base } = await start();
      const res = await fetch(base + '/api/alerts');
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toBeDefined();
    });
  });

  // ── Logs, Traces, Chat, Interactions ────────────────────────────────

  describe('logs and traces', () => {
    test('GET /api/logs returns array', async () => {
      const { base } = await start();
      const res = await fetch(base + '/api/logs');
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(Array.isArray(data)).toBe(true);
    });

    test('GET /api/traces returns data', async () => {
      const { base } = await start();
      const res = await fetch(base + '/api/traces');
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toBeDefined();
    });

    test('GET /api/traces/stats returns data', async () => {
      const { base } = await start();
      const res = await fetch(base + '/api/traces/stats');
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toBeDefined();
    });
  });

  describe('chat routes', () => {
    test('GET /api/chat/history returns data', async () => {
      const { base } = await start();
      const res = await fetch(base + '/api/chat/history');
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toBeDefined();
    });

    test('GET /api/chat/sessions returns data', async () => {
      const { base } = await start();
      const res = await fetch(base + '/api/chat/sessions');
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toBeDefined();
    });

    test('GET /api/chat/sessions/:id returns data', async () => {
      const { base } = await start();
      const res = await fetch(base + '/api/chat/sessions/test-session-id');
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toBeDefined();
    });

    test('POST /api/chat rejects missing query', async () => {
      const { base } = await start();
      const res = await fetch(base + '/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain('query is required');
    });
  });

  describe('interactions and training', () => {
    test('GET /api/interactions returns data', async () => {
      const { base } = await start();
      const res = await fetch(base + '/api/interactions');
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toBeDefined();
    });

    test('GET /api/interactions/:id returns 404 for missing', async () => {
      const { base } = await start();
      const res = await fetch(base + '/api/interactions/99999');
      expect(res.status).toBe(404);
    });

    test('POST /api/interactions/:id/annotate creates annotation', async () => {
      const { base } = await start();
      const res = await fetch(base + '/api/interactions/1/annotate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rating: 5, notes: 'Great' }),
      });
      expect(res.status).toBe(200);
    });

    test('GET /api/runs/:id returns data', async () => {
      const { base } = await start();
      const res = await fetch(base + '/api/runs/test-run-id');
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toBeDefined();
    });

    test('GET /api/annotations/stats returns data', async () => {
      const { base } = await start();
      const res = await fetch(base + '/api/annotations/stats');
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toBeDefined();
    });

    test('GET /api/export/training/sft returns JSONL', async () => {
      const { base } = await start();
      const res = await fetch(base + '/api/export/training/sft');
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('application/x-ndjson');
    });

    test('GET /api/export/training/dpo returns JSONL', async () => {
      const { base } = await start();
      const res = await fetch(base + '/api/export/training/dpo');
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('application/x-ndjson');
    });

    test('GET /api/export/training/stats returns data', async () => {
      const { base } = await start();
      const res = await fetch(base + '/api/export/training/stats');
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toBeDefined();
    });
  });

  // ── XLSX export ─────────────────────────────────────────────────────

  describe('xlsx export', () => {
    test('GET /api/export/xlsx returns spreadsheet or error', async () => {
      const { db, base } = await start();
      insertTransactions(db, [
        { date: '2026-01-15', description: 'XLS Test', amount: -25, category: 'Food' },
      ]);
      const res = await fetch(base + '/api/export/xlsx');
      // May succeed (xlsx installed) or return 500 (xlsx not installed)
      expect([200, 500]).toContain(res.status);
    });
  });
});
