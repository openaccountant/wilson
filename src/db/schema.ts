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

export const INDEXES = `
CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(date);
CREATE INDEX IF NOT EXISTS idx_transactions_category ON transactions(category);
CREATE INDEX IF NOT EXISTS idx_transactions_recurring ON transactions(is_recurring);
`;

export const ALL_SCHEMA: string[] = [
  TRANSACTIONS_TABLE,
  IMPORTS_TABLE,
  INDEXES,
];
