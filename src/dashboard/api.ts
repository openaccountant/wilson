import { readFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
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

export function apiLogs(params: URLSearchParams) {
  const limit = parseInt(params.get('limit') ?? '100', 10);
  const levelFilter = params.get('level');

  // Try file-based logs first
  const logFile = join(homedir(), '.openaccountant', 'logs', 'agent.log');
  if (existsSync(logFile)) {
    try {
      const content = readFileSync(logFile, 'utf-8');
      const lines = content.trim().split('\n').filter(Boolean);
      let entries = lines.map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      }).filter(Boolean);
      if (levelFilter) {
        entries = entries.filter((e: { level?: string }) => e.level === levelFilter);
      }
      return entries.slice(-limit);
    } catch {
      // Fall through to in-memory logs
    }
  }

  // Fallback to in-memory logs
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

export function apiTraces(params: URLSearchParams) {
  const limit = parseInt(params.get('limit') ?? '100', 10);
  return traceStore.getRecentTraces(limit);
}

export function apiTraceStats() {
  return traceStore.getStats();
}
