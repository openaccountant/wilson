import { describe, expect, test, afterEach } from 'bun:test';
import { createTestDb, seedTestData } from './helpers.js';
import { startDashboardServer, stopDashboardServer } from '../dashboard/server.js';
import { setInitialProfile, closeAll } from '../dashboard/db-manager.js';
import * as authModule from '../dashboard/auth.js';
import { createUser, deactivateUser, isAuthEnabled, getUserCount, enableAuth } from '../dashboard/auth.js';
import { scopedSpy } from './scoped-spy.js';
import type { Database } from '../db/compat-sqlite.js';

/**
 * #157 part 2 (bootstrap hijack). While auth is off, an unauthenticated
 * `PATCH /api/auth/config {auth_enabled:true}` used to turn auth on with zero
 * users; `/api/auth/setup` stays public in that state, so whoever called it
 * first became admin. Enabling auth is now refused (409) unless an active admin
 * exists; first-time enable goes through `/api/auth/setup`, which creates the
 * admin and enables auth in one transaction.
 */

const servers: Awaited<ReturnType<typeof startDashboardServer>>['server'][] = [];

afterEach(() => {
  for (const s of servers) {
    try { stopDashboardServer(s); } catch { /* */ }
  }
  servers.length = 0;
  closeAll();
});

async function start(): Promise<{ db: Database; base: string }> {
  const db = createTestDb();
  seedTestData(db);
  setInitialProfile('test', db);
  const result = await startDashboardServer(db, 0);
  servers.push(result.server);
  return { db, base: `http://localhost:${result.server.port}` };
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const patchConfig = (base: string, auth_enabled: boolean, headers: Record<string, string> = {}) =>
  fetch(base + '/api/auth/config', { method: 'PATCH', headers: { ...JSON_HEADERS, ...headers }, body: JSON.stringify({ auth_enabled }) });

describe('PATCH /api/auth/config refuses to enable auth without an active admin', () => {
  test('zero users: 409 that points at /api/auth/setup, and auth stays off', async () => {
    const { db, base } = await start();
    const res = await patchConfig(base, true);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('/api/auth/setup');
    expect(body.error.toLowerCase()).toContain('admin');
    expect(isAuthEnabled(db)).toBe(false);
  });

  test('the hijack no longer works: after a refused enable, /api/auth/status still says auth is off', async () => {
    const { base } = await start();
    await patchConfig(base, true);
    const status = (await (await fetch(base + '/api/auth/status')).json()) as { authEnabled: boolean; userCount: number };
    expect(status.authEnabled).toBe(false);
    expect(status.userCount).toBe(0);
  });

  test('only viewers exist: 409', async () => {
    const { db, base } = await start();
    await createUser(db, 'viewer1', 'password123', 'viewer');
    expect((await patchConfig(base, true)).status).toBe(409);
    expect(isAuthEnabled(db)).toBe(false);
  });

  test('the only admin is deactivated: 409', async () => {
    const { db, base } = await start();
    const admin = await createUser(db, 'admin1', 'password123', 'admin');
    expect(deactivateUser(db, admin.id)).toBe(true);
    expect((await patchConfig(base, true)).status).toBe(409);
    expect(isAuthEnabled(db)).toBe(false);
  });

  test('an active admin exists: enabling works, and re-sending "on" is a harmless 200', async () => {
    const { db, base } = await start();
    await createUser(db, 'admin1', 'password123', 'admin');
    const on = await patchConfig(base, true);
    expect(on.status).toBe(200);
    expect(((await on.json()) as { auth_enabled: boolean }).auth_enabled).toBe(true);
    expect(isAuthEnabled(db)).toBe(true);
    const login = (await (await fetch(base + '/api/auth/login', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ username: 'admin1', password: 'password123' }) })).json()) as { token: string };
    expect((await patchConfig(base, true, { Authorization: `Bearer ${login.token}` })).status).toBe(200);
  });

  test('turning auth OFF is not gated by this check', async () => {
    const { db, base } = await start();
    expect((await patchConfig(base, false)).status).toBe(200);
    expect(isAuthEnabled(db)).toBe(false);
  });

  test('/api/auth/setup still creates the first admin and enables auth together', async () => {
    const { db, base } = await start();
    const res = await fetch(base + '/api/auth/setup', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ username: 'owner', password: 'ownerpass1' }) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { role: string }; token: string };
    expect(body.user.role).toBe('admin');
    expect(body.token).toBeTruthy();
    expect(getUserCount(db)).toBe(1);
    expect(isAuthEnabled(db)).toBe(true);
    // The token it returned is a working admin session.
    const users = await fetch(base + '/api/auth/users', { headers: { Authorization: `Bearer ${body.token}` } });
    expect(users.status).toBe(200);
  });

  test('write-time backstop: auth switched on between the admin check and the write refuses a login-less request (401)', async () => {
    const { db, base } = await start();
    // The admin check is the last thing the route does before it writes. Make auth come on exactly there,
    // as a concurrent /api/auth/setup would, and the anonymous request must not be allowed to finish.
    const real = authModule.hasActiveAdmin;
    const spy = scopedSpy(authModule, 'hasActiveAdmin', ((d: Database) => {
      if (!isAuthEnabled(d)) {
        db.prepare("INSERT INTO dashboard_users (username, password_hash, role) VALUES ('late', 'x', 'admin')").run();
        enableAuth(d);
      }
      return real(d);
    }) as typeof real);
    try {
      const res = await patchConfig(base, true);
      expect(res.status).toBe(401);
    } finally {
      spy.restore();
    }
    // Auth is on because of the "other" request; this one changed nothing.
    expect(isAuthEnabled(db)).toBe(true);
  });
});
