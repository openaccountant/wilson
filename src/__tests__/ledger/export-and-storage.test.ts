import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { JOURNAL_CSV_HEADER, Ledger, NotFoundError, withTransaction } from '../../ledger/index.js';
import { count, makeLedger, simple } from './helpers.js';

describe('journal CSV export', () => {
  test('one row per line, integer cents, quoted fields', () => {
    const { ledger } = makeLedger();
    const e1 = ledger.postJournal({
      date: '2026-01-02',
      memo: 'Owner, "seed" money',
      external_id: 'ext-1',
      lines: [
        { account: 'cash', debit_cents: 1_000_00, memo: 'line\nbreak' },
        { account: 'capital', credit_cents: 1_000_00 },
      ],
    });
    const e2 = ledger.postJournal(simple('2026-01-03', 'supplies', 'cash', 1999));
    const v = ledger.voidJournal(e2.id, '2026-01-04', '=SUM(A1)');
    const csv = ledger.exportJournalCsv();
    expect(csv).toBe(
      [
        JOURNAL_CSV_HEADER.join(','),
        `${e1.id},2026-01-02,"Owner, ""seed"" money",ext-1,,1,cash,Cash,100000,0,"line\nbreak"`,
        `${e1.id},2026-01-02,"Owner, ""seed"" money",ext-1,,2,capital,Capital,0,100000,`,
        `${e2.id},2026-01-03,supplies/cash,,,1,supplies,Supplies,1999,0,`,
        `${e2.id},2026-01-03,supplies/cash,,,2,cash,Cash,0,1999,`,
        `${v.id},2026-01-04,'=SUM(A1),,${e2.id},1,supplies,Supplies,0,1999,`,
        `${v.id},2026-01-04,'=SUM(A1),,${e2.id},2,cash,Cash,1999,0,`,
      ].join('\r\n') + '\r\n',
    );
  });

  test('date range filters entries', () => {
    const { ledger } = makeLedger();
    ledger.postJournal(simple('2026-01-02', 'supplies', 'cash', 1));
    ledger.postJournal(simple('2026-02-02', 'supplies', 'cash', 2));
    const rows = ledger.exportJournalCsv('2026-02-01', '2026-02-28').trim().split('\r\n');
    expect(rows).toHaveLength(3);
    expect(rows[1]).toContain('2026-02-02');
  });
});

describe('storage seam', () => {
  test('init is idempotent and only creates ledger_ tables', () => {
    const db = new Database(':memory:');
    const ledger = new Ledger(db).init().init();
    ledger.init();
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[])
      .map((t) => t.name)
      .filter((n) => n !== 'sqlite_sequence');
    expect(tables.length).toBeGreaterThan(0);
    expect(tables.every((n) => n.startsWith('ledger_'))).toBe(true);
  });

  test('data survives re-init on the same handle', () => {
    const { db, ledger } = makeLedger();
    ledger.postJournal(simple('2026-01-02', 'supplies', 'cash', 1));
    new Ledger(db).init();
    expect(count(db, 'ledger_entries')).toBe(1);
  });

  test('withTransaction nests and rolls back the inner scope only', () => {
    const { db, ledger } = makeLedger();
    withTransaction(db, () => {
      ledger.postJournal(simple('2026-01-02', 'supplies', 'cash', 1));
      expect(() =>
        withTransaction(db, () => {
          ledger.postJournal(simple('2026-01-03', 'supplies', 'cash', 2));
          throw new NotFoundError('forced');
        }),
      ).toThrow(NotFoundError);
    });
    expect(count(db, 'ledger_entries')).toBe(1);
    expect(ledger.verifyAudit().ok).toBe(true);
  });

  test('general ledger for an unknown account throws', () => {
    const { ledger } = makeLedger();
    expect(() => ledger.generalLedger('2026-01-01', '2026-01-31', 'nope')).toThrow(NotFoundError);
  });
});
