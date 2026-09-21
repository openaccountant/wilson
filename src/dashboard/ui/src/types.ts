/** Shared API response types for the Wilson dashboard. */

export interface Transaction {
  id: number;
  date: string;
  description: string;
  merchant_name: string | null;
  amount: number;
  category: string | null;
  category_detailed: string | null;
  /** Model-assigned categorization confidence (0–1); null when the category came from the bank/import. */
  category_confidence: number | null;
  /** SQLite 0/1 flag: the user has personally verified the category. */
  user_verified: number;
  account_id: number | null;
  account_name: string | null;
  entity_id: number | null;
  pending: boolean;
}

// Mirrors AccountRow in src/db/net-worth-queries.ts — the GET /api/accounts wire format.
// Field names must match the API exactly; pinned by wire-contract tests in
// src/__tests__/dashboard-server.test.ts.
export type AccountType = 'asset' | 'liability';

export interface Account {
  id: number;
  name: string;
  account_type: AccountType;
  account_subtype: string;
  institution: string | null;
  account_number_last4: string | null;
  current_balance: number;
  currency: string;
  is_active: number;
  notes: string | null;
  plaid_account_id: string | null;
  // Added by the entities migration (ALTER TABLE accounts ADD COLUMN entity_id);
  // always present on the wire, declared optional because the server-side
  // AccountRow declaration predates the column.
  entity_id?: number | null;
  created_at: string;
  updated_at: string;
}

export interface PnlSummary {
  income: number;
  expenses: number;
  net: number;
}

export interface CategoryBreakdown {
  category: string;
  total: number;
  count: number;
  percent: number;
}

export interface BudgetItem {
  category: string;
  budget: number;
  spent: number;
  remaining: number;
  percent: number;
}

export interface Alert {
  type: 'critical' | 'warning' | 'info';
  message: string;
}

// Matches GET /api/daily-spending response
export interface DailySpendingRow {
  date: string;
  spending: number;
  count: number;
}

// Matches GET /api/streak response
export interface StreakData {
  current: number;
  longest: number;
  dailyBudget: number;
}

// Matches GET /api/weekly-summary response
export interface WeekCategorySpending {
  category: string;
  total: number;
}

export interface WeekData {
  total: number;
  byCategory: WeekCategorySpending[];
  topMerchant: string | null;
}

export interface WeeklySummaryData {
  thisWeek: WeekData;
  lastWeek: WeekData;
  change: { amount: number; percent: number };
}

// Matches GET /api/budget-countdown response
export interface BudgetCountdownItem {
  category: string;
  limit: number;
  spent: number;
  remaining: number;
  daysLeft: number;
  perDay: number;
}

// Matches GET /api/savings response (existing endpoint)
export interface SavingsPoint {
  month: string;
  income: number;
  expenses: number;
  savings: number;
  savingsRate: number;
}

// Matches GET /api/summary response (existing endpoint)
export interface SpendingSummaryItem {
  category: string;
  total: number;
  count: number;
}

// Matches GET /api/pnl response (existing endpoint)
export interface PnlResponse {
  totalIncome: number;
  totalExpenses: number;
  netProfitLoss: number;
  incomeByCategory: { category: string; total: number }[];
  expensesByCategory: { category: string; total: number }[];
}

// Matches GET /api/budgets response (existing endpoint)
export interface BudgetVsActualRow {
  category: string;
  monthly_limit: number;
  actual: number;
  remaining: number;
  percent_used: number;
  over: boolean;
}

// Matches GET /api/alerts response (existing endpoint)
export interface AlertItem {
  severity: string;
  message: string;
  category?: string;
}

// Matches GET /api/net-worth response (NetWorthSummary in src/db/net-worth-queries.ts)
export interface NetWorthResponse {
  totalAssets: number;
  totalLiabilities: number;
  netWorth: number;
  assetsBySubtype: { subtype: string; total: number; count: number }[];
  liabilitiesBySubtype: { subtype: string; total: number; count: number }[];
  accounts: Account[];
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp?: string;
}

export interface ChatSession {
  id: string;
  title: string;
  createdAt: string;
  messages: ChatMessage[];
}

export interface ChatSessionRow {
  id: string;
  started_at: string;
  title: string | null;
}

export interface ChatHistoryRow {
  id: number;
  query: string;
  answer: string;
  summary: string | null;
  session_id: string;
  created_at: string;
}

export interface ChatResponse {
  answer: string;
  sessionId: string | null;
}

export interface LogRow {
  ts: string;
  level: string;
  msg: string;
  data?: unknown;
}

export interface TraceRow {
  id: string;
  model: string;
  provider: string;
  promptLength: number;
  responseLength: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  durationMs: number;
  status: string;
  error: string | null;
  timestamp: string;
}

export interface TraceStats {
  totalCalls: number;
  successfulCalls: number;
  errorCalls: number;
  totalTokens: number;
  totalDurationMs: number;
  avgDurationMs: number;
  byModel: Record<string, { calls: number; tokens: number; avgMs: number }>;
}

export interface InteractionRow {
  id: number;
  run_id: string;
  sequence_num: number;
  call_type: string;
  model: string;
  provider: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  duration_ms: number;
  status: string;
  created_at: string;
  rating: number | null;
  preference: string | null;
}

export interface AnnotationStats {
  total: number;
  annotated: number;
  ratingCounts: { rating: number; count: number }[];
  dpoPairs: number;
  sftReady: number;
}

// Matches GET /api/net-worth/trend response (NetWorthTrendPoint in src/db/net-worth-queries.ts)
export interface NetWorthTrendPoint {
  date: string;
  totalAssets: number;
  totalLiabilities: number;
  netWorth: number;
}

export interface DateRange {
  startDate: string;
  endDate: string;
}

export interface Entity {
  id: number;
  name: string;
  slug: string;
  description: string | null;
  color: string;
  is_default: number;
}

export interface Goal {
  id: number;
  title: string;
  goal_type: 'financial' | 'behavioral';
  target_amount: number | null;
  target_percent: number | null;
  income_period: string | null;
  current_amount: number;
  target_date: string | null;
  category: string | null;
  account_id: number | null;
  status: 'active' | 'completed' | 'paused' | 'abandoned';
  notes: string | null;
  created_at: string;
  updated_at: string;
  effective_target?: number | null;
  period_income?: number | null;
}

export interface GoalSnapshot {
  id: number;
  goal_id: number;
  amount: number;
  resolved_target?: number | null;
  snapshot_date: string;
  created_at: string;
}

export interface Memory {
  id: number;
  memory_type: 'context' | 'insight' | 'advice';
  content: string;
  category: string | null;
  source_query: string | null;
  expires_at: string | null;
  is_active: number;
  created_at: string;
}

// Matches GET /api/models response (see src/model/task-models.ts)
export type TaskExecution = 'local' | 'server';

export interface ModelTaskRow {
  task: 'chat' | 'categorization' | 'entity-classification' | 'embeddings';
  label: string;
  inUse: boolean;
  model: string | null;
  modelName: string | null;
  provider: string | null;
  providerName: string | null;
  execution: TaskExecution | null;
  webgpu: boolean;
  assignment: 'default' | 'override';
  note: string | null;
}

// One catalog entry an admin can pin to a task (POST /api/models)
export interface CatalogModel {
  id: string;
  displayName: string;
  provider: string;
  providerName: string;
  isLocal: boolean;
  cached: boolean;
  downloadSize: string | null;
}

// Matches GET /api/models response (see src/model/task-models.ts)
export interface ModelsPanel {
  tasks: ModelTaskRow[];
  catalog: CatalogModel[];
}
