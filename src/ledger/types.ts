import type { Cents } from './money.js';

export type AccountKind = 'asset' | 'liability' | 'equity' | 'income' | 'expense';
export type NormalBalance = 'debit' | 'credit';

export const ACCOUNT_KINDS: readonly AccountKind[] = ['asset', 'liability', 'equity', 'income', 'expense'];

/** Assets and expenses are debit-normal; liabilities, equity and income are credit-normal. */
export function normalBalanceOf(kind: AccountKind): NormalBalance {
  return kind === 'asset' || kind === 'expense' ? 'debit' : 'credit';
}

export interface Account {
  code: string;
  name: string;
  kind: AccountKind;
  normal_balance: NormalBalance;
  active: boolean;
}

export interface NewAccount {
  code: string;
  name: string;
  kind: AccountKind;
  active?: boolean;
}

/** Exactly one of debit_cents / credit_cents must be > 0; the other omitted or 0. */
export interface JournalLineInput {
  account: string;
  debit_cents?: Cents;
  credit_cents?: Cents;
  memo?: string;
}

export interface PostJournalInput {
  date: string;
  memo: string;
  lines: JournalLineInput[];
  external_id?: string;
}

export interface JournalLine {
  line_no: number;
  account: string;
  debit_cents: Cents;
  credit_cents: Cents;
  memo: string | null;
}

export interface JournalEntry {
  id: number;
  date: string;
  memo: string;
  external_id: string | null;
  reverses_entry_id: number | null;
  reversed_by_entry_id: number | null;
  created_at: string;
  lines: JournalLine[];
}

export interface LedgerOptions {
  /** Clock for created_at / audit timestamps. Defaults to new Date().toISOString(). */
  now?: () => string;
}

export interface AuditVerification {
  ok: boolean;
  count: number;
  /** First audit seq that failed verification, if any. */
  failed_seq?: number;
  /** First journal entry whose stored rows no longer match its audited hash, if any. */
  failed_entry_id?: number;
  reason?: string;
}

// ---- Reports -------------------------------------------------------------

export interface TrialBalanceRow {
  code: string;
  name: string;
  kind: AccountKind;
  total_debits_cents: Cents;
  total_credits_cents: Cents;
  debit_balance_cents: Cents;
  credit_balance_cents: Cents;
}

export interface TrialBalance {
  as_of: string;
  rows: TrialBalanceRow[];
  total_debit_cents: Cents;
  total_credit_cents: Cents;
  balanced: boolean;
}

export interface AmountRow {
  code: string;
  name: string;
  /** Balance on the account's normal side (positive is normal). */
  amount_cents: Cents;
}

export interface ProfitLoss {
  start: string;
  end: string;
  income: AmountRow[];
  expense: AmountRow[];
  total_income_cents: Cents;
  total_expense_cents: Cents;
  net_income_cents: Cents;
}

export interface BalanceSheet {
  as_of: string;
  assets: AmountRow[];
  liabilities: AmountRow[];
  equity: AmountRow[];
  /** Net income of all fiscal years before as_of's year (no closing entries are posted). */
  retained_earnings_cents: Cents;
  /** Net income from Jan 1 of as_of's year through as_of. */
  current_year_earnings_cents: Cents;
  total_assets_cents: Cents;
  total_liabilities_cents: Cents;
  /** Equity accounts + retained earnings + current-year earnings. */
  total_equity_cents: Cents;
  balanced: boolean;
}

export interface GeneralLedgerLine {
  entry_id: number;
  date: string;
  entry_memo: string;
  line_no: number;
  memo: string | null;
  debit_cents: Cents;
  credit_cents: Cents;
  /** Running balance on the account's normal side. */
  running_balance_cents: Cents;
}

export interface GeneralLedgerAccount {
  code: string;
  name: string;
  kind: AccountKind;
  normal_balance: NormalBalance;
  opening_balance_cents: Cents;
  lines: GeneralLedgerLine[];
  closing_balance_cents: Cents;
}

export interface GeneralLedger {
  start: string;
  end: string;
  accounts: GeneralLedgerAccount[];
}
