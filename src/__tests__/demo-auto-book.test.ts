import { describe, expect, test, afterEach } from 'bun:test';
import { readFileSync } from 'fs';
import { createTestDb } from './helpers.js';
import { startDashboardServer, stopDashboardServer } from '../dashboard/server.js';
import { setInitialProfile, closeAll } from '../dashboard/db-manager.js';
import { createFakeEmbedder } from './fake-embedder.js';
import { parseStatementContent, sha256Hex } from '../tools/import/client-import.js';
import type { Database } from '../db/compat-sqlite.js';

/**
 * HTTP-layer gate tests for the Demo tab's auto-book beat (issue #94):
 * the booking write executes only after the visible confirmation round-trip
 * through the WebMCP tool-gate substrate (spec-50). Pins, end to end in the
 * auto-book flow:
 *   1. the exposed-tools list starts empty and grants are revocable
 *   2. the mutating route rejects un-gated calls — nothing written
 *   3. no write until the confirmation round-trip completes (approve path)
 *   4. deny produces no data change (and can't be re-applied)
 *   5. revoke-before-commit leaves the data untouched
 *   6. the candidates route is read-only server truth
 *   7. the pending operation names the exact change (what the card renders)
 */

const FIXTURE_CONTENT = readFileSync(new URL('../../demos/fixtures/august-2026-chase.csv', import.meta.url), 'utf-8');

async function createServer() {
  const db = createTestDb();
  setInitialProfile('test', db);
  const fake = createFakeEmbedder();
  const result = await startDashboardServer(db, 0, { traceEmbed: fake.embed });
  return { db, server: result.server, base: `http://localhost:${result.server.port}` };
}

type ServerHandle = Awaited<ReturnType<typeof createServer>>['server'];
const servers: ServerHandle[] = [];

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

async function j(base: string, path: string, init?: RequestInit) {
  const res = await fetch(base + path, init);
  const contentType = res.headers.get('content-type') ?? '';
  const body = contentType.includes('json') ? await res.json() : await res.text();
  return { status: res.status, body: body as any };
}

const post = (base: string, path: string, body: unknown) =>
  j(base, path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

async function setup() {
  const { db, base } = await start();
  const parsed = parseStatementContent(FIXTURE_CONTENT);
  const fileHash = await sha256Hex(FIXTURE_CONTENT);
  const res = await post(base, '/api/demo/trace/step', {
    step: 'import',
    filename: 'august-2026-chase.csv',
    bank: parsed.bank,
    format: parsed.format,
    fileHash,
    transactions: parsed.transactions,
  });
  expect(res.status).toBe(200);
  expect(res.body.status).toBe('ok');
  const importedIds: number[] = res.body.detail.importedIds;
  expect(importedIds).toHaveLength(34);
  return { db, base, importedIds };
}

async function grantTool(base: string, sessionGeneration: string, tool = 'categorize_transaction') {
  const res = await post(base, '/api/mcp/grants', { sessionGeneration, tools: [tool] });
  expect(res.status).toBe(200);
  return res.body.grants[0] as { id: string };
}

function payrollCandidates(db: Database): Array<{ id: number; date: string }> {
  return db
    .prepare("SELECT id, date FROM transactions WHERE description = 'PAYROLL DEPOSIT - ACME CORP' ORDER BY date")
    .all() as Array<{ id: number; date: string }>;
}

function rowState(db: Database, id: number): { category: string | null; revision: number } {
  return db.prepare('SELECT category, revision FROM transactions WHERE id = @id').get({ id }) as {
    category: string | null;
    revision: number;
  };
}

describe('auto-book gate (spec-50 non-negotiables in the demo context)', () => {
  test('exposed-tools list starts empty; granting exposes the mutating tool; revoking empties it again', async () => {
    const { base } = await start();

    const fresh = await j(base, '/api/mcp/tools?sessionGeneration=tab-1');
    expect(fresh.body.tools).toEqual([]);

    const grant = await grantTool(base, 'tab-1');
    const tools = await j(base, '/api/mcp/tools?sessionGeneration=tab-1');
    expect(tools.body.tools).toHaveLength(1);
    const tool = tools.body.tools[0];
    expect(tool.name).toBe('categorize_transaction');
    expect(tool.grantId).toBe(grant.id);
    // The confirmation signal travels with the tool, per spec.
    expect(tool.annotations.consequentialHint).toBe(true);
    expect(tool.annotations.readOnlyHint).toBe(false);

    await j(base, `/api/mcp/grants/${grant.id}`, { method: 'DELETE' });
    const after = await j(base, '/api/mcp/tools?sessionGeneration=tab-1');
    expect(after.body.tools).toEqual([]);
  });

  test('the mutating route rejects un-gated calls and the row is byte-identical afterwards', async () => {
    const { db, base, importedIds } = await setup();
    const txnId = payrollCandidates(db)[0].id;
    expect(rowState(db, txnId)).toEqual({ category: null, revision: 1 });

    // Unknown grant id.
    const unknownGrant = await post(base, '/api/mcp/prepare', {
      sessionGeneration: 'tab-1', grantId: 'no-such-grant', tool: 'categorize_transaction',
      args: { id: txnId, category: 'Home' },
    });
    expect(unknownGrant.status).toBe(403);
    expect(rowState(db, txnId)).toEqual({ category: null, revision: 1 });

    // Revoked grant.
    const grant = await grantTool(base, 'tab-1');
    await j(base, `/api/mcp/grants/${grant.id}`, { method: 'DELETE' });
    const revoked = await post(base, '/api/mcp/prepare', {
      sessionGeneration: 'tab-1', grantId: grant.id, tool: 'categorize_transaction',
      args: { id: txnId, category: 'Home' },
    });
    expect(revoked.status).toBe(403);
    expect(rowState(db, txnId)).toEqual({ category: null, revision: 1 });

    // Grant from a foreign tab/session generation.
    const other = await grantTool(base, 'other-tab');
    const foreign = await post(base, '/api/mcp/prepare', {
      sessionGeneration: 'tab-1', grantId: other.id, tool: 'categorize_transaction',
      args: { id: txnId, category: 'Home' },
    });
    expect(foreign.status).toBe(403);
    expect(rowState(db, txnId)).toEqual({ category: null, revision: 1 });

    void importedIds;
  });

  test('no write until the confirmation round-trip completes: prepare writes nothing, approve commits once', async () => {
    const { db, base, importedIds } = await setup();
    const grant = await grantTool(base, 'tab-1');

    const cand = await post(base, '/api/demo/autobook/candidates', {
      description: 'PAYROLL DEPOSIT - ACME CORP',
      importedIds,
    });
    expect(cand.status).toBe(200);
    const txnId = cand.body.candidates[0].id as number;

    // Prepare: a pending operation exists, but the row is untouched.
    const prepared = await post(base, '/api/mcp/prepare', {
      sessionGeneration: 'tab-1', grantId: grant.id, tool: 'categorize_transaction',
      args: { id: txnId, category: 'Home' },
    });
    expect(prepared.status).toBe(200);
    expect(prepared.body.operation.status).toBe('pending');
    expect(rowState(db, txnId)).toEqual({ category: null, revision: 1 });

    // The human approves through the visible confirmation → the write lands.
    const approved = await post(base, `/api/mcp/operations/${prepared.body.operation.id}/approve`, {});
    expect(approved.status).toBe(200);
    expect(approved.body.outcome).toBe('committed');

    expect(rowState(db, txnId)).toEqual({ category: 'Home', revision: 2 });
  });

  test('deny produces no data change, and a late approve cannot re-apply a rejected operation', async () => {
    const { db, base, importedIds } = await setup();
    const grant = await grantTool(base, 'tab-1');
    const cand = await post(base, '/api/demo/autobook/candidates', {
      description: 'MAPLE AVE APARTMENTS RENT', importedIds,
    });
    const txnId = cand.body.candidates[0].id as number;
    expect(rowState(db, txnId)).toEqual({ category: null, revision: 1 });

    const prepared = await post(base, '/api/mcp/prepare', {
      sessionGeneration: 'tab-1', grantId: grant.id, tool: 'categorize_transaction',
      args: { id: txnId, category: 'Home' },
    });
    const rejected = await post(base, `/api/mcp/operations/${prepared.body.operation.id}/reject`, {});
    expect(rejected.body.outcome).toBe('rejected');
    expect(rowState(db, txnId)).toEqual({ category: null, revision: 1 });

    // A repeat approve on the rejected op returns the stored outcome — never re-applies.
    const lateApprove = await post(base, `/api/mcp/operations/${prepared.body.operation.id}/approve`, {});
    expect(lateApprove.body.outcome).toBe('rejected');
    expect(rowState(db, txnId)).toEqual({ category: null, revision: 1 });
  });

  test('revoking the grant between prepare and approve leaves the row untouched (stale)', async () => {
    const { db, base, importedIds } = await setup();
    const grant = await grantTool(base, 'tab-1');
    const cand = await post(base, '/api/demo/autobook/candidates', {
      description: 'MAPLE AVE APARTMENTS RENT', importedIds,
    });
    const txnId = cand.body.candidates[0].id as number;

    const prepared = await post(base, '/api/mcp/prepare', {
      sessionGeneration: 'tab-1', grantId: grant.id, tool: 'categorize_transaction',
      args: { id: txnId, category: 'Home' },
    });
    await j(base, `/api/mcp/grants/${grant.id}`, { method: 'DELETE' });

    const approved = await post(base, `/api/mcp/operations/${prepared.body.operation.id}/approve`, {});
    expect(approved.body.outcome).toBe('stale');
    expect(rowState(db, txnId)).toEqual({ category: null, revision: 1 });
  });

  test('candidates route: exact server truth over the imported rows, read-only, 400s on bad input', async () => {
    const { db, base, importedIds } = await setup();

    const payroll = await post(base, '/api/demo/autobook/candidates', {
      description: 'PAYROLL DEPOSIT - ACME CORP', importedIds,
    });
    expect(payroll.status).toBe(200);
    expect(payroll.body.candidates).toHaveLength(2);
    for (const c of payroll.body.candidates) {
      expect(c.amount).toBe(3200);
      expect(c.category).toBeNull();
      expect(['2026-08-01', '2026-08-15']).toContain(c.date);
      expect(importedIds).toContain(c.id);
    }
    const dates = payroll.body.candidates.map((c: { date: string }) => c.date).sort();
    expect(dates).toEqual(['2026-08-01', '2026-08-15']);

    const maple = await post(base, '/api/demo/autobook/candidates', {
      description: 'MAPLE AVE APARTMENTS RENT', importedIds,
    });
    expect(maple.body.candidates).toHaveLength(1);
    expect(maple.body.candidates[0].amount).toBe(-2400);

    const unknown = await post(base, '/api/demo/autobook/candidates', {
      description: 'NOT A REAL MERCHANT', importedIds,
    });
    expect(unknown.body.candidates).toEqual([]);

    // Scoped to the imported set: only one of the two payroll rows is offered.
    const scoped = await post(base, '/api/demo/autobook/candidates', {
      description: 'PAYROLL DEPOSIT - ACME CORP',
      importedIds: payrollCandidates(db).slice(0, 1).map((r) => r.id),
    });
    expect(scoped.body.candidates).toHaveLength(1);

    // Validation failures are 400s with precise messages.
    const emptyDesc = await post(base, '/api/demo/autobook/candidates', { description: '', importedIds });
    expect(emptyDesc.status).toBe(400);
    expect(emptyDesc.body.error).toContain('description');
    const emptyIds = await post(base, '/api/demo/autobook/candidates', { description: 'X', importedIds: [] });
    expect(emptyIds.status).toBe(400);
    expect(emptyIds.body.error).toContain('importedIds');
    const nonNumeric = await post(base, '/api/demo/autobook/candidates', { description: 'X', importedIds: ['one'] });
    expect(nonNumeric.status).toBe(400);

    // Read-only: repeating the POST changes nothing.
    const repeat = await post(base, '/api/demo/autobook/candidates', {
      description: 'PAYROLL DEPOSIT - ACME CORP', importedIds,
    });
    expect(repeat.body.candidates).toHaveLength(2);
    expect(db.prepare('SELECT COUNT(*) AS c FROM transactions').get()).toEqual({ c: 34 });
    expect(db.prepare("SELECT COUNT(*) AS c FROM transactions WHERE category IS NOT NULL").get()).toEqual({ c: 0 });
  });

  test('the pending operation names the exact change — description, date, and target category', async () => {
    const { db, base, importedIds } = await setup();
    const grant = await grantTool(base, 'tab-1');
    const cand = await post(base, '/api/demo/autobook/candidates', {
      description: 'PAYROLL DEPOSIT - ACME CORP', importedIds,
    });
    const txnId = cand.body.candidates[0].id as number;
    const txn = db.prepare('SELECT description, date FROM transactions WHERE id = @id').get({ id: txnId }) as {
      description: string;
      date: string;
    };

    const prepared = await post(base, '/api/mcp/prepare', {
      sessionGeneration: 'tab-1', grantId: grant.id, tool: 'categorize_transaction',
      args: { id: txnId, category: 'Income' },
    });
    const summary: string = prepared.body.operation.summary;
    expect(summary).toContain(txn.description);
    expect(summary).toContain(txn.date);
    expect(summary).toContain('Income');

    // The single-operation read (what the section polls) carries the same context.
    const readback = await j(base, `/api/mcp/operations/${prepared.body.operation.id}`);
    expect(readback.body.operation.summary).toBe(summary);
  });
});