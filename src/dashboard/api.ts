import type { Database } from '../db/compat-sqlite.js';
import {
  getSpendingSummary,
  getProfitLoss,
  getBudgetVsActual,
  getMonthlySavingsData,
  getTransactions,
  type TransactionFilters,
} from '../db/queries.js';
import { checkAlerts } from '../alerts/engine.js';

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
