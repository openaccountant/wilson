import type { LedgerDatabase } from './storage.js';

/**
 * Ledger tables. All prefixed "ledger_" so they can share a database file with
 * other data without collisions. Every statement is idempotent.
 *
 * Journal, audit and period-close tables are append-only: triggers reject
 * UPDATE/DELETE, so the only way to change history is a reversing entry.
 * Accounts can never be deleted, and only their active flag may change, since
 * an account's code, name and kind determine how every report reads history.
 * The triggers stop accidental writes; verifyAudit() catches anyone who drops
 * them, by reconciling these tables against the hash-chained audit log.
 */
const DDL = `
CREATE TABLE IF NOT EXISTS ledger_accounts (
  code   TEXT PRIMARY KEY NOT NULL CHECK (length(code) > 0),
  name   TEXT NOT NULL,
  kind   TEXT NOT NULL CHECK (kind IN ('asset','liability','equity','income','expense')),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1))
);

CREATE TABLE IF NOT EXISTS ledger_entries (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  date              TEXT NOT NULL,
  memo              TEXT NOT NULL,
  external_id       TEXT UNIQUE,
  payload_hash      TEXT NOT NULL,
  reverses_entry_id INTEGER UNIQUE REFERENCES ledger_entries(id),
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ledger_entries_date ON ledger_entries(date, id);

CREATE TABLE IF NOT EXISTS ledger_lines (
  entry_id     INTEGER NOT NULL REFERENCES ledger_entries(id),
  line_no      INTEGER NOT NULL,
  account_code TEXT NOT NULL REFERENCES ledger_accounts(code),
  debit_cents  INTEGER NOT NULL CHECK (debit_cents >= 0),
  credit_cents INTEGER NOT NULL CHECK (credit_cents >= 0),
  memo         TEXT,
  PRIMARY KEY (entry_id, line_no),
  CHECK ((debit_cents > 0) <> (credit_cents > 0))
);
CREATE INDEX IF NOT EXISTS ledger_lines_account ON ledger_lines(account_code);

CREATE TABLE IF NOT EXISTS ledger_period_closes (
  end_date  TEXT PRIMARY KEY NOT NULL,
  closed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ledger_audit (
  seq       INTEGER PRIMARY KEY,
  at        TEXT NOT NULL,
  type      TEXT NOT NULL,
  payload   TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ledger_audit_type ON ledger_audit(type, seq);

CREATE TRIGGER IF NOT EXISTS ledger_entries_no_update BEFORE UPDATE ON ledger_entries
BEGIN SELECT RAISE(ABORT, 'ledger_entries is append-only'); END;
CREATE TRIGGER IF NOT EXISTS ledger_entries_no_delete BEFORE DELETE ON ledger_entries
BEGIN SELECT RAISE(ABORT, 'ledger_entries is append-only'); END;
CREATE TRIGGER IF NOT EXISTS ledger_lines_no_update BEFORE UPDATE ON ledger_lines
BEGIN SELECT RAISE(ABORT, 'ledger_lines is append-only'); END;
CREATE TRIGGER IF NOT EXISTS ledger_lines_no_delete BEFORE DELETE ON ledger_lines
BEGIN SELECT RAISE(ABORT, 'ledger_lines is append-only'); END;
CREATE TRIGGER IF NOT EXISTS ledger_audit_no_update BEFORE UPDATE ON ledger_audit
BEGIN SELECT RAISE(ABORT, 'ledger_audit is append-only'); END;
CREATE TRIGGER IF NOT EXISTS ledger_audit_no_delete BEFORE DELETE ON ledger_audit
BEGIN SELECT RAISE(ABORT, 'ledger_audit is append-only'); END;
CREATE TRIGGER IF NOT EXISTS ledger_period_closes_no_update BEFORE UPDATE ON ledger_period_closes
BEGIN SELECT RAISE(ABORT, 'ledger_period_closes is append-only'); END;
CREATE TRIGGER IF NOT EXISTS ledger_period_closes_no_delete BEFORE DELETE ON ledger_period_closes
BEGIN SELECT RAISE(ABORT, 'ledger_period_closes is append-only'); END;
CREATE TRIGGER IF NOT EXISTS ledger_accounts_no_rewrite BEFORE UPDATE OF code, name, kind ON ledger_accounts
BEGIN SELECT RAISE(ABORT, 'ledger_accounts code, name and kind are immutable'); END;
CREATE TRIGGER IF NOT EXISTS ledger_accounts_no_delete BEFORE DELETE ON ledger_accounts
BEGIN SELECT RAISE(ABORT, 'ledger_accounts rows cannot be deleted'); END;
`;

export function initLedgerSchema(db: LedgerDatabase): void {
  db.exec(DDL);
}
