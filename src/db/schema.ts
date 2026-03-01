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
CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_external_id ON transactions(external_id) WHERE external_id IS NOT NULL;
`;

export const CATEGORIZATION_RULES_TABLE = `
CREATE TABLE IF NOT EXISTS categorization_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pattern TEXT NOT NULL,
  category TEXT NOT NULL,
  priority INTEGER DEFAULT 0,
  is_regex INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
`;

export const TAX_DEDUCTIONS_TABLE = `
CREATE TABLE IF NOT EXISTS tax_deductions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  transaction_id INTEGER NOT NULL UNIQUE,
  irs_category TEXT NOT NULL,
  tax_year INTEGER NOT NULL,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE CASCADE
);
`;

export const RULES_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_rules_priority ON categorization_rules(priority DESC);
`;

export const TAX_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_tax_deductions_year ON tax_deductions(tax_year);
CREATE INDEX IF NOT EXISTS idx_tax_deductions_category ON tax_deductions(irs_category);
`;

export const ALL_SCHEMA: string[] = [
  TRANSACTIONS_TABLE,
  IMPORTS_TABLE,
  BUDGETS_TABLE,
  CATEGORIZATION_RULES_TABLE,
  TAX_DEDUCTIONS_TABLE,
];

/** Indexes that depend on columns added by SAFE_MIGRATIONS — must run AFTER migrations. */
export const ALL_INDEXES: string[] = [
  INDEXES,
  RULES_INDEXES,
  TAX_INDEXES,
];

/** Add merchant_name column for enriched merchant data */
export const MERCHANT_NAME_COLUMN = `
ALTER TABLE transactions ADD COLUMN merchant_name TEXT;
`;

/** Add category_detailed column for fine-grained categorization */
export const CATEGORY_DETAILED_COLUMN = `
ALTER TABLE transactions ADD COLUMN category_detailed TEXT;
`;

/** Add external_id column for dedup across data sources */
export const EXTERNAL_ID_COLUMN = `
ALTER TABLE transactions ADD COLUMN external_id TEXT;
`;

/** Add payment_channel column (online, in store, etc.) */
export const PAYMENT_CHANNEL_COLUMN = `
ALTER TABLE transactions ADD COLUMN payment_channel TEXT;
`;

/** Add pending column to track pending vs posted */
export const PENDING_COLUMN = `
ALTER TABLE transactions ADD COLUMN pending INTEGER DEFAULT 0;
`;

/** Add authorized_date column for authorization date */
export const AUTHORIZED_DATE_COLUMN = `
ALTER TABLE transactions ADD COLUMN authorized_date TEXT;
`;

/**
 * Safe ALTER TABLE statements that may fail if columns already exist.
 * These should be run with error handling (ignore "duplicate column" errors).
 */
export const SAFE_MIGRATIONS: string[] = [
  PLAID_COLUMNS,
  ACCOUNT_NAME_COLUMN,
  MERCHANT_NAME_COLUMN,
  CATEGORY_DETAILED_COLUMN,
  EXTERNAL_ID_COLUMN,
  PAYMENT_CHANNEL_COLUMN,
  PENDING_COLUMN,
  AUTHORIZED_DATE_COLUMN,
];
