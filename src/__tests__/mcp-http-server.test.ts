import { describe, expect, test, afterEach } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createTestDb, seedTestData } from './helpers.js';
import { startDashboardServer, stopDashboardServer } from '../dashboard/server.js';
import { setInitialProfile, closeAll } from '../dashboard/db-manager.js';
import type { Database } from '../db/compat-sqlite.js';

/**
 * Exercises the Streamable-HTTP /mcp fallback the way a real generic MCP
 * client (e.g. Hronaut) would: through the SDK's own Client, over a real
 * HTTP connection to the running dashboard server — the same code path the
 * in-page WebMCP bridge's confirmation queue also feeds.
 */

let db: Database;
const servers: Awaited<ReturnType<typeof startDashboardServer>>['server'][] = [];

afterEach(() => {
  for (const s of servers) {
    try { stopDashboardServer(s); } catch { /* */ }
  }
  servers.length = 0;
  closeAll();
});

async function start() {
  db = createTestDb();
  seedTestData(db);
  setInitialProfile('test', db);
  const result = await startDashboardServer(db, 0);
  servers.push(result.server);
  return { db, base: `http://localhost:${result.server.port}` };
}

describe('Streamable-HTTP /mcp fallback', () => {
  test('a bearer token with no grants sees zero tools, not a protocol error', async () => {
    const { base } = await start();
    const client = new Client({ name: 'no-grant-client', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(base + '/mcp'));
    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools).toEqual([]);
    await client.close();
  });

  test('a granted bearer token sees exactly its granted tools and can call a read tool', async () => {
    const { base } = await start();
    const sessionGeneration = 'external-client-1';
    const grantRes = await fetch(base + '/api/mcp/grants', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionGeneration, tools: ['transaction_search'] }),
    });
    expect(grantRes.status).toBe(200);

    const client = new Client({ name: 'external-client', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(base + '/mcp'), {
      requestInit: { headers: { Authorization: `Bearer ${sessionGeneration}` } },
    });
    await client.connect(transport);

    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toEqual(['transaction_search']);

    const result = await client.callTool({ name: 'transaction_search', arguments: { query: 'groceries' } });
    const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text ?? '';
    expect(text).toContain('count');
    await client.close();
  });

  test('a mutating tool call blocks until the dashboard confirms it, then returns the committed outcome', async () => {
    const { base } = await start();
    const sessionGeneration = 'external-client-2';
    await fetch(base + '/api/mcp/grants', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionGeneration, tools: ['edit_transaction'] }),
    });

    const client = new Client({ name: 'external-client', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(base + '/mcp'), {
      requestInit: { headers: { Authorization: `Bearer ${sessionGeneration}` } },
    });
    await client.connect(transport);

    const row = db.prepare('SELECT id FROM transactions LIMIT 1').get() as { id: number };
    const callPromise = client.callTool({ name: 'edit_transaction', arguments: { id: row.id, notes: 'via mcp client' } });

    // Poll for the operation the dashboard's confirmation queue picked up,
    // then approve it exactly as a human clicking the confirmation card would.
    let operationId: string | undefined;
    for (let i = 0; i < 20 && !operationId; i++) {
      const pending = await (await fetch(base + '/api/mcp/operations')).json();
      operationId = pending.operations.find((o: any) => o.tool_name === 'edit_transaction')?.id;
      if (!operationId) await new Promise((r) => setTimeout(r, 50));
    }
    expect(operationId).toBeDefined();

    const approveRes = await (await fetch(base + `/api/mcp/operations/${operationId}/approve`, { method: 'POST' })).json();
    expect(approveRes.outcome).toBe('committed');

    const callResult = await callPromise;
    const text = (callResult.content as Array<{ type: string; text?: string }>)[0]?.text ?? '';
    const parsed = JSON.parse(text);
    expect(parsed.outcome).toBe('committed');

    const txn = db.prepare('SELECT notes FROM transactions WHERE id = @id').get({ id: row.id }) as { notes: string };
    expect(txn.notes).toBe('via mcp client');

    await client.close();
  });
});
