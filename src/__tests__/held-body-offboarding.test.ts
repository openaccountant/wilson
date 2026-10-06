import { describe, expect, test, beforeEach, afterEach, afterAll, spyOn } from 'bun:test';
import type { Database } from '../db/compat-sqlite.js';
import { createTestDb, ensureTestProfile, seedTestData } from './helpers.js';
import { saveConfig } from '../utils/config.js';
import { startDashboardServer, stopDashboardServer } from '../dashboard/server.js';
import { setInitialProfile, closeAll } from '../dashboard/db-manager.js';
import { createUser, enableAuth, deactivateUser, verifyLogin, getUserByUsername } from '../dashboard/auth.js';
import * as chatModule from '../dashboard/chat.js';

/**
 * Held-body offboarding race (follow-up to #157). The auth middleware validates the bearer token
 * when a request's headers arrive. A state-changing request that arrived with a VALID login and is
 * still sending its body when that login dies (the admin is deactivated, or logs out) must be
 * refused at body time, otherwise an offboarded admin keeps write access (e.g. by creating a
 * backdoor admin account).
 */
const chatSpy = spyOn(chatModule, 'handleChatMessage');
afterAll(() => chatSpy.mockRestore());

interface HeldCase {
  name: string;
  method: 'POST' | 'PATCH';
  path: (db: Database) => string;
  body: unknown;
  /** True when the control run (login stays valid) must change the database. */
  writes: boolean;
}

const firstTxnId = (db: Database) => (db.prepare('SELECT id FROM transactions ORDER BY id LIMIT 1').get() as { id: number }).id;

const CASES: HeldCase[] = [
  { name: 'POST /api/auth/users', method: 'POST', path: () => '/api/auth/users', body: { username: 'backdoor', password: 'backdoorpass1', role: 'admin' }, writes: true },
  { name: 'PATCH /api/transactions/:id', method: 'PATCH', path: (db) => `/api/transactions/${firstTxnId(db)}`, body: { category: 'Raced' }, writes: true },
  { name: 'POST /api/chat', method: 'POST', path: () => '/api/chat', body: { query: 'how much did I spend?' }, writes: false },
];

type Ending = 'deactivation' | 'logout';

describe('held body: the login dies while the body is in flight', () => {
  let db: Database;
  let server: Awaited<ReturnType<typeof startDashboardServer>>['server'];
  let evilToken: string;
  let evilId: number;
  let bossToken: string;

  beforeEach(async () => {
    ensureTestProfile();
    saveConfig({});
    chatSpy.mockClear();
    db = createTestDb();
    seedTestData(db);
    setInitialProfile('test', db);
    await createUser(db, 'boss', 'bosspass1', 'admin');
    await createUser(db, 'evil', 'evilpass1', 'admin');
    enableAuth(db);
    evilToken = (await verifyLogin(db, 'evil', 'evilpass1'))!.token;
    bossToken = (await verifyLogin(db, 'boss', 'bosspass1'))!.token;
    evilId = getUserByUsername(db, 'evil')!.id;
    ({ server } = await startDashboardServer(db, 0));
  });

  afterEach(() => {
    stopDashboardServer(server);
    saveConfig({});
    closeAll();
  });

  function dump(): string {
    return JSON.stringify([
      db.prepare('SELECT id, username, role, is_active FROM dashboard_users ORDER BY id').all(),
      db.prepare('SELECT id, category FROM transactions ORDER BY id').all(),
    ]);
  }

  /** Headers first (valid login), `beforeBody` runs, then the body. Returns the response status. */
  async function sendHeld(c: HeldCase, beforeBody: () => Promise<void>): Promise<number> {
    const payload = JSON.stringify(c.body);
    let raw = '';
    let done!: () => void;
    const finished = new Promise<void>((r) => (done = r));
    const sock = await Bun.connect({
      hostname: 'localhost',
      port: server.port!,
      socket: {
        data(_s, d) { raw += Buffer.from(d).toString(); if (raw.includes('\r\n\r\n')) done(); },
        close() { done(); },
        error() { done(); },
        open() {},
      },
    });
    sock.write(
      `${c.method} ${c.path(db)} HTTP/1.1\r\nHost: localhost:${server.port}\r\nAuthorization: Bearer ${evilToken}\r\nContent-Type: application/json\r\nContent-Length: ${payload.length}\r\nConnection: close\r\n\r\n`,
    );
    await new Promise((r) => setTimeout(r, 120));
    await beforeBody();
    sock.write(payload);
    await finished;
    sock.end();
    return Number(raw.split(' ')[1]);
  }

  const end: Record<Ending, () => Promise<void>> = {
    deactivation: async () => {
      // 'boss' deactivates 'evil' while evil's request is still sending its body.
      const res = await fetch(`http://localhost:${server.port}/api/auth/users/${evilId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${bossToken}` },
      });
      expect(res.status).toBe(200);
    },
    logout: async () => {
      const res = await fetch(`http://localhost:${server.port}/api/auth/logout`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${evilToken}` },
      });
      expect(res.status).toBe(200);
    },
  };

  for (const c of CASES) {
    for (const ending of ['deactivation', 'logout'] as Ending[]) {
      test(`${c.name}: refused with 401 after ${ending}, writes nothing`, async () => {
        let before = '';
        const status = await sendHeld(c, async () => {
          await end[ending]();
          before = dump();
        });
        expect(status).toBe(401);
        expect(dump()).toBe(before);
        expect(getUserByUsername(db, 'backdoor') ?? null).toBeNull();
        // No chat run may start for a dead login.
        expect(chatSpy).not.toHaveBeenCalled();
      });
    }
  }

  test('a demoted-by-deactivation admin cannot become another account either (token of a different user is not accepted)', async () => {
    // Sanity: the deactivated account's stored token no longer validates at all.
    deactivateUser(db, evilId);
    const res = await fetch(`http://localhost:${server.port}/api/auth/users`, { headers: { Authorization: `Bearer ${evilToken}` } });
    expect(res.status).toBe(401);
  });

  for (const c of CASES.filter((x) => x.writes)) {
    test(`control, ${c.name}: the same held request with the login still valid does write`, async () => {
      let before = '';
      const status = await sendHeld(c, async () => {
        before = dump();
      });
      expect(status).toBe(200);
      expect(dump()).not.toBe(before);
    });
  }

  test('control, POST /api/chat: held with a valid login still reaches the chat handler', async () => {
    const status = await sendHeld(CASES[2], async () => {});
    expect(status).not.toBe(401);
    expect(chatSpy).toHaveBeenCalled();
  });
});
