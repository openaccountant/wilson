import type { Database } from '../db/compat-sqlite.js';
import {
  getSpendingSummary,
  getProfitLoss,
  getBudgetVsActual,
  getMonthlySavingsData,
  getTransactions,
  getRecentChatHistory,
  getChatSessions,
  getChatHistoryBySession,
  updateTransaction,
  deleteTransaction,
  type TransactionFilters,
  type TransactionUpdate,
} from '../db/queries.js';
import {
  getAccounts,
  getNetWorthSummary,
  getNetWorthTrend,
  getAccountTransactionSummary,
} from '../db/net-worth-queries.js';
import { checkAlerts } from '../alerts/engine.js';
import { logger } from '../utils/logger.js';
import { traceStore } from '../utils/trace-store.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

function parseAccountId(params: URLSearchParams): number | undefined {
  const val = params.get('accountId');
  return val ? parseInt(val, 10) : undefined;
}

function parseDateRange(params: URLSearchParams) {
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
  return getSpendingSummary(db, startDate, endDate, accountId);
}

export function apiPnl(db: Database, params: URLSearchParams) {
  const { startDate, endDate } = parseDateRange(params);
  const accountId = parseAccountId(params);
  return getProfitLoss(db, startDate, endDate, accountId);
}

export function apiBudgets(db: Database, params: URLSearchParams) {
  const { month } = parseDateRange(params);
  const accountId = parseAccountId(params);
  return getBudgetVsActual(db, month, accountId);
}

export function apiSavings(db: Database, params: URLSearchParams) {
  const months = parseInt(params.get('months') ?? '6', 10);
  const accountId = parseAccountId(params);
  return getMonthlySavingsData(db, undefined, months, accountId);
}

export function apiAlerts(db: Database) {
  return checkAlerts(db);
}

// ── Transactions ────────────────────────────────────────────────────────────

export function apiTransactions(db: Database, params: URLSearchParams) {
  const filters: TransactionFilters = {};
  const start = params.get('start');
  const end = params.get('end');
  const category = params.get('category');
  const merchant = params.get('merchant');
  const accountId = parseAccountId(params);
  if (start) filters.dateStart = start;
  if (end) filters.dateEnd = end;
  if (category) filters.category = category;
  if (merchant) filters.merchant = merchant;
  if (accountId !== undefined) filters.accountId = accountId;
  const txns = getTransactions(db, filters);
  const limit = parseInt(params.get('limit') ?? '100', 10);
  return txns.slice(0, limit);
}

export function apiUpdateTransaction(db: Database, id: number, updates: TransactionUpdate) {
  const success = updateTransaction(db, id, updates);
  return { success, id };
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
  if (start) filters.dateStart = start;
  if (end) filters.dateEnd = end;
  if (category) filters.category = category;
  if (accountId !== undefined) filters.accountId = accountId;
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
  if (start) filters.dateStart = start;
  if (end) filters.dateEnd = end;
  if (category) filters.category = category;
  if (accountId !== undefined) filters.accountId = accountId;
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
  const pnl = getProfitLoss(db, startDate, endDate, accountId);

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
