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

// ── Categories Table ─────────────────────────────────────────────────────────

export const CATEGORIES_TABLE = `
CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  parent_id INTEGER,
  description TEXT,
  is_system INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (parent_id) REFERENCES categories(id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_categories_parent_id ON categories(parent_id);
CREATE INDEX IF NOT EXISTS idx_categories_slug ON categories(slug);
`;

export const CATEGORIES_SEED = `
INSERT OR IGNORE INTO categories (name, slug, is_system, sort_order, description) VALUES
  ('Dining', 'dining', 1, 1, 'Restaurants, fast food, coffee shops, bars, takeout'),
  ('Groceries', 'groceries', 1, 2, 'Supermarkets, grocery stores, farmers markets, food delivery'),
  ('Transport', 'transport', 1, 3, 'Gas, ride-share, parking, tolls, public transit, car maintenance'),
  ('Shopping', 'shopping', 1, 4, 'Retail, clothing, electronics, household items, online shopping'),
  ('Subscriptions', 'subscriptions', 1, 5, 'Streaming services, software, memberships, recurring digital services'),
  ('Utilities', 'utilities', 1, 6, 'Electric, gas, water, internet, phone, trash'),
  ('Health', 'health', 1, 7, 'Doctor visits, pharmacy, dental, vision, gym, fitness'),
  ('Entertainment', 'entertainment', 1, 8, 'Movies, concerts, games, hobbies, sports events'),
  ('Travel', 'travel', 1, 9, 'Flights, hotels, rental cars, vacation expenses'),
  ('Education', 'education', 1, 10, 'Tuition, books, courses, training, school supplies'),
  ('Home', 'home', 1, 11, 'Rent, mortgage, repairs, furniture, home improvement'),
  ('Personal Care', 'personal-care', 1, 12, 'Haircuts, salon, skincare, spa'),
  ('Insurance', 'insurance', 1, 13, 'Health, auto, home, life, renters insurance premiums'),
  ('Gifts', 'gifts', 1, 14, 'Gifts for others, donations, charitable contributions'),
  ('Fees & Interest', 'fees-interest', 1, 15, 'Bank fees, ATM fees, credit card interest, late fees'),
  ('Income', 'income', 1, 16, 'Salary, freelance income, refunds, reimbursements'),
  ('Transfer', 'transfer', 1, 17, 'Account transfers, Venmo/Zelle/PayPal between own accounts'),
  ('Other', 'other', 1, 18, 'Transactions that do not fit any other category');
`;

// ── Goals & Memory Tables ────────────────────────────────────────────────────

export const GOALS_TABLE = `
CREATE TABLE IF NOT EXISTS goals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  goal_type TEXT NOT NULL CHECK(goal_type IN ('financial', 'behavioral')),
  target_amount REAL,
  current_amount REAL DEFAULT 0,
  target_date TEXT,
  category TEXT,
  account_id INTEGER,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'completed', 'paused', 'abandoned')),
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE SET NULL
);
`;

export const GOAL_SNAPSHOTS_TABLE = `
CREATE TABLE IF NOT EXISTS goal_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  goal_id INTEGER NOT NULL,
  amount REAL NOT NULL,
  snapshot_date TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (goal_id) REFERENCES goals(id) ON DELETE CASCADE
);
`;

export const MEMORIES_TABLE = `
CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_type TEXT NOT NULL CHECK(memory_type IN ('context', 'insight', 'advice')),
  content TEXT NOT NULL,
  category TEXT,
  source_query TEXT,
  expires_at TEXT,
  is_active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);
`;

export const GOALS_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_goals_status ON goals(status);
CREATE INDEX IF NOT EXISTS idx_goals_type ON goals(goal_type);
CREATE INDEX IF NOT EXISTS idx_goal_snapshots_goal ON goal_snapshots(goal_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_goal_snapshots_goal_date ON goal_snapshots(goal_id, snapshot_date);
CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(memory_type);
CREATE INDEX IF NOT EXISTS idx_memories_active ON memories(is_active);
`;

// ── Entities Table ──────────────────────────────────────────────────────────

export const ENTITIES_TABLE = `
CREATE TABLE IF NOT EXISTS entities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  slug TEXT NOT NULL UNIQUE,
  description TEXT,
  color TEXT DEFAULT '#22c55e',
  is_default INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
INSERT OR IGNORE INTO entities (name, slug, is_default, description)
  VALUES ('Personal', 'personal', 1, 'Personal finances');
`;

export const ENTITY_ID_COLUMNS = `
ALTER TABLE transactions ADD COLUMN entity_id INTEGER REFERENCES entities(id);
ALTER TABLE accounts ADD COLUMN entity_id INTEGER REFERENCES entities(id);
ALTER TABLE budgets ADD COLUMN entity_id INTEGER REFERENCES entities(id);
CREATE INDEX IF NOT EXISTS idx_transactions_entity_id ON transactions(entity_id);
CREATE INDEX IF NOT EXISTS idx_accounts_entity_id ON accounts(entity_id);
CREATE INDEX IF NOT EXISTS idx_budgets_entity_id ON budgets(entity_id);
`;

// ── Goal Percentage-of-Income Columns (migration v22) ───────────────────────
// NOTE: these columns live only in this migration, not in the GOALS_TABLE /
// GOAL_SNAPSHOTS_TABLE CREATE statements above — fresh installs run all
// migrations in order, and re-adding them in the CREATE would make this
// ALTER fail with "duplicate column" (see ENTITY_ID_COLUMNS precedent).

export const GOAL_TARGET_PERCENT_COLUMNS = `
ALTER TABLE goals ADD COLUMN target_percent REAL;
ALTER TABLE goals ADD COLUMN income_period TEXT;
ALTER TABLE goal_snapshots ADD COLUMN resolved_target REAL;
`;

// ── Categorization Review Queue (migration v24) ─────────────────────────────
// Below-threshold AI categorization suggestions are never applied to
// transactions.category — they are held here as pending rows until a human
// reviews them. The partial unique index makes duplicate pending rows for the
// same transaction impossible at the storage level (INSERT OR IGNORE relies
// on it). The backfill flags historically auto-applied low-confidence model
// categorizations into the queue WITHOUT touching their applied category —
// reports stay undistorted until a human acts. The 0.7 literal is the
// default threshold; migrations cannot read the per-profile settings file.
// Rows with NULL category_confidence are bank/import-provided categories, not
// model output, and deliberately stay out of the queue.

export const CATEGORIZATION_REVIEWS_TABLE = `
CREATE TABLE IF NOT EXISTS categorization_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  transaction_id INTEGER NOT NULL,
  suggested_category TEXT NOT NULL,
  confidence REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_categorization_reviews_txn ON categorization_reviews(transaction_id);
CREATE INDEX IF NOT EXISTS idx_categorization_reviews_status ON categorization_reviews(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_categorization_reviews_pending_txn
  ON categorization_reviews(transaction_id) WHERE status = 'pending';
INSERT INTO categorization_reviews (transaction_id, suggested_category, confidence, status)
SELECT id, category, category_confidence, 'pending'
FROM transactions
WHERE category IS NOT NULL
  AND category_confidence IS NOT NULL
  AND category_confidence < 0.7
  AND COALESCE(user_verified, 0) = 0;
`;

// ── Embeddings Table (migration v23) ────────────────────────────────────────
// Track B of the local-memory design: locally-computed semantic vectors for
// chat turns, transactions, and memories. `vec` holds a serialized
// L2-normalized Float32Array; `dim` is recorded per row so a future model
// switch is diagnosable. The UNIQUE triple makes upserts idempotent per
// (source_type, source_id, model) and lets a re-index with a new model
// coexist with the old one.
// No FK to source tables — embeddings are deleted via the explicit
// deleteEmbeddings hook, and the table stays generic over source types.

export const EMBEDDINGS_TABLE = `
CREATE TABLE IF NOT EXISTS embeddings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_type TEXT NOT NULL CHECK(source_type IN ('chat','transaction','memory')),
  source_id INTEGER NOT NULL,
  model TEXT NOT NULL,
  dim INTEGER NOT NULL,
  vec BLOB NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(source_type, source_id, model)
);
`;

export const EMBEDDINGS_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_embeddings_source ON embeddings(source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_embeddings_model ON embeddings(model);
`;

// ── Transaction Revision Column (migration v25) ─────────────────────────────
// Optimistic-concurrency guard for the WebMCP mutation prepare/commit protocol
// (see src/mcp/store.ts). Every successful write to a transaction row bumps
// this counter; commit() requires the caller's prepare-time revision to still
// match, so a stale confirmation card can never silently overwrite a row the
// user (or another agent) already changed. Same ALTER-only convention as
// GOAL_TARGET_PERCENT_COLUMNS above — never add this to TRANSACTIONS_TABLE.

export const TRANSACTION_REVISION_COLUMN = `
ALTER TABLE transactions ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
`;

// ── WebMCP Bridge Tables (migration v26) ────────────────────────────────────
// Persisted grant + prepare/commit-operation store for the WebMCP bridge
// (src/mcp/store.ts). Mirrors the dashboard_sessions/cleanExpiredSessions
// pattern in src/dashboard/auth.ts: rows are the durable source of truth for
// scope checks, and a cheap periodic sweep clears expired ones.

export const MCP_GRANTS_TABLE = `
CREATE TABLE IF NOT EXISTS mcp_grants (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  schema_digest TEXT NOT NULL,
  user_id INTEGER,
  role TEXT NOT NULL,
  profile TEXT NOT NULL,
  origin TEXT NOT NULL,
  session_generation TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_mcp_grants_batch ON mcp_grants(batch_id);
CREATE INDEX IF NOT EXISTS idx_mcp_grants_session ON mcp_grants(session_generation);
CREATE INDEX IF NOT EXISTS idx_mcp_grants_expires ON mcp_grants(expires_at);
`;

export const MCP_OPERATIONS_TABLE = `
CREATE TABLE IF NOT EXISTS mcp_operations (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  grant_id TEXT,
  tool_name TEXT NOT NULL,
  args_json TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT,
  transaction_id INTEGER,
  revision_at_prepare INTEGER,
  profile TEXT NOT NULL,
  origin TEXT NOT NULL,
  session_generation TEXT NOT NULL,
  user_id INTEGER,
  role TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  outcome_json TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_mcp_operations_status ON mcp_operations(status);
CREATE INDEX IF NOT EXISTS idx_mcp_operations_session ON mcp_operations(session_generation);
CREATE INDEX IF NOT EXISTS idx_mcp_operations_expires ON mcp_operations(expires_at);
`;

export const MCP_APPROVAL_TOKENS_TABLE = `
CREATE TABLE IF NOT EXISTS mcp_approval_tokens (
  token TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  used_at TEXT,
  FOREIGN KEY (operation_id) REFERENCES mcp_operations(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_mcp_approval_tokens_operation ON mcp_approval_tokens(operation_id);
`;

// ── MCP Operation Summary Column (migration v27) ────────────────────────────
// Server-computed one-liner from prepareMutation (src/mcp/tool-catalog.ts)
// naming the exact change a prepared mutation would make — which transaction,
// from/to — so the confirmation card carries semantic context for a financial
// mutation, not just a key/value field delta. Same ALTER-only convention as
// TRANSACTION_REVISION_COLUMN above — never add this to MCP_OPERATIONS_TABLE.

export const MCP_OPERATION_SUMMARY_COLUMN = `
ALTER TABLE mcp_operations ADD COLUMN summary TEXT;
`;

// ── MCP Audit Log (migration v28) ───────────────────────────────────────────
// One row per agent tool call (see src/mcp/audit.ts), so a user can find out
// what an agent read or changed. Reads are audited, not just mutations.
// "Noise" decisions (rate_limited, invalid_args, denied_*) are folded into one
// row per principal, tool, decision and minute (the partial unique index below
// is the upsert target), so cheap failures cannot flush the rows that record an
// earlier exfiltration. principal_id is a hash or an id, never a raw
// sessionGeneration. Never exported.

export const MCP_AUDIT_LOG_TABLE = `
CREATE TABLE IF NOT EXISTS mcp_audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  tier TEXT NOT NULL DEFAULT 'signal',   -- signal | noise | summary | sentinel
  transport TEXT NOT NULL,       -- client-reported: imperative | declarative | page; server-derived: http-mcp | chat | rest
  principal_kind TEXT NOT NULL,  -- tab | client_token | chat | user
  principal_id TEXT NOT NULL,    -- sha256(sessionGeneration)[:16] | token id | 'chat' | 'user:<id|anon>'
  user_id INTEGER,
  role TEXT NOT NULL,
  origin TEXT NOT NULL,
  tool_name TEXT NOT NULL,       -- or REST route for transport='rest'
  classification TEXT NOT NULL,
  decision TEXT NOT NULL,        -- signal: allowed | operation_created | approved | rejected | committed | stale | expired
                                 --   | cancelled | error | rest_export
                                 -- noise: denied_policy | denied_kill_switch | denied_grant | denied_role | invalid_args | rate_limited
                                 -- sentinel: audit_compacted | audit_evicted | deep_paging
  operation_id TEXT,
  grant_id TEXT,
  args_preview TEXT,             -- canonical JSON, sanitized + PII-masked, <=512 chars
  result_chars INTEGER,
  page_index INTEGER,
  duration_ms INTEGER,
  error_code TEXT,
  count INTEGER NOT NULL DEFAULT 1,   -- >1 for noise aggregates and summaries
  bucket TEXT                          -- 'YYYY-MM-DDTHH:MM' for noise, 'YYYY-MM-DDTHH' for summary
);
CREATE INDEX IF NOT EXISTS idx_mcp_audit_ts ON mcp_audit_log(ts);
CREATE INDEX IF NOT EXISTS idx_mcp_audit_tool ON mcp_audit_log(tool_name);
CREATE INDEX IF NOT EXISTS idx_mcp_audit_decision ON mcp_audit_log(decision);
CREATE UNIQUE INDEX IF NOT EXISTS idx_mcp_audit_noise_bucket
  ON mcp_audit_log(principal_id, tool_name, decision, bucket) WHERE tier = 'noise';
`;

// ── MCP Client Tokens (migration v29) ───────────────────────────────────────
// Dedicated bearer tokens for external MCP clients on `/mcp` (see
// src/mcp/client-tokens.ts). The plaintext (`wmcp_` + 32 random bytes) is shown
// once at mint and never stored: only its sha256 and a display prefix are. A
// token's tools are the `mcp_grants` rows with session_generation = 'tok:<id>'.
// The role is re-checked live against dashboard_users on every use.

export const MCP_CLIENT_TOKENS_TABLE = `
CREATE TABLE IF NOT EXISTS mcp_client_tokens (
  id TEXT PRIMARY KEY,                 -- uuid
  name TEXT NOT NULL,                  -- <=40, user label ("Hronaut laptop")
  token_hash TEXT NOT NULL UNIQUE,     -- sha256 hex of the full plaintext
  token_prefix TEXT NOT NULL,          -- first 12 chars, display only ("wmcp_Ab3xQ9")
  user_id INTEGER,                     -- NULL when auth is disabled
  role TEXT NOT NULL,                  -- role at mint; re-checked live against dashboard_users
  created_at TEXT DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT,
  rotated_from TEXT                    -- previous token id
);
CREATE INDEX IF NOT EXISTS idx_mcp_client_tokens_user ON mcp_client_tokens(user_id);
`;

// ── MCP Tool Policies (migration v30) ───────────────────────────────────────
// Per user, per profile: Off / Ask every time / Allow for each agent tool
// (src/mcp/policies.ts). `user_key` is the dashboard user id, or 0 while auth is
// disabled. A row is only a choice: grants are still required, and a mutating
// tool can never be Allow (the engine clamps it to Ask even if a row says allow).

export const MCP_TOOL_POLICIES_TABLE = `
CREATE TABLE IF NOT EXISTS mcp_tool_policies (
  user_key INTEGER NOT NULL,           -- dashboard user id; 0 when auth disabled
  tool_name TEXT NOT NULL,
  policy TEXT NOT NULL CHECK(policy IN ('off','ask','allow')),
  updated_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (user_key, tool_name)
);
`;

// ── MCP Operation Kind (migration v31) ──────────────────────────────────────
// `kind` says what an operation is: a change to confirm (`mutation`, every row
// before v31), a read the user must allow (`read`, policy Ask), or later a batch
// of proposals. `bank_data` is the quoted transaction description a card shows
// on its own row, kept out of `summary` so server wording and bank text are never
// one string (threat T10). Same ALTER-only convention as TRANSACTION_REVISION_COLUMN
// above: never add these to MCP_OPERATIONS_TABLE.

export const MCP_OPERATION_KIND_COLUMNS = `
ALTER TABLE mcp_operations ADD COLUMN kind TEXT NOT NULL DEFAULT 'mutation';
ALTER TABLE mcp_operations ADD COLUMN bank_data TEXT;
`;

// ── Annotation provenance (migration v32) ───────────────────────────────────
// A label is now a VERSIONED row with a source (a human, or a judge agent) and a status. Rows are never edited:
// a human re-rating inserts a new version and supersedes the old one; a judge only ever inserts `proposed` rows
// that a human accepts, rejects or later revokes. ALTER-only, like every change to an existing table: never add
// these columns to INTERACTION_ANNOTATIONS_TABLE. Existing rows become `human` / `accepted` / version 1 by default.
//
// `review_agent_present` is 1/0 on a judge row once reviewed (was an agent live when the person clicked?), NULL before.
// `created_via`: dashboard | dashboard_agent_present | webmcp | declarative | http-mcp.
// `principal_id` is the audit principal of the agent that proposed the row (a hash, never a credential).
// `judge_model` is whatever the agent declared and cannot be verified.

export const ANNOTATION_PROVENANCE_COLUMNS = `
ALTER TABLE interaction_annotations ADD COLUMN source TEXT NOT NULL DEFAULT 'human' CHECK(source IN ('human','judge'));
ALTER TABLE interaction_annotations ADD COLUMN status TEXT NOT NULL DEFAULT 'accepted'
  CHECK(status IN ('proposed','accepted','rejected','superseded'));
ALTER TABLE interaction_annotations ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE interaction_annotations ADD COLUMN supersedes_id INTEGER REFERENCES interaction_annotations(id);
ALTER TABLE interaction_annotations ADD COLUMN judge_model TEXT;
ALTER TABLE interaction_annotations ADD COLUMN rationale TEXT;
ALTER TABLE interaction_annotations ADD COLUMN criteria_json TEXT;
ALTER TABLE interaction_annotations ADD COLUMN rubric_version TEXT;
ALTER TABLE interaction_annotations ADD COLUMN created_via TEXT NOT NULL DEFAULT 'dashboard';
ALTER TABLE interaction_annotations ADD COLUMN principal_id TEXT;
ALTER TABLE interaction_annotations ADD COLUMN reviewed_by INTEGER;
ALTER TABLE interaction_annotations ADD COLUMN reviewed_at TEXT;
-- Set when a human accepted or rejected a judge row while an agent had live access (computed on the server).
ALTER TABLE interaction_annotations ADD COLUMN review_agent_present INTEGER;
`;

// ── Annotation integrity (migration v33) ────────────────────────────────────
// The triggers are ALLOW-LISTS: only `status`, `reviewed_by`, `reviewed_at` and `review_agent_present` can ever change
// on a row, and only along the listed transitions (the last three only together with a status change). An INSERT
// guard covers the other side: a judge row can only be born `proposed` and unreviewed, a human row only `accepted`
// and via the dashboard. SQLite cannot iterate columns inside a trigger, so trigger 1 names them all;
// annotations-versioning.test.ts reads PRAGMA table_info and fails if a column is missing from it, so a future
// column added without updating the trigger breaks the build.
//
// Legacy data first: the old delete-and-replace route should have left at most one row per interaction. Be
// defensive and keep only the newest as the current human row.

export const ANNOTATION_INTEGRITY = `
UPDATE interaction_annotations SET status = 'superseded'
 WHERE source = 'human' AND id NOT IN (SELECT MAX(id) FROM interaction_annotations GROUP BY interaction_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_annotations_one_current_human
  ON interaction_annotations(interaction_id) WHERE source = 'human' AND status = 'accepted';
CREATE INDEX IF NOT EXISTS idx_annotations_status ON interaction_annotations(source, status);

CREATE TRIGGER IF NOT EXISTS trg_annotations_immutable_columns
BEFORE UPDATE ON interaction_annotations
WHEN NEW.id IS NOT OLD.id OR NEW.interaction_id IS NOT OLD.interaction_id
  OR NEW.rating IS NOT OLD.rating OR NEW.preference IS NOT OLD.preference OR NEW.pair_id IS NOT OLD.pair_id
  OR NEW.tags IS NOT OLD.tags OR NEW.notes IS NOT OLD.notes OR NEW.annotated_at IS NOT OLD.annotated_at
  OR NEW.source IS NOT OLD.source OR NEW.version IS NOT OLD.version OR NEW.supersedes_id IS NOT OLD.supersedes_id
  OR NEW.judge_model IS NOT OLD.judge_model OR NEW.rationale IS NOT OLD.rationale
  OR NEW.criteria_json IS NOT OLD.criteria_json OR NEW.rubric_version IS NOT OLD.rubric_version
  OR NEW.created_via IS NOT OLD.created_via OR NEW.principal_id IS NOT OLD.principal_id
BEGIN SELECT RAISE(ABORT, 'annotation rows are immutable except status/reviewed_by/reviewed_at; insert a new version'); END;

CREATE TRIGGER IF NOT EXISTS trg_annotations_status_transitions
BEFORE UPDATE ON interaction_annotations
WHEN (NEW.status IS NOT OLD.status AND NOT (
        (OLD.source = 'human' AND OLD.status = 'accepted' AND NEW.status = 'superseded')
     OR (OLD.source = 'judge' AND OLD.status = 'proposed' AND NEW.status IN ('accepted','rejected','superseded'))
     OR (OLD.source = 'judge' AND OLD.status = 'accepted' AND NEW.status = 'rejected'
         AND NEW.reviewed_at IS NOT OLD.reviewed_at)))
  OR (NEW.status IS OLD.status AND (NEW.reviewed_by IS NOT OLD.reviewed_by OR NEW.reviewed_at IS NOT OLD.reviewed_at
        OR NEW.review_agent_present IS NOT OLD.review_agent_present))
BEGIN SELECT RAISE(ABORT, 'annotation status transition not allowed'); END;

CREATE TRIGGER IF NOT EXISTS trg_annotations_insert_guard
BEFORE INSERT ON interaction_annotations
WHEN NEW.review_agent_present IS NOT NULL
  OR (NEW.source = 'judge' AND (NEW.status IS NOT 'proposed' OR NEW.reviewed_by IS NOT NULL OR NEW.reviewed_at IS NOT NULL))
  OR (NEW.source = 'human' AND (NEW.status IS NOT 'accepted' OR NEW.created_via NOT IN ('dashboard','dashboard_agent_present')))
BEGIN SELECT RAISE(ABORT, 'annotation insert not allowed: judge rows start proposed and unreviewed, human rows are accepted dashboard rows'); END;

CREATE TRIGGER IF NOT EXISTS trg_annotations_no_orphan_delete
BEFORE DELETE ON interaction_annotations
WHEN EXISTS (SELECT 1 FROM llm_interactions WHERE id = OLD.interaction_id)
BEGIN SELECT RAISE(ABORT, 'annotations are never deleted; supersede or reject instead'); END;

CREATE VIEW IF NOT EXISTS v_current_human_annotations AS
  SELECT * FROM interaction_annotations WHERE source = 'human' AND status = 'accepted';
CREATE VIEW IF NOT EXISTS v_accepted_judge_annotations AS
  SELECT * FROM interaction_annotations WHERE source = 'judge' AND status = 'accepted';
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
