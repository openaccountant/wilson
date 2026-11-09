import * as accounts from './accounts.js';
import { exportJournalCsv } from './export.js';
import { generalLedger } from './general-ledger.js';
import * as journal from './journal.js';
import * as periods from './periods.js';
import * as reports from './reports.js';
import { initLedgerSchema } from './schema.js';
import type { LedgerDatabase } from './storage.js';
import type {
  Account,
  AuditVerification,
  BalanceSheet,
  GeneralLedger,
  JournalEntry,
  LedgerOptions,
  NewAccount,
  PostJournalInput,
  ProfitLoss,
  TrialBalance,
} from './types.js';
import { verifyAudit } from './verify.js';

/**
 * Double-entry ledger over any SQLite handle matching {@link LedgerDatabase}.
 * Call init() once before use (safe to call repeatedly).
 */
export class Ledger {
  private readonly db: LedgerDatabase;
  private readonly now: () => string;

  constructor(db: LedgerDatabase, options: LedgerOptions = {}) {
    this.db = db;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  /** Creates ledger_* tables and triggers if missing. Idempotent. */
  init(): this {
    initLedgerSchema(this.db);
    return this;
  }

  // Chart of accounts
  createAccount(input: NewAccount): Account {
    return accounts.createAccount(this.db, this.now(), input);
  }
  setAccountActive(code: string, active: boolean): Account {
    return accounts.setAccountActive(this.db, this.now(), code, active);
  }
  getAccount(code: string): Account | null {
    return accounts.getAccount(this.db, code);
  }
  listAccounts(): Account[] {
    return accounts.listAccounts(this.db);
  }

  // Journal
  postJournal(input: PostJournalInput): JournalEntry {
    return journal.postJournal(this.db, this.now(), input);
  }
  voidJournal(entryId: number, date: string, memo: string): JournalEntry {
    return journal.voidJournal(this.db, this.now(), entryId, date, memo);
  }
  getEntry(id: number): JournalEntry | null {
    return journal.getEntry(this.db, id);
  }
  getEntryByExternalId(externalId: string): JournalEntry | null {
    return journal.getEntryByExternalId(this.db, externalId);
  }
  listEntries(start?: string, end?: string): JournalEntry[] {
    return journal.listEntries(this.db, start, end);
  }

  // Periods
  closePeriod(endDate: string): string {
    return periods.closePeriod(this.db, this.now(), endDate);
  }
  lockedThrough(): string | null {
    return periods.lockedThrough(this.db);
  }

  // Audit
  verifyAudit(): AuditVerification {
    return verifyAudit(this.db);
  }

  // Reports
  trialBalance(asOf: string): TrialBalance {
    return reports.trialBalance(this.db, asOf);
  }
  profitLoss(start: string, end: string): ProfitLoss {
    return reports.profitLoss(this.db, start, end);
  }
  balanceSheet(asOf: string): BalanceSheet {
    return reports.balanceSheet(this.db, asOf);
  }
  generalLedger(start: string, end: string, account?: string): GeneralLedger {
    return generalLedger(this.db, start, end, account);
  }

  // Export
  exportJournalCsv(start?: string, end?: string): string {
    return exportJournalCsv(this.db, start, end);
  }
}
