import { describe, expect, test, beforeEach, afterEach, afterAll, spyOn } from 'bun:test';
import type { Database } from '../db/compat-sqlite.js';
import { createTestDb, ensureTestProfile } from './helpers.js';
import { saveConfig } from '../utils/config.js';
import { startDashboardServer, stopDashboardServer } from '../dashboard/server.js';
import { setInitialProfile, closeAll } from '../dashboard/db-manager.js';
import { createUser, enableAuth, isAuthEnabled } from '../dashboard/auth.js';
import * as chatModule from '../dashboard/chat.js';
import { initCategorizeTool } from '../tools/categorize/categorize.js';
import { insertTransactions, addRule } from '../db/queries.js';

/**
 * A POST /api/chat whose headers arrived while auth was off, but whose body
 * arrives after auth was turned on, must be refused (401) like every other
 * awaiting route. Otherwise "/categorize" writes with user=null.
 */
const chatSpy = spyOn(chatModule, 'handleChatMessage');
afterAll(() => chatSpy.mockRestore());

describe('POST /api/chat: auth turned on while the body is in flight', () => {
  let db: Database;
  let server: Awaited<ReturnType<typeof startDashboardServer>>['server'];

  beforeEach(async () => {
    ensureTestProfile();
    saveConfig({});
    db = createTestDb();
    initCategorizeTool(db);
    insertTransactions(db, [{ date: '2026-02-15', description: 'AMAZON PURCHASE', amount: -50 }]);
    addRule(db, '*AMAZON*', 'Shopping');
    setInitialProfile('test', db);
    ({ server } = await startDashboardServer(db, 0));
  });

  afterEach(() => {
    stopDashboardServer(server);
    saveConfig({});
    closeAll();
  });

  async function postChatWithAuthTurnedOnMidRequest(query: string): Promise<number> {
    const payload = JSON.stringify({ query });
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
    // Headers only: the middleware runs with auth disabled and no user.
    sock.write(
      `POST /api/chat HTTP/1.1\r\nHost: localhost:${server.port}\r\nOrigin: http://localhost:${server.port}\r\nSec-Fetch-Site: same-origin\r\nContent-Type: application/json\r\nContent-Length: ${payload.length}\r\nConnection: close\r\n\r\n`,
    );
    await new Promise((r) => setTimeout(r, 150));

    // The admin finishes setup meanwhile: auth is now on.
    await createUser(db, 'admin', 'adminpass', 'admin');
    enableAuth(db);
    expect(isAuthEnabled(db)).toBe(true);

    // Now the body arrives.
    sock.write(payload);
    await finished;
    sock.end();

    return Number(raw.split(' ')[1]);
  }

  test('"/categorize" sent after auth is enabled mid-request is refused and writes nothing', async () => {
    const status = await postChatWithAuthTurnedOnMidRequest('/categorize');
    const categorized = (db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE category = 'Shopping'").get() as { n: number }).n;
    expect(categorized).toBe(0);
    expect(status).toBe(401);
  });

  test('free text sent after auth is enabled mid-request is refused and starts no agent run', async () => {
    chatSpy.mockClear();
    const status = await postChatWithAuthTurnedOnMidRequest('hello');
    expect(status).toBe(401);
    expect(chatSpy).not.toHaveBeenCalled();
  });
});
