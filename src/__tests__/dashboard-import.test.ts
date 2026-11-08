import { describe, expect, test, afterEach } from 'bun:test';
import { writeFileSync, unlinkSync } from 'fs';
import { createTestDb, makeTmpPath } from './helpers.js';
import { startDashboardServer, stopDashboardServer } from '../dashboard/server.js';
import { setInitialProfile, closeAll } from '../dashboard/db-manager.js';
import { createUser, enableAuth, disableAuth } from '../dashboard/auth.js';
import { initImportTool, csvImportTool } from '../tools/import/csv-import.js';
import { computeExternalId } from '../tools/import/external-id.js';
import { getTransactions } from '../db/queries.js';
import { insertAccount } from '../db/net-worth-queries.js';

/** Spin up a fresh server with an in-memory DB. */
async function createServer() {
  const db = createTestDb();
  setInitialProfile('test', db);
  const result = await startDashboardServer(db, 0);
  return { db, server: result.server, base: `http://localhost:${result.server.port}` };
}

const ROWS = [
  { date: '2026-01-15', description: 'GROCERY STORE', amount: -85.5 },
  { date: '2026-01-18', description: 'ELECTRIC CO', amount: -120.0 },
  { date: '2026-01-20', description: 'RESTAURANT', amount: -45.0 },
];

const post = (base: string, body: unknown, token?: string) =>
  fetch(base + '/api/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } as Record<string, string> : {}) },
    body: JSON.stringify(body),
  });

describe('POST /api/import', () => {
  const servers: Awaited<ReturnType<typeof startDashboardServer>>['server'][] = [];
  const tmpFiles: string[] = [];

  afterEach(() => {
    for (const s of servers) {
      try { stopDashboardServer(s); } catch { /* */ }
    }
    servers.length = 0;
    for (const f of tmpFiles) {
      try { unlinkSync(f); } catch { /* */ }
    }
    tmpFiles.length = 0;
    closeAll();
  });

  async function start() {
    const ctx = await createServer();
    servers.push(ctx.server);
    return ctx;
  }

  // ── Happy path + ledger (auth off ⇒ open access when auth is disabled) ──

  test('imports rows, records the ledger entry, and is open when auth is disabled', async () => {
    const { db, base } = await start();

    const res = await post(base, {
      filename: 'chase-2026-01.csv',
      bank: 'chase',
      fileHash: 'a'.repeat(64),
      transactions: ROWS,
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('imported');
    expect(data.transactionsImported).toBe(3);
    expect(data.transactionsSkipped).toBe(0);
    expect(data.dateRange).toEqual({ start: '2026-01-15', end: '2026-01-20' });

    // Rows land in the active profile's DB
    const apiRes = await fetch(base + '/api/transactions');
    expect(apiRes.status).toBe(200);
    const txns = (await apiRes.json()) as { date: string; description: string; amount: number; bank: string | null; source_file: string | null; external_id: string | null }[];
    expect(txns).toHaveLength(3);
    for (const t of txns) {
      expect(t.source_file).toBe('chase-2026-01.csv');
      expect(t.bank).toBe('chase');
      expect(t.external_id!.startsWith('csv-')).toBe(true);
    }
    const grocery = txns.find((t) => t.description === 'GROCERY STORE');
    expect(grocery).toBeDefined();
    expect(grocery!.amount).toBe(-85.5);

    // external_id derivation matches the CLI pipeline exactly
    expect(grocery!.external_id).toBe(computeExternalId({ date: '2026-01-15', description: 'GROCERY STORE', amount: -85.5 }));

    // Imports ledger row with date range
    const imports = db.prepare('SELECT * FROM imports').all() as {
      file_path: string; file_hash: string; bank: string | null;
      transaction_count: number; date_range_start: string; date_range_end: string;
    }[];
    expect(imports).toHaveLength(1);
    expect(imports[0].file_path).toBe('chase-2026-01.csv');
    expect(imports[0].file_hash).toBe('a'.repeat(64));
    expect(imports[0].bank).toBe('chase');
    expect(imports[0].transaction_count).toBe(3);
    expect(imports[0].date_range_start).toBe('2026-01-15');
    expect(imports[0].date_range_end).toBe('2026-01-20');
  });

  // ── Dedup ────────────────────────────────────────────────────────────────

  test('file-hash skip returns the prior import info and inserts nothing', async () => {
    const { db, base } = await start();

    const first = await post(base, {
      filename: 'chase-2026-01.csv',
      bank: 'chase',
      fileHash: 'b'.repeat(64),
      transactions: ROWS,
    });
    expect((await first.json()).status).toBe('imported');

    // Repeat the exact same POST
    const res = await post(base, {
      filename: 'chase-2026-01.csv',
      bank: 'chase',
      fileHash: 'b'.repeat(64),
      transactions: ROWS,
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('skipped');
    expect(data.transactionsImported).toBe(0);
    expect(data.previouslyImported).toBeDefined();
    expect(data.previouslyImported.filePath).toBe('chase-2026-01.csv');
    expect(data.previouslyImported.transactionCount).toBe(3);
    expect(data.previouslyImported.importedAt).toBeDefined();
    expect(data.message).toContain('already imported');

    // Nothing new inserted
    const txns = getTransactions(db);
    expect(txns).toHaveLength(3);
    expect(db.prepare('SELECT COUNT(*) AS c FROM imports').get()).toEqual({ c: 1 });
  });

  test('row-level dedup skips known external_ids', async () => {
    const { db, base } = await start();

    const first = await post(base, {
      filename: 'chase-2026-01.csv',
      bank: 'chase',
      fileHash: 'c'.repeat(64),
      transactions: ROWS,
    });
    expect((await first.json()).status).toBe('imported');

    // Same rows, different file (new hash) → every row is a duplicate
    const res = await post(base, {
      filename: 'chase-2026-01-reexport.csv',
      bank: 'chase',
      fileHash: 'd'.repeat(64),
      transactions: ROWS,
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('skipped');
    expect(data.transactionsImported).toBe(0);
    expect(data.transactionsSkipped).toBe(3);
    expect(data.message).toContain('already exist');

    const txns = getTransactions(db);
    expect(txns).toHaveLength(3);
  });

  test('mixed batch imports only the new rows', async () => {
    const { db, base } = await start();

    const first = await post(base, {
      filename: 'chase-2026-01.csv',
      bank: 'chase',
      fileHash: 'e'.repeat(64),
      transactions: ROWS,
    });
    expect((await first.json()).status).toBe('imported');

    const res = await post(base, {
      filename: 'chase-2026-02.csv',
      bank: 'chase',
      fileHash: 'f'.repeat(64),
      transactions: [
        ROWS[0],
        ROWS[1],
        { date: '2026-02-05', description: 'NEW PURCHASE', amount: -50.0 },
      ],
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('imported');
    expect(data.transactionsImported).toBe(1);
    expect(data.transactionsSkipped).toBe(2);
    // Date range covers the newly inserted rows only (mirrors the CLI, which
    // sorts newParsed, not the full payload)
    expect(data.dateRange).toEqual({ start: '2026-02-05', end: '2026-02-05' });

    const txns = getTransactions(db);
    expect(txns).toHaveLength(4);
    expect(db.prepare('SELECT COUNT(*) AS c FROM imports').get()).toEqual({ c: 2 });
  });

  test('client-supplied external_id (OFX FITID) is honored and dedups', async () => {
    const { db, base } = await start();

    const res = await post(base, {
      filename: 'statement.ofx',
      fileHash: '1'.repeat(64),
      transactions: [
        { date: '2026-01-15', description: 'OFX PAYEE', amount: -25.0, external_id: 'FITID-123' },
      ],
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('imported');
    expect(data.transactionsImported).toBe(1);

    const txn = db.prepare('SELECT external_id FROM transactions WHERE description = @desc')
      .get({ desc: 'OFX PAYEE' }) as { external_id: string };
    expect(txn.external_id).toBe('FITID-123');

    // Re-post the same FITID under a different file → skipped as a duplicate
    const res2 = await post(base, {
      filename: 'statement-2.ofx',
      fileHash: '2'.repeat(64),
      transactions: [
        { date: '2026-01-15', description: 'OFX PAYEE', amount: -25.0, external_id: 'FITID-123' },
      ],
    });
    expect(res2.status).toBe(200);
    const data2 = await res2.json();
    expect(data2.status).toBe('skipped');
    expect(data2.transactionsSkipped).toBe(1);
    expect(getTransactions(db)).toHaveLength(1);
  });

  // ── Cross-path dedup (API ↔ CLI) ─────────────────────────────────────────

  test('a row imported via the API dedups when the CLI imports the same statement', async () => {
    const { db, base } = await start();

    // Import one row via the API (no fileHash → fallback hash of the payload)
    const res = await post(base, {
      filename: 'chase.csv',
      transactions: [{ date: '2026-01-15', description: 'GROCERY STORE', amount: -85.5 }],
    });
    expect(res.status).toBe(200);
    expect((await res.json()).transactionsImported).toBe(1);

    // Now import a real Chase CSV containing the same row via the CLI pipeline
    const chaseCsv = `Transaction Date,Post Date,Description,Category,Type,Amount,Memo
01/15/2026,01/16/2026,GROCERY STORE,Groceries,Sale,-85.50,
01/18/2026,01/19/2026,ELECTRIC CO,Utilities,Sale,-120.00,`;
    const filePath = makeTmpPath('.csv');
    writeFileSync(filePath, chaseCsv);
    tmpFiles.push(filePath);

    initImportTool(db);
    const raw = await csvImportTool.func({ filePath });
    const result = JSON.parse(raw as string);
    // File hash differs (new file), but the GROCERY STORE row's derived external_id
    // collides with the API import — proof the derivations are byte-identical.
    expect(result.data.transactionsImported).toBe(1); // only ELECTRIC CO is new
    expect(result.data.transactionsSkipped).toBe(1);  // GROCERY STORE already present

    // DB still has exactly 2 transactions (1 from API + 1 new from CLI)
    expect(getTransactions(db)).toHaveLength(2);
    const grocery = db.prepare("SELECT COUNT(*) AS c FROM transactions WHERE description = 'GROCERY STORE'").get() as { c: number };
    expect(grocery.c).toBe(1);
  });

  // ── Validation → 400 ─────────────────────────────────────────────────────

  test('missing filename returns 400', async () => {
    const { base } = await start();
    const res = await post(base, { transactions: ROWS });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.status).toBe('failed');
    expect(data.error).toContain('filename');
  });

  test('missing transactions returns 400', async () => {
    const { base } = await start();
    const res = await post(base, { filename: 'chase.csv' });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.status).toBe('failed');
    expect(data.error).toContain('transactions');
  });

  test('non-array transactions returns 400', async () => {
    const { base } = await start();
    const res = await post(base, { filename: 'chase.csv', transactions: 'nope' });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.status).toBe('failed');
    expect(data.error).toContain('array');
  });

  test('empty transactions array returns 400', async () => {
    const { base } = await start();
    const res = await post(base, { filename: 'chase.csv', transactions: [] });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.status).toBe('failed');
  });

  test('row missing amount returns 400', async () => {
    const { base } = await start();
    const res = await post(base, {
      filename: 'chase.csv',
      transactions: [{ date: '2026-01-15', description: 'X' }],
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain('date, description, and amount');
  });

  test('row with string amount returns 400', async () => {
    const { base } = await start();
    const res = await post(base, {
      filename: 'chase.csv',
      transactions: [{ date: '2026-01-15', description: 'X', amount: '85.5' }],
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain('date, description, and amount');
  });

  test('row with non-ISO date returns 400', async () => {
    const { base } = await start();
    const res = await post(base, {
      filename: 'chase.csv',
      transactions: [{ date: '01/15/2026', description: 'X', amount: -1 }],
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain('YYYY-MM-DD');
  });

  test('malformed payloads insert nothing into transactions or imports', async () => {
    const { db, base } = await start();
    const res = await post(base, { filename: 'chase.csv', transactions: 'nope' });
    expect(res.status).toBe(400);
    expect(getTransactions(db)).toHaveLength(0);
    expect(db.prepare('SELECT COUNT(*) AS c FROM imports').get()).toEqual({ c: 0 });
  });

  // ── RBAC ─────────────────────────────────────────────────────────────────

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

    return { db, base, adminToken, viewerToken };
  }

  test('unauthenticated request returns 401 when auth is enabled', async () => {
    const { db, base } = await setupRbac();
    const res = await post(base, { filename: 'chase.csv', transactions: ROWS });
    expect(res.status).toBe(401);
    expect(getTransactions(db)).toHaveLength(0);
  });

  test('viewer receives 403 and nothing is inserted', async () => {
    const { db, base, viewerToken } = await setupRbac();
    const res = await post(base, { filename: 'chase.csv', transactions: ROWS }, viewerToken);
    expect(res.status).toBe(403);
    expect(getTransactions(db)).toHaveLength(0);
    expect(db.prepare('SELECT COUNT(*) AS c FROM imports').get()).toEqual({ c: 0 });
  });

  test('admin receives 200 and rows are inserted', async () => {
    const { db, base, adminToken } = await setupRbac();
    const res = await post(base, {
      filename: 'chase-2026-01.csv',
      bank: 'chase',
      transactions: ROWS,
    }, adminToken);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('imported');
    expect(data.transactionsImported).toBe(3);
    expect(getTransactions(db)).toHaveLength(3);
  });

  test('open access when auth is disabled again', async () => {
    const { db, base } = await start();
    await createUser(db, 'admin', 'adminpass', 'admin');
    enableAuth(db);
    disableAuth(db);

    const res = await post(base, { filename: 'chase.csv', transactions: ROWS });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('imported');
    expect(getTransactions(db)).toHaveLength(3);
  });

  // ── Account auto-link ────────────────────────────────────────────────────

  test('rows with account_last4 auto-link to a matching account', async () => {
    const { db, base } = await start();
    const accountId = insertAccount(db, {
      name: 'Chase Card',
      account_type: 'liability',
      account_subtype: 'credit_card',
      account_number_last4: '1234',
    });

    const res = await post(base, {
      filename: 'chase-2026-01.csv',
      bank: 'chase',
      transactions: [
        { date: '2026-01-15', description: 'GROCERY STORE', amount: -85.5, account_last4: '1234' },
        { date: '2026-01-18', description: 'ELECTRIC CO', amount: -120.0, account_last4: '1234' },
        { date: '2026-01-20', description: 'RESTAURANT', amount: -45.0 },
      ],
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('imported');
    expect(data.transactionsImported).toBe(3);
    expect(data.transactionsLinked).toBe(2);

    const linked = db.prepare('SELECT COUNT(*) AS c FROM transactions WHERE account_id = @accountId')
      .get({ accountId }) as { c: number };
    expect(linked.c).toBe(2);
  });

  // ── Per-row calendar-date / length / markup validation (guardrail finding L2) ──

  const row = (over: Record<string, unknown>) => ({ ...ROWS[0], ...over });

  for (const bad of ['2026-13-45', '2026-02-30', '0000-00-00', '9999-99-99', '2025-02-29']) {
    test(`impossible date ${bad} returns 400 naming the row and writing nothing`, async () => {
      const { db, base } = await start();
      const res = await post(base, { filename: 'x.csv', transactions: [ROWS[1], row({ date: bad })] });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.status).toBe('failed');
      expect(data.error).toBe('transactions[2].date must be a real YYYY-MM-DD date');
      expect(getTransactions(db, {})).toHaveLength(0);
    });
  }

  test('leap day 2024-02-29 is accepted', async () => {
    const { base } = await start();
    const res = await post(base, { filename: 'x.csv', transactions: [row({ date: '2024-02-29' })] });
    expect(res.status).toBe(200);
  });

  test('impossible authorized_date returns 400', async () => {
    const { base } = await start();
    const res = await post(base, { filename: 'x.csv', transactions: [row({ authorized_date: '2026-02-30' })] });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('transactions[1].authorized_date must be a real YYYY-MM-DD date');
  });

  test('3 MB description returns 400', async () => {
    const { db, base } = await start();
    const res = await post(base, { filename: 'x.csv', transactions: [row({ description: 'A'.repeat(3 * 1024 * 1024) })] });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('transactions[1].description must be at most 200 characters');
    expect(getTransactions(db, {})).toHaveLength(0);
  });

  test('description at the cap is accepted', async () => {
    const { base } = await start();
    const res = await post(base, { filename: 'x.csv', transactions: [row({ description: 'A'.repeat(200) })] });
    expect(res.status).toBe(200);
  });

  test('HTML in category returns 400', async () => {
    const { base } = await start();
    const res = await post(base, { filename: 'x.csv', transactions: [row({ category: '<img src=x onerror=alert(1)>' })] });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('transactions[1].category must not contain HTML');
  });

  test('non-string bank and non-boolean pending return 400', async () => {
    const { base } = await start();
    const r1 = await post(base, { filename: 'x.csv', transactions: [row({ bank: 7 })] });
    expect(r1.status).toBe(400);
    expect((await r1.json()).error).toBe('transactions[1].bank must be a string');
    const r2 = await post(base, { filename: 'x.csv', transactions: [row({ pending: 'no' })] });
    expect(r2.status).toBe(400);
    expect((await r2.json()).error).toBe('transactions[1].pending must be a boolean');
  });

  test('category over the 64-char agent-tool cap returns 400; 64 is accepted', async () => {
    const { base } = await start();
    const bad = await post(base, { filename: 'x.csv', transactions: [row({ category: 'C'.repeat(65) })] });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe('transactions[1].category must be at most 64 characters');
    const ok = await post(base, { filename: 'x.csv', transactions: [row({ category: 'C'.repeat(64) })] });
    expect(ok.status).toBe(200);
  });

  test('3 MB top-level bank returns 400 and stores nothing', async () => {
    const { db, base } = await start();
    const res = await post(base, { filename: 'x.csv', bank: 'B'.repeat(3 * 1024 * 1024), transactions: [ROWS[0]] });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('bank must be at most 200 characters');
    expect(getTransactions(db, {})).toHaveLength(0);
  });

  test('non-string top-level bank returns 400, not 500', async () => {
    const { base } = await start();
    const res = await post(base, { filename: 'x.csv', bank: { x: 1 }, transactions: [ROWS[0]] });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('bank must be a string');
  });

  test('3 MB filename returns 400 and is not echoed', async () => {
    const { db, base } = await start();
    const res = await post(base, { filename: 'f'.repeat(3 * 1024 * 1024), transactions: [ROWS[0]] });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe('filename must be at most 255 characters');
    expect(data.message.length).toBeLessThan(100);
    expect(getTransactions(db, {})).toHaveLength(0);
  });
});
