import { describe, expect, test, afterEach } from 'bun:test';
import { createTestDb, seedTestData } from './helpers.js';
import { startDashboardServer, stopDashboardServer } from '../dashboard/server.js';
import { setInitialProfile, closeAll } from '../dashboard/db-manager.js';
import { isAuthEnabled } from '../dashboard/auth.js';
import {
  apiErrorMessage, firstAdminBody, shouldOfferFirstAdmin, validateFirstAdmin,
} from '../dashboard/ui/src/lib/firstAdmin.js';

/**
 * Settings > Security first-admin form (#157). The UI package has no component test runner, so the decisions the
 * form makes live in a pure module (ui/src/lib/firstAdmin.ts) and are tested here, together with the real server
 * answers the form reacts to (the setup response it logs in with, and the 409 it must show instead of swallowing).
 */

describe('shouldOfferFirstAdmin', () => {
  test('auth off and no users: offer the form', () => {
    expect(shouldOfferFirstAdmin({ authEnabled: false, userCount: 0 })).toBe(true);
  });
  test('auth off but users exist: the plain Enable button stays (the server decides)', () => {
    expect(shouldOfferFirstAdmin({ authEnabled: false, userCount: 2 })).toBe(false);
  });
  test('auth already on, or status not loaded: no form', () => {
    expect(shouldOfferFirstAdmin({ authEnabled: true, userCount: 0 })).toBe(false);
    expect(shouldOfferFirstAdmin({ authEnabled: true, userCount: 3 })).toBe(false);
    expect(shouldOfferFirstAdmin(null)).toBe(false);
  });
});

describe('validateFirstAdmin / firstAdminBody', () => {
  test('requires a username, a password and a matching confirmation', () => {
    expect(validateFirstAdmin({ username: '  ', password: 'pw', confirm: 'pw' })).toMatch(/username/i);
    expect(validateFirstAdmin({ username: 'owner', password: '', confirm: '' })).toMatch(/password/i);
    expect(validateFirstAdmin({ username: 'owner', password: 'pw1', confirm: 'pw2' })).toMatch(/do not match/i);
    expect(validateFirstAdmin({ username: 'owner', password: 'pw1', confirm: 'pw1' })).toBeNull();
  });
  test('the request body trims the username and never sends the confirmation', () => {
    expect(firstAdminBody({ username: ' owner ', password: 'pw1', confirm: 'pw1' })).toEqual({ username: 'owner', password: 'pw1' });
  });
});

describe('apiErrorMessage: the server\'s own words', () => {
  test('unwraps api()\'s "API <status>: <json>" error', () => {
    const err = new Error('API 409: {"error":"Cannot enable auth: no active admin user exists."}');
    expect(apiErrorMessage(err, 'fallback')).toBe('Cannot enable auth: no active admin user exists.');
  });
  test('structured errors keep their message', () => {
    expect(apiErrorMessage(new Error('API 503: {"error":{"code":"lan_auth_required","message":"Needs auth."}}'), 'x')).toBe('Needs auth.');
  });
  test('a non-JSON body is shown as is; nothing at all uses the fallback', () => {
    expect(apiErrorMessage(new Error('API 500: boom'), 'x')).toBe('boom');
    expect(apiErrorMessage(new Error('API 502: '), 'fallback')).toBe('fallback');
    expect(apiErrorMessage(undefined, 'fallback')).toBe('fallback');
  });
});

describe('against the real server', () => {
  const servers: Awaited<ReturnType<typeof startDashboardServer>>['server'][] = [];
  afterEach(() => {
    for (const s of servers) stopDashboardServer(s);
    servers.length = 0;
    closeAll();
  });

  async function start() {
    const db = createTestDb();
    seedTestData(db);
    setInitialProfile('test', db);
    const { server } = await startDashboardServer(db, 0);
    servers.push(server);
    return { db, base: `http://localhost:${server.port}` };
  }
  const json = { 'Content-Type': 'application/json' };

  test('status says to offer the form; setup creates the admin, enables auth and returns the session the UI stores', async () => {
    const { db, base } = await start();
    const status = (await (await fetch(`${base}/api/auth/status`)).json()) as { authEnabled: boolean; userCount: number };
    expect(shouldOfferFirstAdmin(status)).toBe(true);

    const res = await fetch(`${base}/api/auth/setup`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify(firstAdminBody({ username: ' owner ', password: 'ownerpass1', confirm: 'ownerpass1' })),
    });
    expect(res.status).toBe(200);
    const { token, user } = (await res.json()) as { token: string; user: { username: string; role: string } };
    expect(user).toMatchObject({ username: 'owner', role: 'admin' });
    expect(isAuthEnabled(db)).toBe(true);

    // With that token the refreshed status shows a logged-in admin, and the form is gone.
    const after = (await (await fetch(`${base}/api/auth/status`, { headers: { Authorization: `Bearer ${token}` } })).json()) as {
      authEnabled: boolean; userCount: number; user: { role: string } | null;
    };
    expect(after.user?.role).toBe('admin');
    expect(shouldOfferFirstAdmin(after)).toBe(false);
  });

  test('the bare enable is refused with a 409 whose message the form shows (not swallowed)', async () => {
    const { db, base } = await start();
    const res = await fetch(`${base}/api/auth/config`, { method: 'PATCH', headers: json, body: JSON.stringify({ auth_enabled: true }) });
    expect(res.status).toBe(409);
    // What api() throws for that response:
    const thrown = new Error(`API ${res.status}: ${await res.text()}`);
    const shown = apiErrorMessage(thrown, 'Could not enable authentication.');
    expect(shown).toContain('no active admin');
    expect(shown).toContain('/api/auth/setup');
    expect(isAuthEnabled(db)).toBe(false);
  });

  test('a second setup is refused with the server\'s message', async () => {
    const { base } = await start();
    await fetch(`${base}/api/auth/setup`, { method: 'POST', headers: json, body: JSON.stringify({ username: 'owner', password: 'ownerpass1' }) });
    const res = await fetch(`${base}/api/auth/setup`, { method: 'POST', headers: json, body: JSON.stringify({ username: 'other', password: 'otherpass1' }) });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(apiErrorMessage(new Error(`API ${res.status}: ${await res.text()}`), 'x')).not.toBe('x');
  });
});
