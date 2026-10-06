// ── Spending drill query-param parsing (+ the 400 shape) ─────────────────────
//
// The server handlers (apiSpendingBreakdown / apiSpendingSeries in api.ts) and
// the offline mirror's serveApiPath parse the drill endpoints' params through
// these functions, so identical URLs run identical queries on both sides.
//
// STRICT: unlike the legacy overview parsers (which silently NaN), a bad param
// is a BadRequest — the server answers 400 `{ error }` and the mirror returns
// the same BadRequest object, which the UI fetch seam turns into the same
// "API 400" error. A malformed param can never reach SQL, so never a 500.
//
// Import-safe for the dashboard UI bundle: imports only the zero-import
// compare-window module and types.

import { isValidYmd } from '../db/compare-window.js';
import type { BreakdownBy, BreakdownQuery, DrillFilters, SeriesQuery } from '../db/spending-drill-sql.js';

/** A rejected request: HTTP 400 with `{ error }`. */
export interface BadRequest {
  status: 400;
  error: string;
}

export function badRequest(error: string): BadRequest {
  return { status: 400, error };
}

/** True for the BadRequest shape (exactly `{ status: 400, error: string }`). */
export function isBadRequest(v: unknown): v is BadRequest {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  return o.status === 400 && typeof o.error === 'string' && Object.keys(o).length === 2;
}

export const BREAKDOWN_DEFAULT_LIMIT = 12;
export const BREAKDOWN_MAX_LIMIT = 200;
export const BREAKDOWN_MAX_OFFSET = 1_000_000;
export const SERIES_MAX_MONTHS = 120;
// Category labels and merchant keys come straight from TEXT columns with no
// length limit (merchant keys fall back to the full description), so the cap
// only guards against absurd input — generous enough that a key the server
// itself emitted always drills (never a 400 on real data).
export const MAX_CAT_LEN = 4096;
export const MAX_MERCHANT_LEN = 4096;
const BREAKDOWN_BY: readonly BreakdownBy[] = ['category', 'merchant', 'detailed'];

const INT_RE = /^\d+$/;

type Parsed<T> = { ok: true; value: T } | { ok: false; error: BadRequest };

function fail<T>(error: string): Parsed<T> {
  return { ok: false, error: badRequest(error) };
}

/** Non-empty param value, or undefined (absent and empty are the same). */
function opt(params: URLSearchParams, name: string): string | undefined {
  const v = params.get(name);
  return v === null || v === '' ? undefined : v;
}

function parsePositiveId(params: URLSearchParams, name: string): Parsed<number | undefined> {
  const raw = opt(params, name);
  if (raw === undefined) return { ok: true, value: undefined };
  if (!INT_RE.test(raw)) return fail(`${name} must be a positive integer`);
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 1) return fail(`${name} must be a positive integer`);
  return { ok: true, value: n };
}

function parseDate(params: URLSearchParams, name: string): Parsed<string | undefined> {
  const raw = opt(params, name);
  if (raw === undefined) return { ok: true, value: undefined };
  if (!isValidYmd(raw)) return fail(`${name} must be a YYYY-MM-DD date`);
  return { ok: true, value: raw };
}

function parseIntInRange(
  params: URLSearchParams,
  name: string,
  fallback: number,
  min: number,
  max: number
): Parsed<number> {
  const raw = opt(params, name);
  if (raw === undefined) return { ok: true, value: fallback };
  if (!INT_RE.test(raw)) return fail(`${name} must be an integer between ${min} and ${max}`);
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < min || n > max) {
    return fail(`${name} must be an integer between ${min} and ${max}`);
  }
  return { ok: true, value: n };
}

function parseFilters(params: URLSearchParams): Parsed<DrillFilters> {
  const startDate = parseDate(params, 'startDate');
  if (!startDate.ok) return startDate;
  const endDate = parseDate(params, 'endDate');
  if (!endDate.ok) return endDate;
  if (startDate.value && endDate.value && startDate.value > endDate.value) {
    return fail('startDate must be on or before endDate');
  }
  const accountId = parsePositiveId(params, 'accountId');
  if (!accountId.ok) return accountId;
  const entityId = parsePositiveId(params, 'entityId');
  if (!entityId.ok) return entityId;

  const cat = opt(params, 'cat');
  if (cat !== undefined && cat.length > MAX_CAT_LEN) return fail(`cat must be at most ${MAX_CAT_LEN} characters`);
  const merchant = opt(params, 'merchant');
  if (merchant !== undefined && merchant.length > MAX_MERCHANT_LEN) {
    return fail(`merchant must be at most ${MAX_MERCHANT_LEN} characters`);
  }

  const value: DrillFilters = {};
  if (startDate.value) value.startDate = startDate.value;
  if (endDate.value) value.endDate = endDate.value;
  if (accountId.value !== undefined) value.accountId = accountId.value;
  if (entityId.value !== undefined) value.entityId = entityId.value;
  if (cat !== undefined) value.cat = cat;
  if (merchant !== undefined) value.merchant = merchant;
  return { ok: true, value };
}

/**
 * GET /api/spending/breakdown params:
 *   startDate, endDate (YYYY-MM-DD, optional, start ≤ end), accountId,
 *   entityId (positive ints), cat (exact label), merchant (exact merchant
 *   key), by=category|merchant|detailed (default: category, or merchant when
 *   cat is set), limit (1–200, default 12), offset (0–1e6, default 0),
 *   compareStart + compareEnd (both or neither, start ≤ end).
 */
export function parseSpendingBreakdownParams(params: URLSearchParams): BreakdownQuery | BadRequest {
  const filters = parseFilters(params);
  if (!filters.ok) return filters.error;

  const byRaw = opt(params, 'by');
  if (byRaw !== undefined && !BREAKDOWN_BY.includes(byRaw as BreakdownBy)) {
    return badRequest(`by must be one of ${BREAKDOWN_BY.join(', ')}`);
  }
  const by: BreakdownBy = (byRaw as BreakdownBy | undefined) ?? (filters.value.cat !== undefined ? 'merchant' : 'category');

  const limit = parseIntInRange(params, 'limit', BREAKDOWN_DEFAULT_LIMIT, 1, BREAKDOWN_MAX_LIMIT);
  if (!limit.ok) return limit.error;
  const offset = parseIntInRange(params, 'offset', 0, 0, BREAKDOWN_MAX_OFFSET);
  if (!offset.ok) return offset.error;

  const compareStart = parseDate(params, 'compareStart');
  if (!compareStart.ok) return compareStart.error;
  const compareEnd = parseDate(params, 'compareEnd');
  if (!compareEnd.ok) return compareEnd.error;
  if ((compareStart.value === undefined) !== (compareEnd.value === undefined)) {
    return badRequest('compareStart and compareEnd must be given together');
  }
  if (compareStart.value && compareEnd.value && compareStart.value > compareEnd.value) {
    return badRequest('compareStart must be on or before compareEnd');
  }

  const query: BreakdownQuery = { ...filters.value, by, limit: limit.value, offset: offset.value };
  if (compareStart.value && compareEnd.value) {
    query.compare = { start: compareStart.value, end: compareEnd.value };
  }
  return query;
}

/**
 * GET /api/spending/series params: startDate + endDate (both or neither;
 * neither → trailing 12 months ending at the coverage end month; at most 120
 * months), interval=month (the only interval), cat, merchant, accountId,
 * entityId.
 */
export function parseSpendingSeriesParams(params: URLSearchParams): SeriesQuery | BadRequest {
  const filters = parseFilters(params);
  if (!filters.ok) return filters.error;
  const { startDate, endDate } = filters.value;
  if ((startDate === undefined) !== (endDate === undefined)) {
    return badRequest('startDate and endDate must be given together');
  }
  if (startDate && endDate) {
    const months =
      (Number(endDate.slice(0, 4)) - Number(startDate.slice(0, 4))) * 12 +
      (Number(endDate.slice(5, 7)) - Number(startDate.slice(5, 7))) +
      1;
    if (months > SERIES_MAX_MONTHS) return badRequest(`the series spans at most ${SERIES_MAX_MONTHS} months`);
  }
  const interval = opt(params, 'interval') ?? 'month';
  if (interval !== 'month') return badRequest('interval must be month');
  return { ...filters.value, interval: 'month' };
}
