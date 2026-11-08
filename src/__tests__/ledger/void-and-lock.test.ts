import { describe, expect, test } from 'bun:test';
import {
  AlreadyVoidedError,
  LedgerValidationError,
  NotFoundError,
  PeriodLockedError,
} from '../../ledger/index.js';
import { count, makeLedger, simple } from './helpers.js';

describe('voidJournal', () => {
  test('appends a linked reversal and nets the effect to zero', () => {
    const { ledger, db } = makeLedger();
    const e = ledger.postJournal(simple('2026-01-05', 'supplies', 'cash', 4200));
    const before = db.prepare('SELECT * FROM ledger_lines WHERE entry_id = ?').all(e.id);
    const r = ledger.voidJournal(e.id, '2026-01-06', 'oops');
    expect(r.reverses_entry_id).toBe(e.id);
    expect(r.lines).toEqual([
      { line_no: 1, account: 'supplies', debit_cents: 0, credit_cents: 4200, memo: null },
      { line_no: 2, account: 'cash', debit_cents: 4200, credit_cents: 0, memo: null },
    ]);
    expect(db.prepare('SELECT * FROM ledger_lines WHERE entry_id = ?').all(e.id)).toEqual(before);
    expect(ledger.getEntry(e.id)!.reversed_by_entry_id).toBe(r.id);
    const tb = ledger.trialBalance('2026-12-31');
    expect(tb.rows.every((row) => row.debit_balance_cents === 0 && row.credit_balance_cents === 0)).toBe(true);
    expect(count(db, 'ledger_entries')).toBe(2);
  });

  test('cannot void twice, void a reversal, or void a missing entry', () => {
    const { ledger } = makeLedger();
    const e = ledger.postJournal(simple('2026-01-05', 'supplies', 'cash', 1));
    const r = ledger.voidJournal(e.id, '2026-01-05', 'v');
    expect(() => ledger.voidJournal(e.id, '2026-01-06', 'again')).toThrow(AlreadyVoidedError);
    expect(() => ledger.voidJournal(r.id, '2026-01-06', 'undo')).toThrow(LedgerValidationError);
    expect(() => ledger.voidJournal(9999, '2026-01-06', 'none')).toThrow(NotFoundError);
  });

  test('void date cannot precede the original', () => {
    const { ledger } = makeLedger();
    const e = ledger.postJournal(simple('2026-01-05', 'supplies', 'cash', 1));
    expect(() => ledger.voidJournal(e.id, '2026-01-04', 'early')).toThrow(LedgerValidationError);
  });

  test('database refuses direct mutation of journal rows', () => {
    const { ledger, db } = makeLedger();
    const e = ledger.postJournal(simple('2026-01-05', 'supplies', 'cash', 1));
    expect(() => db.prepare('UPDATE ledger_lines SET debit_cents = 2 WHERE entry_id = ?').run(e.id)).toThrow();
    expect(() => db.prepare('DELETE FROM ledger_entries WHERE id = ?').run(e.id)).toThrow();
    expect(() => db.prepare('DELETE FROM ledger_audit').run()).toThrow();
  });
});

describe('period locks', () => {
  test('rejects posts and voids on or before the latest close', () => {
    const { ledger } = makeLedger();
    const jan = ledger.postJournal(simple('2026-01-15', 'supplies', 'cash', 100));
    ledger.closePeriod('2026-01-31');
    expect(ledger.lockedThrough()).toBe('2026-01-31');
    expect(() => ledger.postJournal(simple('2026-01-31', 'supplies', 'cash', 1))).toThrow(PeriodLockedError);
    expect(() => ledger.postJournal(simple('2025-06-01', 'supplies', 'cash', 1))).toThrow(PeriodLockedError);
    expect(() => ledger.voidJournal(jan.id, '2026-01-31', 'late')).toThrow(PeriodLockedError);
    // Reversing a locked-period entry in an open period is allowed.
    expect(ledger.voidJournal(jan.id, '2026-02-01', 'reverse in Feb').date).toBe('2026-02-01');
    expect(ledger.postJournal(simple('2026-02-01', 'supplies', 'cash', 1)).date).toBe('2026-02-01');
  });

  test('closes only move forward; re-closing the same date is a no-op', () => {
    const { ledger, db } = makeLedger();
    ledger.closePeriod('2026-03-31');
    const audits = count(db, 'ledger_audit');
    expect(ledger.closePeriod('2026-03-31')).toBe('2026-03-31');
    expect(count(db, 'ledger_audit')).toBe(audits);
    expect(() => ledger.closePeriod('2026-02-28')).toThrow(LedgerValidationError);
    ledger.closePeriod('2026-04-30');
    expect(() => ledger.postJournal(simple('2026-04-30', 'supplies', 'cash', 1))).toThrow(PeriodLockedError);
  });

  test('PeriodLockedError carries the lock date', () => {
    const { ledger } = makeLedger();
    ledger.closePeriod('2026-01-31');
    try {
      ledger.postJournal(simple('2026-01-10', 'supplies', 'cash', 1));
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(PeriodLockedError);
      expect((e as PeriodLockedError).locked_through).toBe('2026-01-31');
      expect((e as PeriodLockedError).code).toBe('PERIOD_LOCKED');
    }
  });
});
