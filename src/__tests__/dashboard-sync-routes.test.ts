import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createTestDb } from './helpers.js';
import { startDashboardServer, stopDashboardServer } from '../dashboard/server.js';
import { setInitialProfile, closeAll } from '../dashboard/db-manager.js';
import { apiAccounts } from '../dashboard/api.js';
import {
  deactivateAccount,
  insertAccount,
  insertBalanceSnapshot,
  insertLoan,
} from '../db/net-worth-queries.js';
import { syncAccountRows, syncBalanceSnapshotRows, syncLoanRows } from '../dashboard/sync-routes.js';
import type { Database } from '../db/compat-sqlite.js';

/**
 * Raw-row read routes the offline mirror's v4 sync pulls (specs/browser-subagent.md
 * 7.2). GET /api/accounts already returns raw active rows, so only snapshots and
 * loans are new. Rules: authenticated like every dashboard route, GET only,
 * rows of ACTIVE accounts only (what every read tool sees), and only the columns
 * the mirror executors read: no notes, plaid ids or account numbers. Round 2 adds a
 * strict same-origin gate (no wildcard CORS, browser proof required) on every route.
 */

/** What a same-origin dashboard fetch looks like: Sec-Fetch-Site set by the browser, no Origin on a GET. */
const SAME_ORIGIN = { 'Sec-Fetch-Site': 'same-origin' };

function seed(db: Database) {
  const checking = insertAccount(db, { name: 'Everyday Checking', account_type: 'asset', account_subtype: 'checking', institution: 'Test Bank', account_number_last4: '1234', current_balance: 4000.5 });
  const house = insertAccount(db, { name: 'House', account_type: 'asset', account_subtype: 'real_estate', current_balance: 400000 });
  const mortgage = insertAccount(db, { name: 'Home Loan', account_type: 'liability', account_subtype: 'mortgage', current_balance: 250000.5 });
  const old = insertAccount(db, { name: 'Old Loan', account_type: 'liability', account_subtype: 'personal_loan', current_balance: 500 });
  insertLoan(db, { account_id: mortgage, original_principal: 300000, interest_rate: 6.5, term_months: 360, start_date: '2020-01-01', extra_payment: 100, linked_asset_id: house });
  insertLoan(db, { account_id: old, original_principal: 1000, interest_rate: 5, term_months: 12, start_date: '2025-01-01' });
  insertBalanceSnapshot(db, { account_id: checking, balance: 3000.5, snapshot_date: '2026-05-31' });
  insertBalanceSnapshot(db, { account_id: checking, balance: 4000.5, snapshot_date: '2026-06-30' });
  insertBalanceSnapshot(db, { account_id: old, balance: 500, snapshot_date: '2026-06-30' });
  deactivateAccount(db, old);
  return { checking, house, mortgage, old };
}

describe('syncBalanceSnapshotRows / syncLoanRows (pure)', () => {
  test('projected rows of active accounts only, ordered by id', () => {
    const db = createTestDb();
    const ids = seed(db);
    const snaps = syncBalanceSnapshotRows(db);
    expect(snaps.map((r) => r.account_id)).toEqual([ids.checking, ids.checking]);
    expect(snaps.map((r) => r.snapshot_date)).toEqual(['2026-05-31', '2026-06-30']);
    expect(Object.keys(snaps[0]).sort()).toEqual(['account_id', 'balance', 'id', 'snapshot_date']);

    const loans = syncLoanRows(db);
    expect(loans.map((r) => r.account_id)).toEqual([ids.mortgage]);
    expect(Object.keys(loans[0]).sort()).toEqual([
      'account_id', 'created_at', 'extra_payment', 'id', 'interest_rate', 'linked_asset_id',
      'original_principal', 'start_date', 'term_months', 'updated_at',
    ]);

    const accounts = syncAccountRows(db);
    expect(accounts.map((r) => r.id)).toEqual([ids.checking, ids.house, ids.mortgage]);
    expect(Object.keys(accounts[0]).sort()).toEqual([
      'account_subtype', 'account_type', 'created_at', 'currency', 'current_balance', 'entity_id',
      'id', 'institution', 'is_active', 'name', 'updated_at',
    ]);
  });

  test('never selects notes, plaid ids or account numbers', () => {
    const db = createTestDb();
    seed(db);
    db.prepare("UPDATE accounts SET notes = 'secret-note', plaid_account_id = 'plaid-secret'").run();
    db.prepare("UPDATE loans SET notes = 'loan-secret-note'").run();
    const serialized = JSON.stringify([syncAccountRows(db), syncBalanceSnapshotRows(db), syncLoanRows(db)]);
    for (const secret of ['secret-note', 'plaid-secret', 'loan-secret-note', '1234', 'account_number_last4', 'plaid_account_id']) {
      expect(serialized).not.toContain(secret);
    }
  });

  test('an empty book returns empty arrays', () => {
    const db = createTestDb();
    expect(syncBalanceSnapshotRows(db)).toEqual([]);
    expect(syncLoanRows(db)).toEqual([]);
    expect(syncAccountRows(db)).toEqual([]);
  });
});

describe('GET /api/sync/*', () => {
  let db: Database;
  let base = '';
  let server: Awaited<ReturnType<typeof startDashboardServer>>['server'] | null = null;

  beforeEach(async () => {
    db = createTestDb(); // temp profile, never a real ~/.openaccountant profile
    seed(db);
    setInitialProfile('sync-routes-test', db);
    const result = await startDashboardServer(db, 0);
    server = result.server;
    base = `http://localhost:${result.server.port}`;
  });

  afterEach(() => {
    if (server) {
      try { stopDashboardServer(server); } catch { /* */ }
      server = null;
    }
    closeAll();
  });

  async function enableAuth(): Promise<string> {
    const res = await fetch(base + '/api/auth/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'adminpass' }),
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as { token: string }).token;
  }

  const PATHS = ['/api/sync/accounts', '/api/sync/balance-snapshots', '/api/sync/loans'];

  test('serves the same rows as the pure helpers', async () => {
    const expected: Record<string, unknown> = {
      '/api/sync/accounts': syncAccountRows(db),
      '/api/sync/balance-snapshots': syncBalanceSnapshotRows(db),
      '/api/sync/loans': syncLoanRows(db),
    };
    for (const path of PATHS) {
      const res = await fetch(base + path, { headers: SAME_ORIGIN });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(expected[path] as object);
    }
  });

  test('authentication is required once auth is enabled, for every route', async () => {
    const token = await enableAuth();
    for (const path of PATHS) {
      expect((await fetch(base + path, { headers: SAME_ORIGIN })).status).toBe(401);
      expect((await fetch(base + path, { headers: { ...SAME_ORIGIN, Authorization: 'Bearer nope' } })).status).toBe(401);
      const ok = await fetch(base + path, { headers: { ...SAME_ORIGIN, Authorization: `Bearer ${token}` } });
      expect(ok.status).toBe(200);
      expect(Array.isArray(await ok.json())).toBe(true);
    }
  });

  test('GET only: other methods are 405', async () => {
    for (const path of PATHS) {
      const res = await fetch(base + path, { method: 'POST', body: '{}', headers: SAME_ORIGIN });
      expect(res.status).toBe(405);
    }
  });

  test('unknown /api/sync paths fall through to the normal 404', async () => {
    const res = await fetch(base + '/api/sync/everything', { headers: SAME_ORIGIN });
    expect(res.status).toBe(404);
  });

  test('exposes nothing the mirror does not read: no notes, plaid ids, account numbers or names', async () => {
    db.prepare("UPDATE accounts SET notes = 'secret-note', plaid_account_id = 'plaid-secret'").run();
    db.prepare("UPDATE loans SET notes = 'loan-secret-note'").run();
    const knownIds = new Set(apiAccounts(db).map((a) => a.id));
    const accounts = (await (await fetch(base + '/api/sync/accounts', { headers: SAME_ORIGIN })).json()) as Array<{ id: number }>;
    const snaps = (await (await fetch(base + '/api/sync/balance-snapshots', { headers: SAME_ORIGIN })).json()) as Array<{ account_id: number }>;
    const loans = (await (await fetch(base + '/api/sync/loans', { headers: SAME_ORIGIN })).json()) as Array<{ account_id: number }>;
    expect(accounts.map((a) => a.id).sort()).toEqual([...knownIds].sort());
    for (const r of [...snaps, ...loans]) expect(knownIds.has(r.account_id)).toBe(true);
    const serialized = JSON.stringify([accounts, snaps, loans]);
    for (const secret of ['secret-note', 'plaid-secret', 'loan-secret-note', 'account_number_last4', 'plaid_account_id', '1234']) {
      expect(serialized).not.toContain(secret);
    }
    // Snapshots and loans carry no account fields at all.
    for (const secret of ['Everyday Checking', 'Test Bank']) {
      expect(JSON.stringify([snaps, loans])).not.toContain(secret);
    }
  });
});

/**
 * Round 2 (security review MAJOR): with auth off the dashboard answers every
 * route with `Access-Control-Allow-Origin: *`, so any web page could read the raw
 * ledger rows. The sync routes now demand browser proof that the dashboard page
 * itself is asking: an allowlisted Origin, or Sec-Fetch-Site: same-origin (a
 * same-origin GET carries no Origin). They never emit a wildcard.
 */
describe('GET /api/sync/* origin gate', () => {
  let db: Database;
  let base = '';
  let port = 0;
  let server: Awaited<ReturnType<typeof startDashboardServer>>['server'] | null = null;

  beforeEach(async () => {
    db = createTestDb();
    seed(db);
    setInitialProfile('sync-routes-gate-test', db);
    const result = await startDashboardServer(db, 0);
    server = result.server;
    port = Number(result.server.port);
    base = `http://localhost:${port}`;
  });

  afterEach(() => {
    if (server) {
      try { stopDashboardServer(server); } catch { /* */ }
      server = null;
    }
    closeAll();
  });

  const PATHS = ['/api/sync/accounts', '/api/sync/balance-snapshots', '/api/sync/loans'];

  async function expectRefused(res: Response, status = 403) {
    expect(res.status).toBe(status);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    const text = await res.text();
    expect(text).not.toContain('Everyday Checking');
    expect(text).not.toContain('balance');
  }

  test('a foreign Origin is refused, with no CORS grant and no rows', async () => {
    for (const path of PATHS) {
      await expectRefused(await fetch(base + path, { headers: { Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' } }));
      // Even if the browser proof header is forged alongside a foreign Origin.
      await expectRefused(await fetch(base + path, { headers: { Origin: 'https://evil.example', ...SAME_ORIGIN } }));
      await expectRefused(await fetch(base + path, { headers: { Origin: 'null' } }));
      // Another localhost port is a foreign origin too.
      await expectRefused(await fetch(base + path, { headers: { Origin: `http://localhost:${port + 1}` } }));
    }
  });

  test('a cross-site or navigation Sec-Fetch-Site is refused even without an Origin', async () => {
    for (const path of PATHS) {
      await expectRefused(await fetch(base + path, { headers: { 'Sec-Fetch-Site': 'cross-site' } }));
      await expectRefused(await fetch(base + path, { headers: { 'Sec-Fetch-Site': 'same-site' } }));
      await expectRefused(await fetch(base + path, { headers: { 'Sec-Fetch-Site': 'none' } }));
    }
  });

  test('no Origin and no Sec-Fetch-Site (no browser proof) is refused', async () => {
    for (const path of PATHS) await expectRefused(await fetch(base + path));
  });

  test('a rebound Host is refused even when the request looks same-origin', async () => {
    for (const path of PATHS) {
      const res = await fetch(base + path, { headers: { ...SAME_ORIGIN, Host: `attacker.example:${port}` } });
      // The dashboard-wide Host gate (origin-gate.ts checkHost) answers first: 421 Misdirected Request.
      await expectRefused(res, 421);
    }
  });

  test('same-origin (Sec-Fetch-Site: same-origin, no Origin) is served, and never with a wildcard', async () => {
    for (const path of PATHS) {
      const res = await fetch(base + path, { headers: SAME_ORIGIN });
      expect(res.status).toBe(200);
      expect(res.headers.get('access-control-allow-origin')).not.toBe('*');
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
      expect(Array.isArray(await res.json())).toBe(true);
    }
  });

  test('the dashboard\'s own Origin is served and reflected exactly, never as a wildcard', async () => {
    for (const path of PATHS) {
      const own = `http://localhost:${port}`;
      const res = await fetch(base + path, { headers: { Origin: own, 'Sec-Fetch-Site': 'same-origin' } });
      expect(res.status).toBe(200);
      expect(res.headers.get('access-control-allow-origin')).toBe(own);
      expect(res.headers.get('vary')).toContain('Origin');
      // Origin alone (an older browser without Fetch Metadata) is proof enough.
      const bare = await fetch(base + path, { headers: { Origin: own } });
      expect(bare.status).toBe(200);
    }
  });

  test('a preflight never grants a wildcard on the sync routes', async () => {
    for (const path of PATHS) {
      const foreign = await fetch(base + path, { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } });
      expect(foreign.headers.get('access-control-allow-origin')).toBeNull();
      const own = await fetch(base + path, { method: 'OPTIONS', headers: { Origin: `http://localhost:${port}` } });
      expect(own.headers.get('access-control-allow-origin')).toBe(`http://localhost:${port}`);
    }
  });
});
