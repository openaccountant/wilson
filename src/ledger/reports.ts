import { accountActivity, BEGINNING, normalSideBalance } from './balances.js';
import { assertIsoDate, assertRange, dayBefore, yearStart } from './dates.js';
import type { LedgerDatabase } from './storage.js';
import type { AmountRow, BalanceSheet, ProfitLoss, TrialBalance, TrialBalanceRow } from './types.js';

export function trialBalance(db: LedgerDatabase, asOf: string): TrialBalance {
  assertIsoDate(asOf, 'as_of');
  let totalDebit = 0;
  let totalCredit = 0;
  const rows: TrialBalanceRow[] = accountActivity(db, BEGINNING, asOf).map((a) => {
    const net = a.debits - a.credits;
    const row: TrialBalanceRow = {
      code: a.code,
      name: a.name,
      kind: a.kind,
      total_debits_cents: a.debits,
      total_credits_cents: a.credits,
      debit_balance_cents: net > 0 ? net : 0,
      credit_balance_cents: net < 0 ? -net : 0,
    };
    totalDebit += row.debit_balance_cents;
    totalCredit += row.credit_balance_cents;
    return row;
  });
  return {
    as_of: asOf,
    rows,
    total_debit_cents: totalDebit,
    total_credit_cents: totalCredit,
    balanced: totalDebit === totalCredit,
  };
}

export function profitLoss(db: LedgerDatabase, start: string, end: string): ProfitLoss {
  assertRange(start, end);
  const income: AmountRow[] = [];
  const expense: AmountRow[] = [];
  for (const a of accountActivity(db, start, end)) {
    if (a.kind !== 'income' && a.kind !== 'expense') continue;
    const row = { code: a.code, name: a.name, amount_cents: normalSideBalance(a.kind, a.debits, a.credits) };
    (a.kind === 'income' ? income : expense).push(row);
  }
  const totalIncome = sum(income);
  const totalExpense = sum(expense);
  return {
    start,
    end,
    income,
    expense,
    total_income_cents: totalIncome,
    total_expense_cents: totalExpense,
    net_income_cents: totalIncome - totalExpense,
  };
}

/** Net income (income - expense) over an inclusive range; 0 for an empty range. */
function netIncome(db: LedgerDatabase, start: string, end: string): number {
  if (start > end) return 0;
  let net = 0;
  for (const a of accountActivity(db, start, end)) {
    if (a.kind === 'income') net += a.credits - a.debits;
    else if (a.kind === 'expense') net -= a.debits - a.credits;
  }
  return net;
}

/**
 * Balance sheet with earnings rolled into equity: prior fiscal years' net
 * income as retained earnings, the current year's as current-year earnings,
 * so total assets == total liabilities + total equity.
 */
export function balanceSheet(db: LedgerDatabase, asOf: string): BalanceSheet {
  assertIsoDate(asOf, 'as_of');
  const assets: AmountRow[] = [];
  const liabilities: AmountRow[] = [];
  const equity: AmountRow[] = [];
  for (const a of accountActivity(db, BEGINNING, asOf)) {
    const row = { code: a.code, name: a.name, amount_cents: normalSideBalance(a.kind, a.debits, a.credits) };
    if (a.kind === 'asset') assets.push(row);
    else if (a.kind === 'liability') liabilities.push(row);
    else if (a.kind === 'equity') equity.push(row);
  }
  const fyStart = yearStart(asOf);
  const retained = netIncome(db, BEGINNING, dayBefore(fyStart));
  const current = netIncome(db, fyStart, asOf);
  const totalAssets = sum(assets);
  const totalLiabilities = sum(liabilities);
  const totalEquity = sum(equity) + retained + current;
  return {
    as_of: asOf,
    assets,
    liabilities,
    equity,
    retained_earnings_cents: retained,
    current_year_earnings_cents: current,
    total_assets_cents: totalAssets,
    total_liabilities_cents: totalLiabilities,
    total_equity_cents: totalEquity,
    balanced: totalAssets === totalLiabilities + totalEquity,
  };
}

function sum(rows: AmountRow[]): number {
  return rows.reduce((s, r) => s + r.amount_cents, 0);
}
