export const TRANSACTIONS_TABLE = `
CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,                      -- YYYY-MM-DD
  description TEXT NOT NULL,
  amount REAL NOT NULL,                    -- negative = expense, positive = income/credit
  category TEXT,
  category_confidence REAL,
  user_verified INTEGER DEFAULT 0,
  source_file TEXT,
  bank TEXT,
  account_last4 TEXT,
  is_recurring INTEGER DEFAULT 0,
  tags TEXT,                               -- JSON array
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
`;

export const IMPORTS_TABLE = `
CREATE TABLE IF NOT EXISTS imports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_path TEXT NOT NULL,
  file_hash TEXT NOT NULL UNIQUE,
  bank TEXT,
  transaction_count INTEGER,
  date_range_start TEXT,
  date_range_end TEXT,
  imported_at TEXT DEFAULT (datetime('now'))
);
`;

export const BUDGETS_TABLE = `
CREATE TABLE IF NOT EXISTS budgets (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  category    TEXT NOT NULL UNIQUE,
  monthly_limit REAL NOT NULL,
  created_at  TEXT DEFAULT (datetime('now')),
  updated_at  TEXT DEFAULT (datetime('now'))
);
`;

/** Safe ALTER TABLE additions for Plaid support (idempotent). */
export const PLAID_COLUMNS = `
-- Add plaid_transaction_id for dedup (ignore error if already exists)
ALTER TABLE transactions ADD COLUMN plaid_transaction_id TEXT;
`;

/** Add account_name column for multi-account display */
export const ACCOUNT_NAME_COLUMN = `
ALTER TABLE transactions ADD COLUMN account_name TEXT;
`;

export const INDEXES = `
CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(date);
CREATE INDEX IF NOT EXISTS idx_transactions_category ON transactions(category);
CREATE INDEX IF NOT EXISTS idx_transactions_recurring ON transactions(is_recurring);
CREATE INDEX IF NOT EXISTS idx_transactions_plaid_id ON transactions(plaid_transaction_id);
`;

export const ALL_SCHEMA: string[] = [
  TRANSACTIONS_TABLE,
  IMPORTS_TABLE,
  BUDGETS_TABLE,
  INDEXES,
];

/**
 * Safe ALTER TABLE statements that may fail if columns already exist.
 * These should be run with error handling (ignore "duplicate column" errors).
 */
export const SAFE_MIGRATIONS: string[] = [
  PLAID_COLUMNS,
  ACCOUNT_NAME_COLUMN,
];
