import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  InvalidMoneyError,
  Ledger,
  PeriodLockedError,
  withTransaction,
  type LedgerDatabase,
} from '../../ledger/index.js';
import { sha256Hex } from '../../ledger/sha256.js';
import { count, makeLedger, simple } from './helpers.js';

const MAX = Number.MAX_SAFE_INTEGER;

function dropTriggers(db: Database, names: string[]) {
  for (const n of names) db.exec(`DROP TRIGGER ${n}`);
}

describe('period closes are tamper-evident', () => {
  function closed() {
    const ctx = makeLedger();
    ctx.ledger.postJournal(simple('2025-03-01', 'cash', 'sales', 5000));
    ctx.ledger.closePeriod('2025-12-31');
    return ctx;
  }

  test('triggers reject UPDATE and DELETE of close rows', () => {
    const { db, ledger } = closed();
    expect(() => db.exec('DELETE FROM ledger_period_closes')).toThrow(/append-only/);
    expect(() => db.exec(`UPDATE ledger_period_closes SET end_date = '2024-12-31'`)).toThrow(/append-only/);
    expect(ledger.lockedThrough()).toBe('2025-12-31');
  });

  test('a deleted close row does not reopen the period, and verifyAudit flags it', () => {
    const { db, ledger } = closed();
    dropTriggers(db, ['ledger_period_closes_no_delete']);
    db.exec('DELETE FROM ledger_period_closes');
    expect(ledger.lockedThrough()).toBe('2025-12-31');
    expect(() => ledger.postJournal(simple('2025-06-01', 'cash', 'sales', 5000))).toThrow(PeriodLockedError);
    const v = ledger.verifyAudit();
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('audited period close 2025-12-31 is missing');
  });

  test('a close row with no audit event is flagged', () => {
    const { db, ledger } = closed();
    db.exec(`INSERT INTO ledger_period_closes (end_date, closed_at) VALUES ('2026-06-30', 'x')`);
    const v = ledger.verifyAudit();
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('2026-06-30 has no period_closed audit event');
  });
});

describe('chart of accounts is tamper-evident', () => {
  function posted() {
    const ctx = makeLedger();
    ctx.ledger.postJournal(simple('2025-03-01', 'cash', 'sales', 100));
    return ctx;
  }

  test('triggers reject DELETE and rewrites of code, name or kind; active may change', () => {
    const { db, ledger } = posted();
    expect(() => db.exec(`UPDATE ledger_accounts SET kind = 'equity' WHERE code = 'sales'`)).toThrow(/immutable/);
    expect(() => db.exec(`UPDATE ledger_accounts SET code = 'rev' WHERE code = 'sales'`)).toThrow(/immutable/);
    expect(() => db.exec(`UPDATE ledger_accounts SET name = 'Other' WHERE code = 'sales'`)).toThrow(/immutable/);
    expect(() => db.exec(`DELETE FROM ledger_accounts WHERE code = 'sales'`)).toThrow(/cannot be deleted/);
    ledger.setAccountActive('sales', false);
    expect(ledger.getAccount('sales')?.active).toBe(false);
    expect(ledger.profitLoss('2025-01-01', '2025-12-31').net_income_cents).toBe(100);
    expect(ledger.verifyAudit().ok).toBe(true);
  });

  test('a re-classified account fails verifyAudit', () => {
    const { db, ledger } = posted();
    dropTriggers(db, ['ledger_accounts_no_rewrite']);
    db.exec(`UPDATE ledger_accounts SET kind = 'equity' WHERE code = 'sales'`);
    const v = ledger.verifyAudit();
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('account sales kind is equity, audit says income');
  });

  test('a deleted account fails verifyAudit', () => {
    const { db, ledger } = posted();
    dropTriggers(db, ['ledger_accounts_no_delete']);
    db.exec(`DELETE FROM ledger_accounts WHERE code = 'sales'`);
    const v = ledger.verifyAudit();
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('audited account sales is missing');
  });

  test('an unaudited account or a raw active flip fails verifyAudit', () => {
    const a = posted();
    a.db.exec(`INSERT INTO ledger_accounts (code, name, kind, active) VALUES ('ghost', 'Ghost', 'asset', 1)`);
    expect(a.ledger.verifyAudit().reason).toContain('account ghost has no account_created audit event');

    const b = posted();
    b.db.exec(`UPDATE ledger_accounts SET active = 0 WHERE code = 'cash'`);
    expect(b.ledger.verifyAudit().reason).toContain('account cash active flag differs from audit');
  });
});

describe('ledger-wide totals stay safe integers', () => {
  test('a post that would overflow cumulative totals is refused and reports keep working', () => {
    const { db, ledger } = makeLedger();
    ledger.postJournal(simple('2025-03-01', 'cash', 'capital', MAX));
    expect(() => ledger.postJournal(simple('2025-03-02', 'cash', 'capital', MAX))).toThrow(InvalidMoneyError);
    expect(() => ledger.postJournal(simple('2025-03-02', 'cash', 'capital', 1))).toThrow(InvalidMoneyError);
    expect(count(db, 'ledger_entries')).toBe(1);
    expect(ledger.trialBalance('2025-12-31').balanced).toBe(true);
    expect(ledger.balanceSheet('2025-12-31').balanced).toBe(true);
    expect(ledger.verifyAudit().ok).toBe(true);
  });

  test('the guard covers totals spread across different accounts', () => {
    const { ledger } = makeLedger();
    const half = Math.floor(MAX / 2);
    ledger.postJournal(simple('2025-03-01', 'cash', 'capital', half));
    ledger.postJournal(simple('2025-03-02', 'supplies', 'card', half));
    expect(() => ledger.postJournal(simple('2025-03-03', 'cash', 'sales', 2))).toThrow(InvalidMoneyError);
    const tb = ledger.trialBalance('2025-12-31');
    expect(tb.total_debit_cents).toBe(half * 2);
    expect(tb.balanced).toBe(true);
  });

  test('a void that would overflow is refused instead of breaking reports', () => {
    const { db, ledger } = makeLedger();
    const big = ledger.postJournal(simple('2025-03-01', 'cash', 'capital', Math.ceil(MAX / 2) + 1));
    expect(() => ledger.voidJournal(big.id, '2025-03-02', 'void')).toThrow(InvalidMoneyError);
    expect(count(db, 'ledger_entries')).toBe(1);
    expect(ledger.trialBalance('2025-12-31').balanced).toBe(true);
  });
});

describe('the ledger core is runtime-portable', () => {
  test('sha256Hex matches node:crypto across padding boundaries and unicode', () => {
    const inputs = ['', 'abc', 'é', '💸 ledger', '\u0000', 'x'.repeat(1000)];
    for (let n = 0; n <= 130; n++) inputs.push('a'.repeat(n));
    for (const s of inputs) {
      expect(sha256Hex(s)).toBe(createHash('sha256').update(s, 'utf8').digest('hex'));
    }
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  test('src/ledger imports no runtime-specific modules', () => {
    const dir = join(import.meta.dir, '../../ledger');
    for (const f of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
      const src = readFileSync(join(dir, f), 'utf8');
      expect({ f, bad: src.match(/from\s+['"](node:|bun:)[^'"]*['"]/g) }).toEqual({ f, bad: null });
    }
  });

  test('bundles for the browser without polyfills', async () => {
    const out = await Bun.build({ entrypoints: [join(import.meta.dir, '../../ledger/index.ts')], target: 'browser' });
    expect(out.success).toBe(true);
    const code = await out.outputs[0]!.text();
    expect(code).not.toContain('crypto-browserify');
    expect(code.length).toBeLessThan(100_000);
  });
});

describe('withTransaction locking', () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  function walPair() {
    dir = mkdtempSync(join(tmpdir(), 'ledger-wal-'));
    const path = join(dir, 'data.db');
    const a = new Database(path);
    a.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 0;');
    const la = new Ledger(a).init();
    la.createAccount({ code: 'cash', name: 'Cash', kind: 'asset' });
    la.createAccount({ code: 'cap', name: 'Cap', kind: 'equity' });
    const b = new Database(path);
    b.exec('PRAGMA busy_timeout = 0;');
    return { a, b, la, lb: new Ledger(b) };
  }

  test('a post whose reads precede another connection commit still succeeds', () => {
    const { a, la, lb } = walPair();
    // Without the write lock up front, the other connection committing here
    // would make this post fail with SQLITE_BUSY_SNAPSHOT on its first INSERT.
    const prepare = a.prepare.bind(a);
    let otherErr: unknown = null;
    let fired = false;
    (a as unknown as { prepare: typeof a.prepare }).prepare = ((sql: string) => {
      if (!fired && sql.startsWith('INSERT INTO ledger_entries')) {
        fired = true;
        try {
          lb.postJournal(simple('2025-01-02', 'cash', 'cap', 2));
        } catch (err) {
          otherErr = err;
        }
      }
      return prepare(sql);
    }) as typeof a.prepare;
    const e = la.postJournal(simple('2025-01-01', 'cash', 'cap', 1));
    expect(e.id).toBe(1);
    // The other writer was the one told to wait, not the post already under way.
    expect(String(otherErr)).toContain('locked');
    expect(lb.listEntries()).toHaveLength(1);
    expect(la.verifyAudit().ok).toBe(true);
  });

  test('runs inside a caller-owned transaction via savepoints', () => {
    const { a, la } = walPair();
    a.transaction(() => {
      la.postJournal(simple('2025-01-01', 'cash', 'cap', 1));
    })();
    expect(la.listEntries()).toHaveLength(1);
  });

  test('falls back to savepoints for a handle that does not report inTransaction', () => {
    const db = new Database(':memory:');
    const handle: LedgerDatabase = { exec: (sql) => db.exec(sql), prepare: (sql) => db.prepare(sql) };
    const ledger = new Ledger(handle).init();
    ledger.createAccount({ code: 'cash', name: 'Cash', kind: 'asset' });
    ledger.createAccount({ code: 'cap', name: 'Cap', kind: 'equity' });
    expect(() =>
      withTransaction(handle, () => {
        ledger.postJournal(simple('2025-01-01', 'cash', 'cap', 1));
        throw new Error('rollback');
      }),
    ).toThrow('rollback');
    expect(ledger.listEntries()).toHaveLength(0);
    expect(ledger.verifyAudit().ok).toBe(true);
  });
});
