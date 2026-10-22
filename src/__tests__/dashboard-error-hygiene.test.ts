import { describe, expect, test, afterEach } from 'bun:test';
import { createTestDb } from './helpers.js';
import { startDashboardServer, stopDashboardServer } from '../dashboard/server.js';
import { insertTransactions } from '../db/queries.js';
import { setInitialProfile, closeAll } from '../dashboard/db-manager.js';

// Bad request bodies answer 4xx with a plain message, never a 500 that echoes
// parser, TypeError or SQLite text. Anything unexpected is a generic 500.
describe('dashboard error hygiene', () => {
  const servers: Awaited<ReturnType<typeof startDashboardServer>>['server'][] = [];
  afterEach(() => {
    for (const s of servers) { try { stopDashboardServer(s); } catch { /* */ } }
    servers.length = 0;
    closeAll();
  });

  async function start() {
    const db = createTestDb();
    setInitialProfile('test', db);
    const { server } = await startDashboardServer(db, 0);
    servers.push(server);
    return { db, base: `http://localhost:${server.port}` };
  }
  const send = (base: string, method: string, path: string, raw: string) =>
    fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: raw });

  const JSON_ROUTES: [string, string][] = [
    ['POST', '/api/import'],
    ['POST', '/api/memories'],
    ['POST', '/api/entities'],
    ['PUT', '/api/entities/1'],
    ['PATCH', '/api/transactions/1'],
    ['POST', '/api/reviews/1/correct'],
    ['PUT', '/api/settings/custom-prompt'],
    ['POST', '/api/chat'],
    ['POST', '/api/demo/showdown/cloud'],
  ];

  test('JSON that is not an object is a 400, not a TypeError 500', async () => {
    const { base } = await start();
    for (const raw of ['null', '[]', '5', '"x"']) {
      for (const [method, path] of JSON_ROUTES) {
        const res = await send(base, method, path, raw);
        const text = await res.text();
        expect(`${raw} ${method} ${path} ${res.status}`).toBe(`${raw} ${method} ${path} 400`);
        expect(JSON.parse(text)).toEqual({ error: 'invalid JSON body' });
      }
    }
  });

  test('unparseable JSON is a 400 { error: "invalid JSON body" } on body routes', async () => {
    const { base } = await start();
    for (const [method, path] of JSON_ROUTES) {
      const res = await send(base, method, path, '{bad');
      const text = await res.text();
      expect(`${method} ${path} ${res.status}`).toBe(`${method} ${path} 400`);
      expect(JSON.parse(text)).toEqual({ error: 'invalid JSON body' });
    }
  });

  test('validation failures are 400 with a plain message', async () => {
    const { base } = await start();
    const mem = await send(base, 'POST', '/api/memories', '{}');
    expect(mem.status).toBe(400);
    expect((await mem.json()).error).toBe('memoryType and content required');

    const badType = await send(base, 'POST', '/api/memories', JSON.stringify({ memoryType: 'preference', content: 'x' }));
    expect(badType.status).toBe(400);
    expect(JSON.stringify(await badType.json())).not.toMatch(/CHECK|constraint/i);
  });

  test('a non-string fileHash is a 400 import failure, not a TypeError 500', async () => {
    const { base } = await start();
    const res = await send(base, 'POST', '/api/import', JSON.stringify({
      filename: 'a.csv', fileHash: 5,
      transactions: [{ date: '2026-01-15', description: 'X', amount: -1 }],
    }));
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).not.toContain('is not a function');
  });

  test('unexpected failures answer a generic 500 without SQLite text', async () => {
    const { db, base } = await start();
    insertTransactions(db, [{ date: '2026-01-15', description: 'X', amount: -1 }]);
    const row = db.prepare('SELECT id FROM transactions LIMIT 1').get() as { id: number };
    // A missing entity is now a validated 400 (PATCH body validation), not a FOREIGN KEY 500.
    const missing = await send(base, 'PATCH', `/api/transactions/${row.id}`, JSON.stringify({ entity_id: 999999 }));
    expect(missing.status).toBe(400);
    expect(JSON.stringify(await missing.json())).not.toMatch(/FOREIGN KEY|constraint|SQLITE/i);

    // A genuinely unexpected SQLite failure still answers the generic 500.
    db.exec('DROP TABLE entities');
    const res = await send(base, 'POST', '/api/entities', JSON.stringify({ name: 'x' }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
  });
});
