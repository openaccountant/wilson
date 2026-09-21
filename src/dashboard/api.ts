import type { Database } from '../db/compat-sqlite.js';
import { createHash } from 'crypto';
import {
  importStep,
  embeddingStep,
  predictStep,
  reconcileStep,
  type TraceDeps,
  type TraceStepId,
  type TraceStepResult,
  type TraceTransaction,
} from '../demo/statement-trace.js';
import {
  getSpendingSummary,
  getProfitLoss,
  getBudgetVsActual,
  getMonthlySavingsData,
  getMonthlyCashflowData,
  getTransactions,
  getRecentChatHistory,
  getChatSessions,
  getChatHistoryBySession,
  createChatSession,
  getChatSessionById,
  updateSessionTitle,
  insertChatMessage,
  updateTransaction,
  deleteTransaction,
  insertTransactions,
  checkImported,
  checkExternalId,
  recordImport,
  type TransactionFilters,
  type TransactionUpdate,
  type TransactionInsert,
} from '../db/queries.js';
import {
  getAccounts,
  getNetWorthSummary,
  getNetWorthTrend,
  getAccountTransactionSummary,
  linkTransactionsToAccount,
} from '../db/net-worth-queries.js';
import {
  getEntities,
  getEntityById,
  createEntity,
  updateEntity,
  deleteEntity,
  type EntityInsert,
} from '../db/entity-queries.js';
import {
  getDailySpending,
  getStreak,
  getWeeklySummary,
  getBudgetCountdown,
} from '../db/daily-queries.js';
import { checkAlerts } from '../alerts/engine.js';
import { getActiveGoals, getGoalSnapshots, resolveGoalTarget, type GoalRow, type GoalSnapshotRow } from '../db/goal-queries.js';
import { getActiveMemories, addMemory, deactivateMemory, type MemoryInsert } from '../db/memory-queries.js';
import {
  countMissingTransactionTargets,
  searchTransactionsSemantic,
  type SemanticTransactionFilters,
} from '../db/embedding-queries.js';
import { DEFAULT_EMBEDDING_MODEL, embedTexts } from '../utils/embeddings.js';
import { getLocalChatModelConfig } from '../model/local-chat.js';
import { getModelPanel, setTaskOverride, validateTaskModel, type OverridableTask } from '../model/task-models.js';
import { resolveProvider } from '../providers.js';
import { setSetting } from '../utils/config.js';
import { computeExternalId } from '../tools/import/external-id.js';
import { parseTransactionListParams } from './transactions-query.js';
import { logger } from '../utils/logger.js';
import { traceStore } from '../utils/trace-store.js';
import {
  getShowdownSamples,
  runShowdownCloudArm,
  runShowdownLocalServerArm,
  recordBrowserLocalTrace,
  type BrowserTraceBody,
} from '../demo/showdown.js';
import { getSampleBySlug } from '../demo/samples.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

function parseAccountId(params: URLSearchParams): number | undefined {
  const val = params.get('accountId');
  return val ? parseInt(val, 10) : undefined;
}

function parseEntityId(params: URLSearchParams): number | undefined {
  const val = params.get('entityId');
  return val ? parseInt(val, 10) : undefined;
}

function parseDateRange(params: URLSearchParams) {
  const directStart = params.get('startDate');
  const directEnd = params.get('endDate');
  if (directStart && directEnd) {
    const month = directStart.slice(0, 7);
    return { month, startDate: directStart, endDate: directEnd };
  }
  const month = params.get('month') ?? new Date().toISOString().slice(0, 7);
  const [year, mon] = month.split('-').map(Number);
  const startDate = `${month}-01`;
  const endDate = new Date(year, mon, 0).toISOString().slice(0, 10);
  return { month, startDate, endDate };
}

function escapeCsv(v: string): string {
  if (v.includes(',') || v.includes('"') || v.includes('\n')) {
    return '"' + v.replace(/"/g, '""') + '"';
  }
  return v;
}

// ── Overview APIs ───────────────────────────────────────────────────────────

export function apiSummary(db: Database, params: URLSearchParams) {
  const { startDate, endDate } = parseDateRange(params);
  const accountId = parseAccountId(params);
  const entityId = parseEntityId(params);
  return getSpendingSummary(db, startDate, endDate, accountId, entityId);
}

export function apiPnl(db: Database, params: URLSearchParams) {
  const { startDate, endDate } = parseDateRange(params);
  const accountId = parseAccountId(params);
  const entityId = parseEntityId(params);
  return getProfitLoss(db, startDate, endDate, accountId, entityId);
}

export function apiBudgets(db: Database, params: URLSearchParams) {
  const { month } = parseDateRange(params);
  const accountId = parseAccountId(params);
  const entityId = parseEntityId(params);
  return getBudgetVsActual(db, month, accountId, entityId);
}

export function apiSavings(db: Database, params: URLSearchParams) {
  const months = parseInt(params.get('months') ?? '6', 10);
  const accountId = parseAccountId(params);
  const entityId = parseEntityId(params);
  return getMonthlySavingsData(db, undefined, months, accountId, entityId);
}

// Read-only monthly income/expense series for the client-side cash forecast.
// Portfolio-level flows (no account/entity filters) to line up with the
// liquid-cash starting balance the card computes from all accounts.
export function apiCashflowMonthly(db: Database, params: URLSearchParams) {
  const months = Math.min(120, Math.max(1, parseInt(params.get('months') ?? '24', 10) || 24));
  return getMonthlyCashflowData(db, undefined, months);
}

export function apiAlerts(db: Database) {
  return checkAlerts(db);
}

// ── Transactions ────────────────────────────────────────────────────────────

export function apiTransactions(db: Database, params: URLSearchParams) {
  const { filters, limit } = parseTransactionListParams(params);
  const txns = getTransactions(db, filters);
  return txns.slice(0, limit);
}

export function apiUpdateTransaction(db: Database, id: number, updates: TransactionUpdate) {
  const success = updateTransaction(db, id, updates);
  return { success, id };
}

// ── Semantic search ─────────────────────────────────────────────────────────

/** Injectable embed seam: same shape as embedTexts (tests pass a fake; production uses the local engine). */
export type EmbedFn = (texts: string[]) => Promise<Float32Array[]>;

export interface SemanticSearchResponse {
  /** Full transaction rows (same shape as /api/transactions) with the similarity score merged on, ranked by dot product. */
  results: Array<Record<string, unknown> & { score: number }>;
  /** Transactions that have an embedding for the model (total minus missing — never the raw embeddings count, which can include orphans). */
  indexed: number;
  /** Total transaction count. */
  total: number;
  model: string;
}

/**
 * GET /api/transactions/search?q=…&start&end&category&accountId&entityId&limit
 *
 * Embeds the query text with the local embedding engine (in-process — query
 * text never leaves the machine), prefilters candidates with the same SQL
 * filters the transactions endpoint accepts, ranks by dot product over the
 * L2-normalized vectors (i.e. cosine similarity), and returns full transaction
 * rows + score. Document vectors are never computed here — they were indexed
 * ahead of time by `wilson --index`.
 *
 * `embed` is the test seam: inject a fake embedder so no test ever loads the
 * real ONNX pipeline. The server route passes nothing and gets the local engine.
 */
export async function apiSemanticSearch(
  db: Database,
  params: URLSearchParams,
  embed?: EmbedFn
): Promise<SemanticSearchResponse> {
  const total = (db.prepare('SELECT COUNT(*) AS c FROM transactions').get() as { c: number }).c;
  const missing = countMissingTransactionTargets(db, DEFAULT_EMBEDDING_MODEL);
  const indexed = Math.max(0, total - missing);
  const model = DEFAULT_EMBEDDING_MODEL;

  const q = (params.get('q') ?? '').trim();
  if (!q) {
    return { results: [], indexed, total, model };
  }

  const parsedLimit = parseInt(params.get('limit') ?? '25', 10);
  const limit = Number.isFinite(parsedLimit) && parsedLimit >= 1 ? parsedLimit : 25;

  // Same filter set (and param names) as apiTransactions.
  const filters: SemanticTransactionFilters = {};
  const start = params.get('start');
  const end = params.get('end');
  const category = params.get('category');
  const accountId = parseAccountId(params);
  const entityId = parseEntityId(params);
  if (start) filters.dateStart = start;
  if (end) filters.dateEnd = end;
  if (category) filters.category = category;
  if (accountId !== undefined) filters.accountId = accountId;
  if (entityId !== undefined) filters.entityId = entityId;

  // Exactly one embed call, one text: the query. (Transaction text is embedded
  // only by `wilson --index`, never here.)
  const embedFn = embed ?? embedTexts;
  const [queryVec] = await embedFn([q]);

  const hits = searchTransactionsSemantic(db, queryVec, filters, limit, model);

  // Enrich the narrow DB-layer projection into full transaction rows, one
  // query, in ranked order. The compat-sqlite wrapper only accepts named
  // params, so build @id0, @id1, … dynamically.
  const results: Array<Record<string, unknown> & { score: number }> = [];
  if (hits.length > 0) {
    const placeholders = hits.map((_, i) => `@id${i}`).join(',');
    const sqlParams: Record<string, unknown> = {};
    hits.forEach((h, i) => { sqlParams[`id${i}`] = h.sourceId; });
    const rows = db
      .prepare(`SELECT * FROM transactions WHERE id IN (${placeholders})`)
      .all(sqlParams) as Array<Record<string, unknown>>;
    const byId = new Map<number, Record<string, unknown>>();
    for (const row of rows) byId.set(row.id as number, row);
    for (const h of hits) {
      const row = byId.get(h.sourceId);
      // Skip defensively: a transaction deleted mid-flight between search and
      // enrichment has no row to return.
      if (row) results.push({ ...row, score: h.score });
    }
  }

  return { results, indexed, total, model };
}

export function apiDeleteTransaction(db: Database, id: number) {
  const success = deleteTransaction(db, id);
  return { success, id };
}

// ── Export ───────────────────────────────────────────────────────────────────

export function apiExportCsv(db: Database, params: URLSearchParams): string {
  const filters: TransactionFilters = {};
  const start = params.get('start');
  const end = params.get('end');
  const category = params.get('category');
  const accountId = parseAccountId(params);
  const entityId = parseEntityId(params);
  if (start) filters.dateStart = start;
  if (end) filters.dateEnd = end;
  if (category) filters.category = category;
  if (accountId !== undefined) filters.accountId = accountId;
  if (entityId !== undefined) filters.entityId = entityId;
  const txns = getTransactions(db, filters);

  const header = 'Date,Description,Amount,Category';
  const rows = txns.map((t) =>
    [t.date, escapeCsv(t.description), String(t.amount), escapeCsv(t.category ?? '')].join(',')
  );
  return [header, ...rows].join('\n');
}

export function apiExportXlsx(db: Database, params: URLSearchParams): Buffer {
  // Dynamic import since xlsx is optional
  const XLSX = require('xlsx');
  const filters: TransactionFilters = {};
  const start = params.get('start');
  const end = params.get('end');
  const category = params.get('category');
  const accountId = parseAccountId(params);
  const entityId = parseEntityId(params);
  if (start) filters.dateStart = start;
  if (end) filters.dateEnd = end;
  if (category) filters.category = category;
  if (accountId !== undefined) filters.accountId = accountId;
  if (entityId !== undefined) filters.entityId = entityId;
  const txns = getTransactions(db, filters);

  const data = txns.map((t) => ({
    Date: t.date,
    Description: t.description,
    Amount: t.amount,
    Category: t.category ?? '',
    Bank: t.bank ?? '',
    'Account Last4': t.account_last4 ?? '',
  }));

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(data);
  XLSX.utils.book_append_sheet(wb, ws, 'Transactions');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

export function apiExportPnlCsv(db: Database, params: URLSearchParams): string {
  const { startDate, endDate } = parseDateRange(params);
  const accountId = parseAccountId(params);
  const entityId = parseEntityId(params);
  const pnl = getProfitLoss(db, startDate, endDate, accountId, entityId);

  const lines = ['Type,Category,Amount,Count'];
  for (const r of pnl.incomeByCategory) {
    lines.push(['Income', escapeCsv(r.category), String(r.total), String(r.count)].join(','));
  }
  for (const r of pnl.expensesByCategory) {
    lines.push(['Expense', escapeCsv(r.category), String(r.total), String(r.count)].join(','));
  }
  lines.push(['','Total Income', String(pnl.totalIncome), ''].join(','));
  lines.push(['','Total Expenses', String(pnl.totalExpenses), ''].join(','));
  lines.push(['','Net P&L', String(pnl.netProfitLoss), ''].join(','));
  return lines.join('\n');
}

export function apiExportNetWorthCsv(db: Database): string {
  const nw = getNetWorthSummary(db);
  const lines = ['Name,Type,Subtype,Institution,Balance'];
  for (const a of nw.accounts) {
    lines.push([
      escapeCsv(a.name),
      a.account_type,
      a.account_subtype,
      escapeCsv(a.institution ?? ''),
      String(a.current_balance),
    ].join(','));
  }
  lines.push(['','','','Total Assets', String(nw.totalAssets)].join(','));
  lines.push(['','','','Total Liabilities', String(nw.totalLiabilities)].join(','));
  lines.push(['','','','Net Worth', String(nw.netWorth)].join(','));
  return lines.join('\n');
}

// ── Spending by Institution ──────────────────────────────────────────────────

export function apiSpendingByInstitution(db: Database, params: URLSearchParams) {
  const { startDate, endDate } = parseDateRange(params);
  const accountId = parseAccountId(params);
  const category = params.get('category');
  const conditions = ['date >= @startDate', 'date <= @endDate', 'amount < 0'];
  const sqlParams: Record<string, unknown> = { startDate, endDate };
  if (accountId !== undefined) {
    conditions.push('account_id = @accountId');
    sqlParams.accountId = accountId;
  }
  if (category) {
    conditions.push('category = @category');
    sqlParams.category = category;
  }
  const rows = db.prepare(`
    SELECT
      COALESCE(bank, 'Unknown') AS institution,
      SUM(amount) AS total,
      COUNT(*) AS count
    FROM transactions
    WHERE ${conditions.join(' AND ')}
    GROUP BY bank
    ORDER BY total ASC
  `).all(sqlParams) as { institution: string; total: number; count: number }[];
  return rows;
}

// ── Goals ────────────────────────────────────────────────────────────────────

export function apiGoals(db: Database) {
  try {
    return getActiveGoals(db).map((g: GoalRow) => {
      if (g.target_percent != null) {
        const resolved = resolveGoalTarget(db, g);
        return {
          ...g,
          effective_target: resolved?.target ?? null,
          period_income: resolved?.income ?? null,
        };
      }
      return { ...g, effective_target: null, period_income: null };
    });
  } catch {
    return [];
  }
}

export function apiGoalSnapshots(db: Database, goalId: number, params: URLSearchParams) {
  try {
    const months = parseInt(params.get('months') ?? '12', 10);
    return getGoalSnapshots(db, goalId, months);
  } catch {
    return [];
  }
}

// ── Accounts / Net Worth ────────────────────────────────────────────────────

export function apiAccounts(db: Database) {
  return getAccounts(db, { active: true });
}

export function apiNetWorth(db: Database) {
  return getNetWorthSummary(db);
}

export function apiNetWorthTrend(db: Database, params: URLSearchParams) {
  const months = parseInt(params.get('months') ?? '12', 10);
  return getNetWorthTrend(db, months);
}

export function apiAccountTransactions(db: Database, accountId: number, params: URLSearchParams) {
  const filters: TransactionFilters = { accountId };
  const start = params.get('start');
  const end = params.get('end');
  if (start) filters.dateStart = start;
  if (end) filters.dateEnd = end;
  const txns = getTransactions(db, filters);
  const limit = parseInt(params.get('limit') ?? '100', 10);
  return txns.slice(0, limit);
}

// ── Logs ────────────────────────────────────────────────────────────────────

export function apiLogs(db: Database, params: URLSearchParams) {
  const limit = parseInt(params.get('limit') ?? '100', 10);
  const levelFilter = params.get('level');

  try {
    let sql = 'SELECT level, message AS msg, data, created_at AS ts FROM logs';
    const conditions: string[] = [];
    const sqlParams: Record<string, unknown> = {};
    if (levelFilter) {
      conditions.push('level = @level');
      sqlParams.level = levelFilter;
    }
    if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
    sql += ' ORDER BY id DESC LIMIT @limit';
    sqlParams.limit = limit;
    const rows = db.prepare(sql).all(sqlParams) as { level: string; msg: string; data: string | null; ts: string }[];
    if (rows.length > 0) {
      return rows.reverse().map((r) => ({
        ...r,
        data: r.data ? JSON.parse(r.data) : undefined,
      }));
    }
  } catch { /* fall through to in-memory */ }

  let entries = logger.getRecentLogs().map((e) => ({
    ts: e.timestamp.toISOString(),
    level: e.level,
    msg: e.message,
    ...(e.data !== undefined ? { data: e.data } : {}),
  }));
  if (levelFilter) {
    entries = entries.filter((e) => e.level === levelFilter);
  }
  return entries.slice(-limit);
}

// ── Chat ────────────────────────────────────────────────────────────────────

export function apiChatHistory(db: Database) {
  try {
    const rows = getRecentChatHistory(db, 50);
    return rows.reverse();
  } catch {
    return [];
  }
}

export function apiChatSessions(db: Database) {
  try {
    return getChatSessions(db, 50);
  } catch {
    return [];
  }
}

export function apiChatSessionHistory(db: Database, sessionId: string) {
  try {
    return getChatHistoryBySession(db, sessionId);
  } catch {
    return [];
  }
}

// ── Hybrid (local-first WebGPU) chat ────────────────────────────────────────

/**
 * Model choice + bundle bounds for the browser-side local chat path. Derived
 * entirely from the provider registry / model catalog (see src/model/local-chat.ts).
 */
export function apiLocalChatConfig() {
  return getLocalChatModelConfig();
}

// ── Models panel (Settings) ─────────────────────────────────────────────────

/**
 * Which model handles each AI task (with any admin pins applied live), plus
 * the model catalog an admin pins from. Read-only and config-derived (no db).
 * The webgpuOverride param exists so tests can pin the probe result without
 * loading onnxruntime-node; production passes nothing and the cached
 * server-side probe runs on first hit.
 */
export async function apiModels(webgpuOverride?: boolean) {
  return getModelPanel(webgpuOverride);
}

// ── Task model overrides (POST /api/models) ─────────────────────────────────

export interface SetTaskModelBody {
  task?: string;
  /** Model id to pin; null (or undefined for tool tasks) resets to follow the chat model. */
  model?: string | null;
}

export type SetTaskModelResult =
  | { success: true; task: string; model: string | null }
  | { error: string };

/**
 * Persist a per-task model assignment. The chat task IS the global model
 * setting (same keys the TUI's /model switch writes: provider + modelId); the
 * tool tasks get their own override keys (see task-models.ts). This is the
 * route's whole job — applying the chat change live happens in chat.ts's
 * per-message refreshChatModel(), not here.
 */
export function apiSetTaskModel(body: SetTaskModelBody): SetTaskModelResult {
  const task = typeof body?.task === 'string' ? body.task : '';

  if (task === 'chat') {
    if (body.model === null || body.model === undefined) {
      return { error: "The chat task's model is the global model setting — pick a model to set it (there is no reset)" };
    }
    if (!validateTaskModel(body.model)) {
      return { error: `Unknown model: ${String(body.model)}` };
    }
    const provider = resolveProvider(body.model).id;
    if (!setSetting('provider', provider) || !setSetting('modelId', body.model)) {
      return { error: 'Failed to save settings' };
    }
    return { success: true, task, model: body.model };
  }

  if (task === 'categorization' || task === 'entity-classification') {
    const pinned: string | null = body.model ?? null;
    if (pinned !== null && !validateTaskModel(pinned)) {
      return { error: `Unknown model: ${String(pinned)}` };
    }
    if (!setTaskOverride(task as OverridableTask, pinned)) {
      return { error: 'Failed to save settings' };
    }
    return { success: true, task, model: pinned };
  }

  return { error: `Unknown task: ${task || '(missing)'}` };
}

export interface LocalChatRecordBody {
  query?: string;
  answer?: string;
  sessionId?: string;
}

/**
 * Record a locally-answered exchange in the same chat history the server path
 * writes, so locally-answered turns survive a reload (Wilson records
 * everything). Reuses the existing session/history shapes — no new schema.
 * `summary` stays null: the LLM-summary pass is a server-agent behavior.
 *
 * OPERATOR VETO CANDIDATE: this is the only new write path added for hybrid
 * chat (browser-originated history append, same auth posture as POST /api/chat).
 */
export function apiRecordLocalChatMessage(
  db: Database,
  body: LocalChatRecordBody,
): { success: true; sessionId: string } | { error: string } {
  const query = typeof body?.query === 'string' ? body.query.trim() : '';
  const answer = typeof body?.answer === 'string' ? body.answer.trim() : '';
  if (!query || !answer) {
    return { error: 'query and answer are required' };
  }

  const supplied = typeof body?.sessionId === 'string' && body.sessionId ? body.sessionId : null;
  const existing = supplied ? getChatSessionById(db, supplied) : null;
  const sessionId = existing ? existing.id : createChatSession(db);
  if (!existing) {
    updateSessionTitle(db, sessionId, query.slice(0, 100));
  }
  insertChatMessage(db, query, answer, null, sessionId);
  logger.info(`Dashboard local chat recorded`, { sessionId, queryChars: query.length });
  return { success: true, sessionId };
}

// ── Demo: Speed Showdown (issue #92) ────────────────────────────────────────

/** GET /api/demo/showdown/samples — fixtures + prompts + model config. */
export function apiDemoShowdownSamples() {
  return getShowdownSamples();
}

export interface ShowdownSlugBody {
  slug?: unknown;
}

function requireDemoSlug(body: ShowdownSlugBody): string {
  const slug = typeof body?.slug === 'string' ? body.slug.trim() : '';
  if (!slug) {
    throw new Error('slug is required');
  }
  // Throws on unknown slug → the route answers 400. This is the structural
  // synthetic-only guard: only in-repo fixture slugs reach the arms.
  getSampleBySlug(slug);
  return slug;
}

/**
 * POST /api/demo/showdown/cloud — cloud arm for one sample.
 * Bad input (missing/unknown slug) throws → 400; arm-internal failures
 * resolve to { ok:false, error } at HTTP 200 so the UI degrades inline.
 */
export async function apiDemoShowdownCloud(body: ShowdownSlugBody) {
  const slug = requireDemoSlug(body);
  return runShowdownCloudArm(slug);
}

/** POST /api/demo/showdown/local — server-side local arm. Same posture. */
export async function apiDemoShowdownLocal(body: ShowdownSlugBody) {
  const slug = requireDemoSlug(body);
  return runShowdownLocalServerArm(slug);
}

/** POST /api/demo/showdown/browser-trace — record the browser arm's measured time. */
export function apiDemoShowdownBrowserTrace(body: BrowserTraceBody) {
  return recordBrowserLocalTrace(body);
}

// ── Traces ──────────────────────────────────────────────────────────────────

export function apiTraces(db: Database, params: URLSearchParams) {
  const limit = parseInt(params.get('limit') ?? '100', 10);
  try {
    const rows = db.prepare(`
      SELECT trace_id AS id, model, provider, prompt_length AS promptLength,
        response_length AS responseLength, input_tokens AS inputTokens,
        output_tokens AS outputTokens, total_tokens AS totalTokens,
        duration_ms AS durationMs, status, error, created_at AS timestamp
      FROM llm_traces ORDER BY id DESC LIMIT @limit
    `).all({ limit });
    if (rows.length > 0) return rows.reverse();
  } catch { /* fall through */ }
  return traceStore.getRecentTraces(limit);
}

export function apiTraceStats(db: Database) {
  try {
    const row = db.prepare(`
      SELECT
        COUNT(*) AS totalCalls,
        SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) AS successfulCalls,
        SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errorCalls,
        COALESCE(SUM(CASE WHEN status = 'ok' THEN total_tokens ELSE 0 END), 0) AS totalTokens,
        COALESCE(SUM(CASE WHEN status = 'ok' THEN duration_ms ELSE 0 END), 0) AS totalDurationMs,
        CASE WHEN SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) > 0
          THEN CAST(SUM(CASE WHEN status = 'ok' THEN duration_ms ELSE 0 END) AS REAL) /
               SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END)
          ELSE 0 END AS avgDurationMs
      FROM llm_traces
    `).get() as Record<string, number> | undefined;
    if (row && row.totalCalls > 0) {
      const modelRows = db.prepare(`
        SELECT model, COUNT(*) AS calls,
          SUM(total_tokens) AS tokens,
          CAST(SUM(duration_ms) AS REAL) / COUNT(*) AS avgMs
        FROM llm_traces WHERE status = 'ok' GROUP BY model
      `).all() as { model: string; calls: number; tokens: number; avgMs: number }[];
      const byModel: Record<string, { calls: number; tokens: number; avgMs: number }> = {};
      for (const m of modelRows) {
        byModel[m.model] = { calls: m.calls, tokens: m.tokens, avgMs: Math.round(m.avgMs) };
      }
      return {
        totalCalls: row.totalCalls,
        successfulCalls: row.successfulCalls,
        errorCalls: row.errorCalls,
        totalTokens: row.totalTokens,
        totalDurationMs: row.totalDurationMs,
        avgDurationMs: Math.round(row.avgDurationMs),
        byModel,
      };
    }
  } catch { /* fall through */ }
  return traceStore.getStats();
}

// ── Interactions (Training Data) ─────────────────────────────────────────────

export function apiInteractions(db: Database, params: URLSearchParams) {
  const limit = parseInt(params.get('limit') ?? '100', 10);
  const offset = parseInt(params.get('offset') ?? '0', 10);
  const callType = params.get('callType');
  const model = params.get('model');
  const rating = params.get('rating');
  const annotated = params.get('annotated');

  let sql = `
    SELECT i.id, i.run_id, i.sequence_num, i.call_type, i.model, i.provider,
      i.input_tokens, i.output_tokens, i.total_tokens, i.duration_ms,
      i.status, i.created_at,
      a.rating, a.preference
    FROM llm_interactions i
    LEFT JOIN interaction_annotations a ON a.interaction_id = i.id
  `;
  const conditions: string[] = [];
  const sqlParams: Record<string, unknown> = {};

  if (callType) { conditions.push('i.call_type = @callType'); sqlParams.callType = callType; }
  if (model) { conditions.push('i.model = @model'); sqlParams.model = model; }
  if (rating) { conditions.push('a.rating = @rating'); sqlParams.rating = parseInt(rating, 10); }
  if (annotated === 'true') { conditions.push('a.id IS NOT NULL'); }
  if (annotated === 'false') { conditions.push('a.id IS NULL'); }

  if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
  sql += ' ORDER BY i.id DESC LIMIT @limit OFFSET @offset';
  sqlParams.limit = limit;
  sqlParams.offset = offset;

  try {
    return db.prepare(sql).all(sqlParams);
  } catch {
    return [];
  }
}

export function apiInteractionDetail(db: Database, id: number) {
  try {
    const interaction = db.prepare(`
      SELECT * FROM llm_interactions WHERE id = @id
    `).get({ id }) as Record<string, unknown> | undefined;
    if (!interaction) return null;

    const toolResults = db.prepare(`
      SELECT * FROM llm_tool_results WHERE interaction_id = @id ORDER BY id
    `).all({ id });

    const annotations = db.prepare(`
      SELECT * FROM interaction_annotations WHERE interaction_id = @id ORDER BY id DESC LIMIT 1
    `).all({ id });

    return { ...interaction, toolResults, annotations };
  } catch {
    return null;
  }
}

export function apiRunInteractions(db: Database, runId: string) {
  try {
    return db.prepare(`
      SELECT i.*, a.rating, a.preference, a.pair_id
      FROM llm_interactions i
      LEFT JOIN interaction_annotations a ON a.interaction_id = i.id
      WHERE i.run_id = @runId
      ORDER BY i.sequence_num
    `).all({ runId });
  } catch {
    return [];
  }
}

export function apiAnnotateInteraction(db: Database, id: number, annotation: {
  rating?: number;
  preference?: 'chosen' | 'rejected' | 'neutral';
  pairId?: string;
  tags?: string[];
  notes?: string;
}) {
  try {
    // Upsert: delete existing annotation for this interaction, then insert
    db.prepare('DELETE FROM interaction_annotations WHERE interaction_id = @id').run({ id });
    db.prepare(`
      INSERT INTO interaction_annotations (interaction_id, rating, preference, pair_id, tags, notes)
      VALUES (@interaction_id, @rating, @preference, @pair_id, @tags, @notes)
    `).run({
      interaction_id: id,
      rating: annotation.rating ?? null,
      preference: annotation.preference ?? null,
      pair_id: annotation.pairId ?? null,
      tags: annotation.tags ? JSON.stringify(annotation.tags) : null,
      notes: annotation.notes ?? null,
    });
    return { success: true, id };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Daily / Gamification ─────────────────────────────────────────────────────

export function apiDailySpending(db: Database, params: URLSearchParams) {
  const startDate = params.get('startDate');
  const endDate = params.get('endDate');
  if (!startDate || !endDate) {
    return { error: 'startDate and endDate required' };
  }
  return getDailySpending(db, startDate, endDate);
}

export function apiStreak(db: Database) {
  return getStreak(db);
}

export function apiWeeklySummary(db: Database) {
  return getWeeklySummary(db);
}

export function apiBudgetCountdown(db: Database, params: URLSearchParams) {
  const month = params.get('month') ?? new Date().toISOString().slice(0, 7);
  return getBudgetCountdown(db, month);
}

// ── Memories ─────────────────────────────────────────────────────────────────

export function apiMemories(db: Database) {
  try {
    return getActiveMemories(db);
  } catch {
    return [];
  }
}

export function apiAddMemory(db: Database, body: { memoryType?: string; content?: string; category?: string }) {
  if (!body.memoryType || !body.content) {
    throw new Error('memoryType and content required');
  }
  const insert: MemoryInsert = {
    memoryType: body.memoryType as MemoryInsert['memoryType'],
    content: body.content,
    category: body.category,
  };
  const id = addMemory(db, insert);
  return { success: true, id };
}

export function apiDeactivateMemory(db: Database, id: number) {
  const success = deactivateMemory(db, id);
  return { success, id };
}

// ── Settings (Custom Prompt) ─────────────────────────────────────────────────

export function apiGetCustomPrompt(db: Database) {
  try {
    const row = db.prepare(
      `SELECT value FROM dashboard_config WHERE key = 'custom_prompt'`
    ).get() as { value: string } | undefined;
    return { prompt: row?.value ?? '' };
  } catch {
    return { prompt: '' };
  }
}

export function apiSetCustomPrompt(db: Database, body: { prompt?: string }) {
  const prompt = body.prompt ?? '';
  db.prepare(`
    INSERT INTO dashboard_config (key, value) VALUES ('custom_prompt', @prompt)
    ON CONFLICT(key) DO UPDATE SET value = @prompt
  `).run({ prompt });
  return { success: true };
}

// ── Entities ─────────────────────────────────────────────────────────────────

export function apiEntities(db: Database) {
  try {
    return getEntities(db);
  } catch {
    return [];
  }
}

export function apiCreateEntity(db: Database, body: { name?: string; description?: string; color?: string }) {
  if (!body.name) throw new Error('name is required');
  const id = createEntity(db, body as EntityInsert);
  return { success: true, id };
}

export function apiUpdateEntity(db: Database, id: number, body: { name?: string; description?: string; color?: string }) {
  const success = updateEntity(db, id, body);
  return { success, id };
}

export function apiDeleteEntity(db: Database, id: number) {
  const result = deleteEntity(db, id);
  return result.ok ? { success: true, id } : { success: false, error: result.error };
}

export function apiAnnotationStats(db: Database) {
  try {
    const total = (db.prepare('SELECT COUNT(*) AS c FROM llm_interactions').get() as { c: number })?.c ?? 0;
    const annotated = (db.prepare('SELECT COUNT(DISTINCT interaction_id) AS c FROM interaction_annotations').get() as { c: number })?.c ?? 0;
    const ratingCounts = db.prepare(`
      SELECT rating, COUNT(*) AS count FROM interaction_annotations
      WHERE rating IS NOT NULL GROUP BY rating ORDER BY rating
    `).all() as { rating: number; count: number }[];
    const dpoPairs = (db.prepare(`
      SELECT COUNT(DISTINCT pair_id) AS c FROM interaction_annotations WHERE pair_id IS NOT NULL
    `).get() as { c: number })?.c ?? 0;
    const sftReady = (db.prepare(`
      SELECT COUNT(*) AS c FROM interaction_annotations WHERE rating >= 4
    `).get() as { c: number })?.c ?? 0;

    return { total, annotated, ratingCounts, dpoPairs, sftReady };
  } catch {
    return { total: 0, annotated: 0, ratingCounts: [], dpoPairs: 0, sftReady: 0 };
  }
}

// ── Import ──────────────────────────────────────────────────────────────────

export interface ImportTransactionInput {
  date: string;
  description: string;
  amount: number;
  external_id?: string;
  bank?: string;
  merchant_name?: string;
  category?: string;
  category_detailed?: string;
  payment_channel?: string;
  pending?: boolean;
  authorized_date?: string;
  account_last4?: string;
}

export interface ImportRequestBody {
  filename?: string;
  bank?: string;
  fileHash?: string;
  transactions?: ImportTransactionInput[];
}

export interface ImportResult {
  status: 'imported' | 'skipped' | 'failed';
  transactionsImported: number;
  transactionsSkipped: number;
  transactionsLinked?: number;
  dateRange?: { start: string; end: string };
  previouslyImported?: { filePath: string; importedAt: string; transactionCount: number | null };
  message: string;
  error?: string;
}

function failedImport(error: string): ImportResult {
  return { status: 'failed', transactionsImported: 0, transactionsSkipped: 0, error, message: error };
}

/**
 * Commit client-parsed statement rows to the active profile's database.
 * Mirrors the commit steps of the CLI import pipeline (importSingleFile in
 * tools/import/csv-import.ts): file-hash dedup, per-row external_id (client-supplied
 * or derived identically to the CLI), row dedup, bulk insert, imports-ledger record,
 * and optional account auto-link. The server trusts the parsed rows — it never
 * re-parses raw file content.
 */
export function apiImport(db: Database, body: ImportRequestBody): ImportResult {
  // 1. Validate the payload
  if (!body.filename || typeof body.filename !== 'string' || body.filename.trim() === '') {
    return failedImport('filename is required');
  }
  if (!body.transactions) {
    return failedImport('transactions is required');
  }
  if (!Array.isArray(body.transactions)) {
    return failedImport('transactions must be an array');
  }
  if (body.transactions.length === 0) {
    return failedImport('transactions must not be empty');
  }
  for (let i = 0; i < body.transactions.length; i++) {
    const t = body.transactions[i] as unknown;
    if (typeof t !== 'object' || t === null) {
      return failedImport(`transactions[${i}] must include date, description, and amount`);
    }
    const row = t as Partial<ImportTransactionInput>;
    if (!row.date || typeof row.date !== 'string' || row.date.trim() === ''
      || !row.description || typeof row.description !== 'string' || row.description.trim() === ''
      || typeof row.amount !== 'number' || !Number.isFinite(row.amount)) {
      return failedImport(`transactions[${i + 1}] must include date, description, and amount`);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(row.date)) {
      return failedImport(`transactions[${i + 1}].date must be YYYY-MM-DD`);
    }
    if (row.external_id !== undefined && (typeof row.external_id !== 'string' || row.external_id === '')) {
      return failedImport(`transactions[${i + 1}].external_id must be a string`);
    }
  }

  // 2. File-level dedup. When the client omits fileHash, hash the canonical JSON of
  //    the transactions array — best-effort (key order from the sender can differ
  //    between runs); row-level dedup via external_id is the real guarantee.
  const fileHash = body.fileHash?.trim()
    ?? createHash('sha256').update(JSON.stringify(body.transactions)).digest('hex');
  const existing = checkImported(db, fileHash);
  if (existing) {
    return {
      status: 'skipped',
      transactionsImported: 0,
      transactionsSkipped: existing.transaction_count ?? 0,
      previouslyImported: {
        filePath: existing.file_path,
        importedAt: existing.imported_at,
        transactionCount: existing.transaction_count,
      },
      message: `This file was already imported on ${existing.imported_at} (${existing.transaction_count} transactions).`,
    };
  }

  // 3+4. Per-row external_id + row-level dedup (mirrors CLI steps 5–6)
  const newRows: ImportTransactionInput[] = [];
  let skipped = 0;
  for (const t of body.transactions) {
    const extId = t.external_id ?? computeExternalId({ date: t.date, description: t.description, amount: t.amount });
    if (checkExternalId(db, extId)) {
      skipped++;
    } else {
      newRows.push(t);
    }
  }
  if (newRows.length === 0) {
    return {
      status: 'skipped',
      transactionsImported: 0,
      transactionsSkipped: skipped,
      message: `All ${body.transactions.length} transactions already exist (skipped as duplicates).`,
    };
  }

  // 5. Bulk insert (mirrors toInsert in csv-import.ts)
  const txns: TransactionInsert[] = newRows.map((t) => ({
    date: t.date,
    description: t.description,
    amount: t.amount,
    bank: t.bank ?? body.bank,
    source_file: body.filename,
    external_id: t.external_id ?? computeExternalId({ date: t.date, description: t.description, amount: t.amount }),
    merchant_name: t.merchant_name,
    category: t.category,
    category_detailed: t.category_detailed,
    payment_channel: t.payment_channel,
    pending: t.pending ? 1 : 0,
    authorized_date: t.authorized_date,
    account_last4: t.account_last4,
  }));
  const count = insertTransactions(db, txns);

  // Date range (mirrors CLI step 9: lexicographic sort works for YYYY-MM-DD)
  const dates = newRows.map((t) => t.date).sort();
  const dateRangeStart = dates[0];
  const dateRangeEnd = dates[dates.length - 1];

  // Ledger record (mirrors CLI step 10)
  const ledgerBanks = new Set(newRows.map((t) => t.bank).filter(Boolean)) as Set<string>;
  const ledgerBank = body.bank ?? (ledgerBanks.size === 1 ? [...ledgerBanks][0] : undefined);
  recordImport(db, {
    file_path: body.filename,
    file_hash: fileHash,
    bank: ledgerBank,
    transaction_count: count,
    date_range_start: dateRangeStart,
    date_range_end: dateRangeEnd,
  });

  // 6. Auto-link newly imported transactions to accounts by account_last4
  //    (mirrors the CLI pipeline)
  let autoLinked = 0;
  const last4Values = [...new Set(txns.map((t) => t.account_last4 ?? null).filter(Boolean))] as string[];
  for (const last4 of last4Values) {
    const account = db.prepare(
      'SELECT id FROM accounts WHERE account_number_last4 = @last4 AND is_active = 1'
    ).get({ last4 }) as { id: number } | undefined;
    if (account) {
      autoLinked += linkTransactionsToAccount(db, account.id, { accountLast4: last4 });
    }
  }

  // 7. Response (shape mirrors the CLI SingleFileResult)
  let message = `Imported ${count} transactions from ${body.filename} (${dateRangeStart} to ${dateRangeEnd}).`;
  if (skipped > 0) message += ` ${skipped} duplicates skipped.`;
  if (autoLinked > 0) message += ` ${autoLinked} transactions auto-linked to accounts.`;
  return {
    status: 'imported',
    transactionsImported: count,
    transactionsSkipped: skipped,
    transactionsLinked: autoLinked,
    dateRange: { start: dateRangeStart, end: dateRangeEnd },
    message,
  };
}

// ── Demo trace (statement-to-dashboard agent chain) ─────────────────────────

const MAX_TRACE_ROWS = 2000;

function traceError(step: TraceStepId, error: string): TraceStepResult {
  return {
    step,
    status: 'error',
    durationMs: 0,
    detail: { bank: '', format: '', rowCount: 0, imported: 0, skippedRows: 0, importedIds: [], message: '' },
    error,
  };
}

/**
 * One step of the Demo tab's statement agent chain. A thin validating
 * dispatcher over the chain's step functions (src/demo/statement-trace.ts):
 * `import` commits through apiImport (the only write), `embed`/`predict`/
 * `reconcile` are reads/inference. Validation failures come back as
 * status:'error' results (the route maps them to 400).
 */
export async function apiDemoTraceStep(db: Database, body: unknown, deps?: Partial<TraceDeps>): Promise<TraceStepResult> {
  const step = (body as { step?: unknown } | null)?.step;

  if (step !== 'import' && step !== 'embed' && step !== 'predict' && step !== 'reconcile') {
    return { step: 'import', status: 'error', durationMs: 0, detail: { bank: '', format: '', rowCount: 0, imported: 0, skippedRows: 0, importedIds: [], message: '' }, error: `unknown step: ${String(step)}` };
  }

  if (typeof body !== 'object' || body === null) {
    return traceError(step, 'request body must be an object');
  }
  const b = body as Record<string, unknown>;
  const traceDeps: TraceDeps = { db, ...(deps ?? {}) };

  if (step === 'import') {
    if (typeof b.filename !== 'string' || b.filename.trim() === '') {
      return traceError('import', 'filename is required');
    }
    if (typeof b.fileHash !== 'string' || b.fileHash.trim() === '') {
      return traceError('import', 'fileHash is required');
    }
    if (!Array.isArray(b.transactions) || b.transactions.length === 0) {
      return traceError('import', 'transactions must be a non-empty array');
    }
    return importStep(
      {
        filename: b.filename,
        bank: typeof b.bank === 'string' ? b.bank : undefined,
        format: typeof b.format === 'string' ? b.format : undefined,
        fileHash: b.fileHash,
        transactions: b.transactions as TraceTransaction[],
      },
      traceDeps,
    );
  }

  if (step === 'embed') {
    if (!Array.isArray(b.transactions) || b.transactions.length === 0) {
      return traceError('embed', 'transactions must be a non-empty array');
    }
    if (b.transactions.length > MAX_TRACE_ROWS) {
      return traceError('embed', `transactions must not exceed ${MAX_TRACE_ROWS} rows`);
    }
    const rows = b.transactions as unknown[];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i] as { description?: unknown } | null;
      if (typeof r !== 'object' || r === null || typeof r.description !== 'string' || r.description.trim() === '') {
        return traceError('embed', `transactions[${i}].description must be a non-empty string`);
      }
    }
    return embeddingStep(rows as { description: string }[], traceDeps);
  }

  if (step === 'predict') {
    if (typeof b.description !== 'string' || b.description.trim() === '') {
      return traceError('predict', 'description must be a non-empty string');
    }
    return predictStep(b.description, traceDeps);
  }

  // step === 'reconcile'
  if (!Array.isArray(b.importedIds) || b.importedIds.length === 0) {
    return traceError('reconcile', 'importedIds must be a non-empty array of transaction ids');
  }
  for (const id of b.importedIds) {
    if (typeof id !== 'number' || !Number.isInteger(id)) {
      return traceError('reconcile', 'importedIds must be a non-empty array of transaction ids');
    }
  }
  return reconcileStep(b.importedIds as number[], traceDeps);
}
