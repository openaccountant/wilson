import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import type { Database } from '../db/compat-sqlite.js';
import { createTestDb, ensureTestProfile, seedTestData } from './helpers.js';
import { openHeldRequest } from './held-request-helpers.js';
import { saveConfig } from '../utils/config.js';
import { startDashboardServer, stopDashboardServer } from '../dashboard/server.js';
import { setInitialProfile, closeAll } from '../dashboard/db-manager.js';
import { createUser, enableAuth, isAuthEnabled } from '../dashboard/auth.js';

/**
 * #157 part 1. Auth is checked once when a request arrives. A write request
 * whose headers arrived while auth was off, and whose body arrives after auth
 * was turned on, carries no login and must be refused (401) on EVERY
 * state-changing route, not just the ones that happen to re-check. The refusal
 * must leave the database byte-for-byte as it was.
 */

interface RaceCase {
  name: string;
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: (db: Database) => string;
  body: unknown;
  /** Extra headers (the MCP grant routes demand a same-origin browser proof). */
  headers?: (port: number) => Record<string, string>;
  /** The control run (auth stays off) must change the database; proves the case is a real write. */
  writes: boolean;
}

const firstTxnId = (db: Database) => (db.prepare('SELECT id FROM transactions ORDER BY id LIMIT 1').get() as { id: number }).id;

const browser = (port: number) => ({ Origin: `http://localhost:${port}`, 'Sec-Fetch-Site': 'same-origin', 'X-Wilson-Agent-Session': '10000000-0000-4000-8000-000000000001' });

const CASES: RaceCase[] = [
  { name: 'PATCH /api/transactions/:id', method: 'PATCH', path: (db) => `/api/transactions/${firstTxnId(db)}`, body: { category: 'Raced' }, writes: true },
  { name: 'PUT /api/budgets/:category', method: 'PUT', path: () => '/api/budgets/Groceries', body: { monthlyLimit: 777 }, writes: true },
  { name: 'PATCH /api/goals/:id', method: 'PATCH', path: () => '/api/goals/1', body: { target_amount: 1 }, writes: false },
  { name: 'POST /api/entities', method: 'POST', path: () => '/api/entities', body: { name: 'Raced Entity' }, writes: true },
  { name: 'POST /api/memories', method: 'POST', path: () => '/api/memories', body: { memoryType: 'context', content: 'raced' }, writes: true },
  { name: 'PUT /api/settings/custom-prompt', method: 'PUT', path: () => '/api/settings/custom-prompt', body: { prompt: 'raced' }, writes: true },
  {
    name: 'POST /api/import',
    method: 'POST',
    path: () => '/api/import',
    body: { filename: 'race.csv', bank: 'generic', transactions: [{ date: '2026-03-01', description: 'RACED IMPORT', amount: -12.34 }] },
    writes: true,
  },
  { name: 'POST /api/models', method: 'POST', path: () => '/api/models', body: { task: 'chat', model: 'raced-model' }, writes: false },
  { name: 'POST /api/chat/local', method: 'POST', path: () => '/api/chat/local', body: { query: 'q', answer: 'a' }, writes: true },
  { name: 'POST /api/profiles/switch', method: 'POST', path: () => '/api/profiles/switch', body: { name: 'raced-profile' }, writes: false },
  { name: 'DELETE /api/transactions/:id', method: 'DELETE', path: (db) => `/api/transactions/${firstTxnId(db)}`, body: {}, writes: true },
  { name: 'POST /api/mcp/grants', method: 'POST', path: () => '/api/mcp/grants', body: { tools: ['search_transactions'] }, headers: browser, writes: true },
  // Browser-proof routes: they demand a same-origin browser proof on top of the login, and still read their body late.
  { name: 'DELETE /api/mcp/grants/:id (browser proof)', method: 'DELETE', path: () => '/api/mcp/grants/00000000-0000-4000-8000-000000000000', body: {}, headers: browser, writes: false },
  { name: 'POST /api/judgements/bulk (browser proof)', method: 'POST', path: () => '/api/judgements/bulk', body: { ids: [1], action: 'accept' }, headers: browser, writes: false },
  { name: 'POST /api/interactions/:id/annotate (browser proof)', method: 'POST', path: () => '/api/interactions/1/annotate', body: { label: 'good' }, headers: browser, writes: false },
  { name: 'PATCH /api/auth/config (turn auth off)', method: 'PATCH', path: () => '/api/auth/config', body: { auth_enabled: false }, writes: false },
  { name: 'POST /api/auth/users', method: 'POST', path: () => '/api/auth/users', body: { username: 'raced', password: 'racedpass1', role: 'admin' }, writes: true },
];

/** Every row of every table, as one string: any write at all shows up as a difference. */
function dumpDb(db: Database): string {
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map((t) => t.name);
  return tables.map((t) => `${t}:${JSON.stringify(db.prepare(`SELECT * FROM "${t}"`).all())}`).join('\n');
}

describe('every state-changing route: auth turned on while the body is in flight', () => {
  let db: Database;
  let server: Awaited<ReturnType<typeof startDashboardServer>>['server'];

  beforeEach(async () => {
    ensureTestProfile();
    saveConfig({});
    db = createTestDb();
    seedTestData(db);
    setInitialProfile('test', db);
    ({ server } = await startDashboardServer(db, 0));
  });

  afterEach(() => {
    stopDashboardServer(server);
    saveConfig({});
    closeAll();
  });

  /**
   * Headers first (auth off), `beforeBody` runs once the server has seen them and is waiting on the body
   * (a deterministic signal, not a sleep), then the body. Returns the status line's code.
   */
  async function sendSplit(c: RaceCase, beforeBody: () => Promise<void>): Promise<number> {
    const held = await openHeldRequest(server, db, {
      method: c.method,
      path: c.path(db),
      headers: c.headers?.(server.port!),
      payload: JSON.stringify(c.body),
    });
    await held.arrived;
    await beforeBody();
    return (await held.finish()).status;
  }

  for (const c of CASES) {
    test(`${c.name}: refused with 401 and writes nothing`, async () => {
      let before = '';
      const status = await sendSplit(c, async () => {
        // The admin finishes setup meanwhile: auth is now on.
        await createUser(db, 'admin', 'adminpass', 'admin');
        enableAuth(db);
        expect(isAuthEnabled(db)).toBe(true);
        before = dumpDb(db);
      });
      expect(status).toBe(401);
      expect(isAuthEnabled(db)).toBe(true);
      expect(dumpDb(db)).toBe(before);
    });
  }

  for (const c of CASES.filter((x) => x.writes)) {
    test(`control, ${c.name}: the same request with auth left off does write`, async () => {
      let before = '';
      const status = await sendSplit(c, async () => {
        before = dumpDb(db);
      });
      expect(status).toBe(200);
      expect(dumpDb(db)).not.toBe(before);
    });
  }
});
