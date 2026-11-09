import { describe, expect, test } from 'bun:test';
import {
  ConflictError,
  InactiveAccountError,
  InvalidMoneyError,
  LedgerError,
  LedgerValidationError,
  NotFoundError,
  UnbalancedEntryError,
  normalBalanceOf,
} from '../../ledger/index.js';
import { count, makeLedger, simple } from './helpers.js';

describe('chart of accounts', () => {
  test('normal balance derives from kind', () => {
    expect(normalBalanceOf('asset')).toBe('debit');
    expect(normalBalanceOf('expense')).toBe('debit');
    expect(normalBalanceOf('liability')).toBe('credit');
    expect(normalBalanceOf('equity')).toBe('credit');
    expect(normalBalanceOf('income')).toBe('credit');
    const { ledger } = makeLedger();
    expect(ledger.getAccount('card')).toEqual({
      code: 'card',
      name: 'Card',
      kind: 'liability',
      normal_balance: 'credit',
      active: true,
    });
  });

  test('duplicate code and bad kind are rejected', () => {
    const { ledger } = makeLedger();
    expect(() => ledger.createAccount({ code: 'cash', name: 'Again', kind: 'asset' })).toThrow(ConflictError);
    expect(() => ledger.createAccount({ code: 'x', name: 'X', kind: 'revenue' as never })).toThrow(LedgerValidationError);
    expect(() => ledger.createAccount({ code: ' ', name: 'X', kind: 'asset' })).toThrow(LedgerValidationError);
  });

  test('inactive accounts reject postings', () => {
    const { ledger } = makeLedger();
    ledger.setAccountActive('supplies', false);
    expect(() => ledger.postJournal(simple('2026-01-02', 'supplies', 'cash', 100))).toThrow(InactiveAccountError);
    ledger.setAccountActive('supplies', true);
    expect(ledger.postJournal(simple('2026-01-02', 'supplies', 'cash', 100)).id).toBeGreaterThan(0);
  });
});

describe('postJournal validation', () => {
  test('rejects floats and other non-integer money with a typed error', () => {
    const { ledger, db } = makeLedger();
    const bad: unknown[] = [10.5, 0.1, NaN, Infinity, '100', 2 ** 53, 10n, null];
    for (const v of bad) {
      const input = {
        date: '2026-01-02',
        memo: 'bad',
        lines: [
          { account: 'supplies', debit_cents: v as number },
          { account: 'cash', credit_cents: 100 },
        ],
      };
      let err: unknown;
      try {
        ledger.postJournal(input);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(InvalidMoneyError);
      expect((err as LedgerError).code).toBe('INVALID_MONEY');
    }
    expect(count(db, 'ledger_entries')).toBe(0);
  });

  test('rejects negative amounts, two-sided and zero lines', () => {
    const { ledger } = makeLedger();
    const lines = (a: object, b: object) => ({ date: '2026-01-02', memo: 'x', lines: [a, b] as never });
    expect(() =>
      ledger.postJournal(lines({ account: 'supplies', debit_cents: -5 }, { account: 'cash', credit_cents: -5 })),
    ).toThrow(InvalidMoneyError);
    expect(() =>
      ledger.postJournal(
        lines({ account: 'supplies', debit_cents: 5, credit_cents: 5 }, { account: 'cash', credit_cents: 0 }),
      ),
    ).toThrow(LedgerValidationError);
    expect(() =>
      ledger.postJournal(lines({ account: 'supplies', debit_cents: 0 }, { account: 'cash', credit_cents: 0 })),
    ).toThrow(LedgerValidationError);
  });

  test('requires at least two lines and balance', () => {
    const { ledger } = makeLedger();
    expect(() =>
      ledger.postJournal({ date: '2026-01-02', memo: 'x', lines: [{ account: 'cash', debit_cents: 1 }] }),
    ).toThrow(LedgerValidationError);
    expect(() =>
      ledger.postJournal({
        date: '2026-01-02',
        memo: 'x',
        lines: [
          { account: 'supplies', debit_cents: 101 },
          { account: 'cash', credit_cents: 100 },
        ],
      }),
    ).toThrow(UnbalancedEntryError);
  });

  test('rejects bad dates', () => {
    const { ledger } = makeLedger();
    for (const d of ['2026-02-30', '2026-13-01', '26-01-01', '2026/01/01', '']) {
      expect(() => ledger.postJournal(simple(d, 'supplies', 'cash', 1))).toThrow(LedgerValidationError);
    }
  });

  test('is atomic: an unknown account on a later line leaves nothing behind', () => {
    const { ledger, db } = makeLedger();
    const auditBefore = count(db, 'ledger_audit');
    expect(() =>
      ledger.postJournal({
        date: '2026-01-02',
        memo: 'x',
        lines: [
          { account: 'supplies', debit_cents: 100 },
          { account: 'nope', credit_cents: 100 },
        ],
      }),
    ).toThrow(NotFoundError);
    expect(count(db, 'ledger_entries')).toBe(0);
    expect(count(db, 'ledger_lines')).toBe(0);
    expect(count(db, 'ledger_audit')).toBe(auditBefore);
  });

  test('stores lines in order with memos', () => {
    const { ledger } = makeLedger();
    const e = ledger.postJournal({
      date: '2026-01-02',
      memo: 'split',
      lines: [
        { account: 'supplies', debit_cents: 700, memo: 'paper' },
        { account: 'supplies', debit_cents: 300 },
        { account: 'cash', credit_cents: 1000 },
      ],
    });
    expect(e.lines).toEqual([
      { line_no: 1, account: 'supplies', debit_cents: 700, credit_cents: 0, memo: 'paper' },
      { line_no: 2, account: 'supplies', debit_cents: 300, credit_cents: 0, memo: null },
      { line_no: 3, account: 'cash', debit_cents: 0, credit_cents: 1000, memo: null },
    ]);
  });
});

describe('idempotency', () => {
  test('replaying the same external_id and payload returns the original entry', () => {
    const { ledger, db } = makeLedger();
    const first = ledger.postJournal(simple('2026-01-02', 'supplies', 'cash', 2500, 'bank:abc'));
    const auditAfterFirst = count(db, 'ledger_audit');
    const again = ledger.postJournal(simple('2026-01-02', 'supplies', 'cash', 2500, 'bank:abc'));
    expect(again).toEqual(first);
    expect(count(db, 'ledger_entries')).toBe(1);
    expect(count(db, 'ledger_audit')).toBe(auditAfterFirst);
    expect(ledger.getEntryByExternalId('bank:abc')?.id).toBe(first.id);
  });

  test('replay is honoured even after the period is closed', () => {
    const { ledger } = makeLedger();
    const first = ledger.postJournal(simple('2026-01-02', 'supplies', 'cash', 2500, 'bank:abc'));
    ledger.closePeriod('2026-01-31');
    expect(ledger.postJournal(simple('2026-01-02', 'supplies', 'cash', 2500, 'bank:abc')).id).toBe(first.id);
  });

  test('a differing payload under the same external_id is a conflict', () => {
    const { ledger, db } = makeLedger();
    ledger.postJournal(simple('2026-01-02', 'supplies', 'cash', 2500, 'bank:abc'));
    expect(() => ledger.postJournal(simple('2026-01-02', 'supplies', 'cash', 2501, 'bank:abc'))).toThrow(ConflictError);
    expect(() => ledger.postJournal(simple('2026-01-03', 'supplies', 'cash', 2500, 'bank:abc'))).toThrow(ConflictError);
    const memoChanged = { ...simple('2026-01-02', 'supplies', 'cash', 2500, 'bank:abc'), memo: 'other' };
    expect(() => ledger.postJournal(memoChanged)).toThrow(ConflictError);
    expect(count(db, 'ledger_entries')).toBe(1);
  });
});
