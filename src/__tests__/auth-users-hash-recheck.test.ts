import { describe, expect, test, beforeEach, afterEach, afterAll } from 'bun:test';
import type { Database } from '../db/compat-sqlite.js';
import * as authModule from '../dashboard/auth.js';
import { createTestDb, ensureTestProfile, seedTestData } from './helpers.js';
import { scopedSpy } from './scoped-spy.js';
import { saveConfig } from '../utils/config.js';
import { startDashboardServer, stopDashboardServer } from '../dashboard/server.js';
import { setInitialProfile, switchProfile, closeAll } from '../dashboard/db-manager.js';
import { createUser, enableAuth, verifyLogin, deactivateUser, revokeToken, getUserByUsername } from '../dashboard/auth.js';

/**
 * POST /api/auth/users awaits a password hash after the central re-check has passed (the body is already
 * read). That await is a second window: the caller can be deactivated, log out, or the dashboard can switch
 * profile while the hash is computed, and the new account must not be created by a request that no longer
 * has the authority it arrived with. The route asks again (stillAuthorized) after the hash.
 */

const realHash = authModule.hashPassword;
let gate: (() => Promise<void>) | null = null;
const hashSpy = scopedSpy(authModule, 'hashPassword', (async (pw: string) => {
  if (gate) await gate();
  return realHash(pw);
}) as typeof realHash);

afterAll(() => hashSpy.restore());

describe('POST /api/auth/users: the login is re-checked after the password hash', () => {
  let db: Database;
  let server: Awaited<ReturnType<typeof startDashboardServer>>['server'];
  let base: string;
  let evilToken: string;
  let evilId: number;
  let n = 0;

  beforeEach(async () => {
    ensureTestProfile();
    saveConfig({});
    gate = null;
    db = createTestDb();
    seedTestData(db);
    setInitialProfile('test', db);
    await createUser(db, 'boss', 'bosspass1', 'admin');
    evilId = (await createUser(db, 'evil', 'evilpass1', 'admin')).id;
    enableAuth(db);
    evilToken = (await verifyLogin(db, 'evil', 'evilpass1'))!.token;
    ({ server } = await startDashboardServer(db, 0));
    base = `http://localhost:${server.port}`;
  });

  afterEach(() => {
    stopDashboardServer(server);
    saveConfig({});
    closeAll();
  });

  /** Start the request, pause it inside the hash, run `during`, then let it finish. */
  async function createWhile(during: () => void | Promise<void>): Promise<Response> {
    let entered!: () => void;
    const reached = new Promise<void>((r) => (entered = r));
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    gate = async () => { entered(); await held; };
    const pending = fetch(`${base}/api/auth/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${evilToken}` },
      body: JSON.stringify({ username: 'backdoor', password: 'backdoorpass1', role: 'admin' }),
    });
    await reached;
    await during();
    release();
    return pending;
  }

  test('control: nothing changes while hashing, the account is created', async () => {
    const res = await createWhile(() => {});
    expect(res.status).toBe(200);
    expect(getUserByUsername(db, 'backdoor')).toBeTruthy();
  });

  test('caller deactivated while hashing: 401, no account', async () => {
    const res = await createWhile(() => { deactivateUser(db, evilId); });
    expect(res.status).toBe(401);
    expect(getUserByUsername(db, 'backdoor') ?? null).toBeNull();
  });

  test('caller logged out while hashing: 401, no account', async () => {
    const res = await createWhile(() => { revokeToken(db, evilToken); });
    expect(res.status).toBe(401);
    expect(getUserByUsername(db, 'backdoor') ?? null).toBeNull();
  });

  test('profile switched while hashing: 409, no account', async () => {
    const res = await createWhile(() => { switchProfile(`hash-switch-${process.pid}-${++n}`); });
    expect(res.status).toBe(409);
    expect(getUserByUsername(db, 'backdoor') ?? null).toBeNull();
  });
});
