/**
 * Self-contained double-entry ledger engine.
 *
 * - Money is integer cents (safe integers); floats are rejected.
 * - Storage is any SQLite handle with exec/prepare (bun:sqlite works as-is).
 * - Journal and audit tables are append-only; corrections are reversing entries.
 */
export { Ledger } from './ledger.js';
export type { LedgerDatabase, LedgerStatement, SqlValue } from './storage.js';
export { withTransaction } from './storage.js';
export { initLedgerSchema } from './schema.js';
export { assertCents, type Cents } from './money.js';
export { canonicalJson } from './canonical.js';
export { GENESIS_HASH } from './audit.js';
export { JOURNAL_CSV_HEADER } from './export.js';
export {
  AlreadyVoidedError,
  ConflictError,
  InactiveAccountError,
  InvalidMoneyError,
  LedgerError,
  LedgerValidationError,
  NotFoundError,
  PeriodLockedError,
  UnbalancedEntryError,
  type LedgerErrorCode,
} from './errors.js';
export { ACCOUNT_KINDS, normalBalanceOf } from './types.js';
export type {
  Account,
  AccountKind,
  AmountRow,
  AuditVerification,
  BalanceSheet,
  GeneralLedger,
  GeneralLedgerAccount,
  GeneralLedgerLine,
  JournalEntry,
  JournalLine,
  JournalLineInput,
  LedgerOptions,
  NewAccount,
  NormalBalance,
  PostJournalInput,
  ProfitLoss,
  TrialBalance,
  TrialBalanceRow,
} from './types.js';
