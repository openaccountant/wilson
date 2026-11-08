/**
 * Frozen synthetic scenario. Every expected number below was computed by hand
 * from the journal entries listed here, NOT taken from engine output.
 *
 * Accounts
 *   1000 Cash (asset)              1100 Accounts Receivable (asset)
 *   2000 Credit Card (liability)   3000 Owner Capital (equity)
 *   4000 Consulting Revenue (income)
 *   5000 Software (expense)        5100 Rent (expense)
 *
 * Entries (cents)
 *   E1 2025-12-15 owner investment   Dr 1000 1,000,000 / Cr 3000 1,000,000
 *   E2 2025-12-20 cash revenue       Dr 1000   250,000 / Cr 4000   250,000
 *   E3 2025-12-28 rent               Dr 5100   120,000 / Cr 1000   120,000
 *   -- close period 2025-12-31 --
 *   E4 2026-01-10 invoice            Dr 1100   480,050 / Cr 4000   480,050
 *   E5 2026-01-15 software on card   Dr 5000    12,999 / Cr 2000    12,999
 *   E6 2026-01-20 mistaken rent      Dr 5100    75,000 / Cr 1000    75,000
 *   V7 2026-01-22 void of E6         Dr 1000    75,000 / Cr 5100    75,000
 *   E8 2026-02-01 customer payment   Dr 1000   300,000 / Cr 1100   300,000
 *   E9 2026-02-05 rent + software    Dr 5100 120,000, Dr 5000 4,501 / Cr 1000 124,501
 *
 * Hand totals as of 2026-02-28
 *   Cash     = 1,000,000 + 250,000 - 120,000 - 75,000 + 75,000 + 300,000 - 124,501 = 1,305,499
 *              gross debits 1,625,000 / gross credits 319,501
 *   AR       = 480,050 - 300,000 = 180,050
 *   Card     = 12,999 (credit)
 *   Capital  = 1,000,000 (credit)
 *   Revenue  = 250,000 + 480,050 = 730,050 (credit)
 *   Rent     = 120,000 + 75,000 - 75,000 + 120,000 = 240,000
 *   Software = 12,999 + 4,501 = 17,500
 *   TB debit side  = 1,305,499 + 180,050 + 240,000 + 17,500 = 1,743,049
 *   TB credit side = 12,999 + 1,000,000 + 730,050         = 1,743,049
 *
 *   P&L 2025:        revenue 250,000 - rent 120,000 = 130,000
 *   P&L 2026 YTD:    revenue 480,050 - (rent 120,000 + software 17,500 = 137,500) = 342,550
 *   BS 2026-02-28:   assets 1,485,549 = liabilities 12,999
 *                    + equity (capital 1,000,000 + retained 130,000 + current 342,550 = 1,472,550)
 *   BS 2025-12-31:   assets 1,130,000 = liabilities 0 + equity (1,000,000 + current 130,000)
 */
import { Database } from 'bun:sqlite';
import { beforeAll, describe, expect, test } from 'bun:test';
import { Ledger, PeriodLockedError, type JournalEntry } from '../../ledger/index.js';

const EXPECTED = {
  tb_2026_02_28: {
    '1000': { debit_balance_cents: 1_305_499, credit_balance_cents: 0, total_debits_cents: 1_625_000, total_credits_cents: 319_501 },
    '1100': { debit_balance_cents: 180_050, credit_balance_cents: 0 },
    '2000': { debit_balance_cents: 0, credit_balance_cents: 12_999 },
    '3000': { debit_balance_cents: 0, credit_balance_cents: 1_000_000 },
    '4000': { debit_balance_cents: 0, credit_balance_cents: 730_050 },
    '5000': { debit_balance_cents: 17_500, credit_balance_cents: 0 },
    '5100': { debit_balance_cents: 240_000, credit_balance_cents: 0 },
    total_debit_cents: 1_743_049,
    total_credit_cents: 1_743_049,
  },
  pl_2025: { total_income_cents: 250_000, total_expense_cents: 120_000, net_income_cents: 130_000 },
  pl_2026_ytd: {
    total_income_cents: 480_050,
    total_expense_cents: 137_500,
    net_income_cents: 342_550,
    rent_cents: 120_000,
    software_cents: 17_500,
  },
  bs_2026_02_28: {
    total_assets_cents: 1_485_549,
    total_liabilities_cents: 12_999,
    retained_earnings_cents: 130_000,
    current_year_earnings_cents: 342_550,
    total_equity_cents: 1_472_550,
  },
  bs_2025_12_31: {
    total_assets_cents: 1_130_000,
    total_liabilities_cents: 0,
    retained_earnings_cents: 0,
    current_year_earnings_cents: 130_000,
    total_equity_cents: 1_130_000,
  },
  gl_cash_jan_2026: { opening: 1_130_000, running: [1_055_000, 1_130_000], closing: 1_130_000 },
  gl_cash_feb_2026: { opening: 1_130_000, running: [1_430_000, 1_305_499], closing: 1_305_499 },
} as const;

let ledger: Ledger;
let e6: JournalEntry;

beforeAll(() => {
  ledger = new Ledger(new Database(':memory:'), { now: () => '2026-03-01T00:00:00.000Z' });
  ledger.init();
  ledger.createAccount({ code: '1000', name: 'Cash', kind: 'asset' });
  ledger.createAccount({ code: '1100', name: 'Accounts Receivable', kind: 'asset' });
  ledger.createAccount({ code: '2000', name: 'Credit Card', kind: 'liability' });
  ledger.createAccount({ code: '3000', name: 'Owner Capital', kind: 'equity' });
  ledger.createAccount({ code: '4000', name: 'Consulting Revenue', kind: 'income' });
  ledger.createAccount({ code: '5000', name: 'Software', kind: 'expense' });
  ledger.createAccount({ code: '5100', name: 'Rent', kind: 'expense' });

  const two = (date: string, memo: string, dr: string, cr: string, cents: number) =>
    ledger.postJournal({
      date,
      memo,
      lines: [
        { account: dr, debit_cents: cents },
        { account: cr, credit_cents: cents },
      ],
    });

  two('2025-12-15', 'Owner investment', '1000', '3000', 1_000_000);
  two('2025-12-20', 'Cash revenue', '1000', '4000', 250_000);
  two('2025-12-28', 'December rent', '5100', '1000', 120_000);
  ledger.closePeriod('2025-12-31');
  two('2026-01-10', 'Invoice #1', '1100', '4000', 480_050);
  two('2026-01-15', 'Software subscription', '5000', '2000', 12_999);
  e6 = two('2026-01-20', 'Mistaken rent', '5100', '1000', 75_000);
  ledger.voidJournal(e6.id, '2026-01-22', 'Void duplicate rent');
  two('2026-02-01', 'Customer payment', '1000', '1100', 300_000);
  ledger.postJournal({
    date: '2026-02-05',
    memo: 'February rent and tools',
    lines: [
      { account: '5100', debit_cents: 120_000 },
      { account: '5000', debit_cents: 4_501 },
      { account: '1000', credit_cents: 124_501 },
    ],
  });
});

describe('frozen scenario', () => {
  test('trial balance as of 2026-02-28 matches hand totals', () => {
    const tb = ledger.trialBalance('2026-02-28');
    const exp = EXPECTED.tb_2026_02_28;
    for (const code of ['1000', '1100', '2000', '3000', '4000', '5000', '5100'] as const) {
      const row = tb.rows.find((r) => r.code === code);
      expect(row).toBeDefined();
      expect(row).toMatchObject(exp[code]);
    }
    expect(tb.total_debit_cents).toBe(exp.total_debit_cents);
    expect(tb.total_credit_cents).toBe(exp.total_credit_cents);
    expect(tb.balanced).toBe(true);
  });

  test('profit and loss for 2025 and 2026 YTD', () => {
    const pl25 = ledger.profitLoss('2025-01-01', '2025-12-31');
    expect(pl25).toMatchObject(EXPECTED.pl_2025);

    const pl26 = ledger.profitLoss('2026-01-01', '2026-02-28');
    expect(pl26.total_income_cents).toBe(EXPECTED.pl_2026_ytd.total_income_cents);
    expect(pl26.total_expense_cents).toBe(EXPECTED.pl_2026_ytd.total_expense_cents);
    expect(pl26.net_income_cents).toBe(EXPECTED.pl_2026_ytd.net_income_cents);
    expect(pl26.expense.find((r) => r.code === '5100')?.amount_cents).toBe(EXPECTED.pl_2026_ytd.rent_cents);
    expect(pl26.expense.find((r) => r.code === '5000')?.amount_cents).toBe(EXPECTED.pl_2026_ytd.software_cents);
  });

  test('balance sheet rolls earnings into equity', () => {
    const bs = ledger.balanceSheet('2026-02-28');
    expect(bs).toMatchObject(EXPECTED.bs_2026_02_28);
    expect(bs.total_assets_cents).toBe(bs.total_liabilities_cents + bs.total_equity_cents);
    expect(bs.balanced).toBe(true);

    const bs25 = ledger.balanceSheet('2025-12-31');
    expect(bs25).toMatchObject(EXPECTED.bs_2025_12_31);
  });

  test('general ledger running balances for cash', () => {
    const jan = ledger.generalLedger('2026-01-01', '2026-01-31', '1000');
    expect(jan.accounts).toHaveLength(1);
    const jc = jan.accounts[0]!;
    expect(jc.opening_balance_cents).toBe(EXPECTED.gl_cash_jan_2026.opening);
    expect(jc.lines.map((l) => l.running_balance_cents)).toEqual([...EXPECTED.gl_cash_jan_2026.running]);
    expect(jc.closing_balance_cents).toBe(EXPECTED.gl_cash_jan_2026.closing);

    const feb = ledger.generalLedger('2026-02-01', '2026-02-28', '1000');
    const fc = feb.accounts[0]!;
    expect(fc.opening_balance_cents).toBe(EXPECTED.gl_cash_feb_2026.opening);
    expect(fc.lines.map((l) => l.running_balance_cents)).toEqual([...EXPECTED.gl_cash_feb_2026.running]);
    expect(fc.closing_balance_cents).toBe(EXPECTED.gl_cash_feb_2026.closing);
  });

  test('locked period rejects posting and voiding', () => {
    expect(() =>
      ledger.postJournal({
        date: '2025-12-31',
        memo: 'late',
        lines: [
          { account: '5100', debit_cents: 1 },
          { account: '1000', credit_cents: 1 },
        ],
      }),
    ).toThrow(PeriodLockedError);
    const e2 = ledger.listEntries().find((e) => e.memo === 'Cash revenue')!;
    expect(() => ledger.voidJournal(e2.id, '2025-12-31', 'nope')).toThrow(PeriodLockedError);
  });

  test('reversal is linked and original rows are unchanged', () => {
    const original = ledger.getEntry(e6.id)!;
    expect(original.lines).toEqual(e6.lines);
    expect(original.reversed_by_entry_id).not.toBeNull();
    const reversal = ledger.getEntry(original.reversed_by_entry_id!)!;
    expect(reversal.reverses_entry_id).toBe(e6.id);
    expect(reversal.date).toBe('2026-01-22');
  });

  test('audit chain verifies', () => {
    const v = ledger.verifyAudit();
    expect(v.ok).toBe(true);
    // 7 accounts + 8 postings + 1 void + 1 close
    expect(v.count).toBe(17);
  });
});
