// ── Core Tables ──────────────────────────────────────────────────────────────

export const TRANSACTIONS_TABLE = `
CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  description TEXT NOT NULL,
  amount REAL NOT NULL,
  category TEXT,
  category_confidence REAL,
  user_verified INTEGER DEFAULT 0,
  source_file TEXT,
  bank TEXT,
  account_last4 TEXT,
  is_recurring INTEGER DEFAULT 0,
  tags TEXT,
  notes TEXT,
  plaid_transaction_id TEXT,
  account_name TEXT,
  merchant_name TEXT,
  category_detailed TEXT,
  external_id TEXT,
  payment_channel TEXT,
  pending INTEGER DEFAULT 0,
  authorized_date TEXT,
  account_id INTEGER REFERENCES accounts(id),
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
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL UNIQUE,
  monthly_limit REAL NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
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

export const CHAT_SESSIONS_TABLE = `
CREATE TABLE IF NOT EXISTS chat_sessions (
  id TEXT PRIMARY KEY,
  started_at TEXT DEFAULT (datetime('now')),
  title TEXT
);
`;

export const CHAT_HISTORY_TABLE = `
CREATE TABLE IF NOT EXISTS chat_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  query TEXT NOT NULL,
  answer TEXT,
  summary TEXT,
  session_id TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
`;

// ── Net Worth Tables ─────────────────────────────────────────────────────────

export const ACCOUNTS_TABLE = `
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  account_type TEXT NOT NULL,
  account_subtype TEXT NOT NULL,
  institution TEXT,
  account_number_last4 TEXT,
  current_balance REAL NOT NULL DEFAULT 0,
  currency TEXT DEFAULT 'USD',
  is_active INTEGER DEFAULT 1,
  notes TEXT,
  plaid_account_id TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
`;

export const BALANCE_SNAPSHOTS_TABLE = `
CREATE TABLE IF NOT EXISTS balance_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  balance REAL NOT NULL,
  snapshot_date TEXT NOT NULL,
  source TEXT DEFAULT 'manual',
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);
`;

export const LOANS_TABLE = `
CREATE TABLE IF NOT EXISTS loans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL UNIQUE,
  original_principal REAL NOT NULL,
  interest_rate REAL NOT NULL,
  term_months INTEGER NOT NULL,
  start_date TEXT NOT NULL,
  extra_payment REAL DEFAULT 0,
  linked_asset_id INTEGER,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
  FOREIGN KEY (linked_asset_id) REFERENCES accounts(id) ON DELETE SET NULL
);
`;

// ── Dashboard Auth Tables ─────────────────────────────────────────────────

export const DASHBOARD_USERS_TABLE = `
CREATE TABLE IF NOT EXISTS dashboard_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'viewer' CHECK(role IN ('admin', 'viewer')),
  is_active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
`;

export const DASHBOARD_SESSIONS_TABLE = `
CREATE TABLE IF NOT EXISTS dashboard_sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES dashboard_users(id) ON DELETE CASCADE
);
`;

export const DASHBOARD_CONFIG_TABLE = `
CREATE TABLE IF NOT EXISTS dashboard_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT OR IGNORE INTO dashboard_config (key, value) VALUES ('auth_enabled', 'false');
`;

// ── Observability Tables ───────────────────────────────────────────────────

export const LOGS_TABLE = `
CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  level TEXT NOT NULL,
  message TEXT NOT NULL,
  data TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
`;

export const LLM_TRACES_TABLE = `
CREATE TABLE IF NOT EXISTS llm_traces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trace_id TEXT NOT NULL,
  model TEXT NOT NULL,
  provider TEXT NOT NULL,
  prompt_length INTEGER NOT NULL DEFAULT 0,
  response_length INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
`;

// ── LLM Interaction Capture Tables ───────────────────────────────────────────

export const LLM_INTERACTIONS_TABLE = `
CREATE TABLE IF NOT EXISTS llm_interactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  sequence_num INTEGER NOT NULL,
  call_type TEXT NOT NULL DEFAULT 'agent',
  model TEXT NOT NULL,
  provider TEXT NOT NULL,
  system_prompt TEXT,
  user_prompt TEXT NOT NULL,
  response_content TEXT,
  tool_calls_json TEXT,
  tool_defs_json TEXT,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  total_tokens INTEGER DEFAULT 0,
  duration_ms INTEGER DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ok',
  error TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
`;

export const LLM_TOOL_RESULTS_TABLE = `
CREATE TABLE IF NOT EXISTS llm_tool_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  interaction_id INTEGER NOT NULL,
  tool_call_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  tool_args_json TEXT,
  tool_result TEXT,
  duration_ms INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (interaction_id) REFERENCES llm_interactions(id) ON DELETE CASCADE
);
`;

export const INTERACTION_ANNOTATIONS_TABLE = `
CREATE TABLE IF NOT EXISTS interaction_annotations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  interaction_id INTEGER NOT NULL,
  rating INTEGER CHECK(rating BETWEEN 1 AND 5),
  preference TEXT CHECK(preference IN ('chosen', 'rejected', 'neutral')),
  pair_id TEXT,
  tags TEXT,
  notes TEXT,
  annotated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (interaction_id) REFERENCES llm_interactions(id) ON DELETE CASCADE
);
`;

export const INTERACTION_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_interactions_run_id ON llm_interactions(run_id);
CREATE INDEX IF NOT EXISTS idx_interactions_call_type ON llm_interactions(call_type);
CREATE INDEX IF NOT EXISTS idx_interactions_model ON llm_interactions(model);
CREATE INDEX IF NOT EXISTS idx_interactions_created_at ON llm_interactions(created_at);
CREATE INDEX IF NOT EXISTS idx_tool_results_interaction ON llm_tool_results(interaction_id);
CREATE INDEX IF NOT EXISTS idx_annotations_interaction ON interaction_annotations(interaction_id);
CREATE INDEX IF NOT EXISTS idx_annotations_pair_id ON interaction_annotations(pair_id);
CREATE INDEX IF NOT EXISTS idx_annotations_rating ON interaction_annotations(rating);
`;

// ── Indexes ──────────────────────────────────────────────────────────────────

export const ALL_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(date);
CREATE INDEX IF NOT EXISTS idx_transactions_category ON transactions(category);
CREATE INDEX IF NOT EXISTS idx_transactions_recurring ON transactions(is_recurring);
CREATE INDEX IF NOT EXISTS idx_transactions_plaid_id ON transactions(plaid_transaction_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_external_id ON transactions(external_id) WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_transactions_account_id ON transactions(account_id);
CREATE INDEX IF NOT EXISTS idx_rules_priority ON categorization_rules(priority DESC);
CREATE INDEX IF NOT EXISTS idx_tax_deductions_year ON tax_deductions(tax_year);
CREATE INDEX IF NOT EXISTS idx_tax_deductions_category ON tax_deductions(irs_category);
CREATE INDEX IF NOT EXISTS idx_accounts_type ON accounts(account_type);
CREATE INDEX IF NOT EXISTS idx_accounts_subtype ON accounts(account_subtype);
CREATE INDEX IF NOT EXISTS idx_accounts_last4 ON accounts(account_number_last4);
CREATE INDEX IF NOT EXISTS idx_accounts_plaid_id ON accounts(plaid_account_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_snapshots_account_date ON balance_snapshots(account_id, snapshot_date);
CREATE INDEX IF NOT EXISTS idx_snapshots_date ON balance_snapshots(snapshot_date);
CREATE INDEX IF NOT EXISTS idx_loans_linked_asset ON loans(linked_asset_id);
`;

export const OBSERVABILITY_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_logs_level ON logs(level);
CREATE INDEX IF NOT EXISTS idx_logs_created_at ON logs(created_at);
CREATE INDEX IF NOT EXISTS idx_llm_traces_model ON llm_traces(model);
CREATE INDEX IF NOT EXISTS idx_llm_traces_created_at ON llm_traces(created_at);
CREATE INDEX IF NOT EXISTS idx_llm_traces_status ON llm_traces(status);
`;
