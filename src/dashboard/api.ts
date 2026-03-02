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
import { checkAlerts } from '../alerts/engine.js';
import { logger } from '../utils/logger.js';
import { traceStore } from '../utils/trace-store.js';

/**
 * JSON API handlers that query SQLite directly.
 * Each returns a plain object to be JSON-serialized.
 */

export function apiSummary(db: Database, params: URLSearchParams) {
  const month = params.get('month') ?? new Date().toISOString().slice(0, 7);
  const [year, mon] = month.split('-').map(Number);
  const startDate = `${month}-01`;
  const endDate = new Date(year, mon, 0).toISOString().slice(0, 10);
  return getSpendingSummary(db, startDate, endDate);
}

export function apiPnl(db: Database, params: URLSearchParams) {
  const month = params.get('month') ?? new Date().toISOString().slice(0, 7);
  const [year, mon] = month.split('-').map(Number);
  const startDate = `${month}-01`;
  const endDate = new Date(year, mon, 0).toISOString().slice(0, 10);
  return getProfitLoss(db, startDate, endDate);
}

export function apiBudgets(db: Database, params: URLSearchParams) {
  const month = params.get('month') ?? new Date().toISOString().slice(0, 7);
  return getBudgetVsActual(db, month);
}

export function apiSavings(db: Database, params: URLSearchParams) {
  const months = parseInt(params.get('months') ?? '6', 10);
  return getMonthlySavingsData(db, undefined, months);
}

export function apiAlerts(db: Database) {
  return checkAlerts(db);
}

export function apiLogs(db: Database, params: URLSearchParams) {
  const limit = parseInt(params.get('limit') ?? '100', 10);
  const levelFilter = params.get('level');

  // Read from SQLite (persisted, cross-session)
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

  // Fallback: in-memory buffer (pre-DB or if table doesn't exist yet)
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

export function apiTransactions(db: Database, params: URLSearchParams) {
  const filters: TransactionFilters = {};
  const start = params.get('start');
  const end = params.get('end');
  const category = params.get('category');
  const merchant = params.get('merchant');
  if (start) filters.dateStart = start;
  if (end) filters.dateEnd = end;
  if (category) filters.category = category;
  if (merchant) filters.merchant = merchant;
  const txns = getTransactions(db, filters);
  const limit = parseInt(params.get('limit') ?? '100', 10);
  return txns.slice(0, limit);
}

export function apiExportCsv(db: Database, params: URLSearchParams): string {
  const filters: TransactionFilters = {};
  const start = params.get('start');
  const end = params.get('end');
  const category = params.get('category');
  if (start) filters.dateStart = start;
  if (end) filters.dateEnd = end;
  if (category) filters.category = category;
  const txns = getTransactions(db, filters);

  const escape = (v: string) => {
    if (v.includes(',') || v.includes('"') || v.includes('\n')) {
      return '"' + v.replace(/"/g, '""') + '"';
    }
    return v;
  };

  const header = 'Date,Description,Amount,Category';
  const rows = txns.map((t) =>
    [t.date, escape(t.description), String(t.amount), escape(t.category ?? '')].join(',')
  );
  return [header, ...rows].join('\n');
}

export function apiChatHistory(db: Database) {
  try {
    const rows = getRecentChatHistory(db, 50);
    // Return in chronological order (newest-first from DB → reverse)
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

export function apiUpdateTransaction(db: Database, id: number, updates: TransactionUpdate) {
  const success = updateTransaction(db, id, updates);
  return { success, id };
}

export function apiDeleteTransaction(db: Database, id: number) {
  const success = deleteTransaction(db, id);
  return { success, id };
}

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
      // Build byModel from DB
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
