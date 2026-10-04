// ── Drill date math: comparison windows, coverage, month spans ───────────────
//
// Pure calendar math shared by the dashboard SERVER (src/db/spending-drill-sql.ts
// via src/dashboard/api.ts), the offline MIRROR (store/mirror-reads.ts) and the
// dashboard UI (which computes compareStart/compareEnd for
// /api/spending/breakdown and the anchored 12-month window for
// /api/spending/series). ZERO imports — safe for every bundle.
//
// Every date is a calendar date string 'YYYY-MM-DD' (no time zone): the caller
// decides what "today" is (`asOf`) so the UI can use the viewer's LOCAL date.
// All arithmetic runs on UTC epoch days, which have no DST gaps.

export type CompareMode = 'prev' | 'yoy';

export interface DateWindow {
  /** Inclusive first day, YYYY-MM-DD. */
  start: string;
  /** Inclusive last day, YYYY-MM-DD. */
  end: string;
}

export interface CompareWindow extends DateWindow {
  /** True when the current range extends past `asOf` (an in-progress period). */
  partial: boolean;
  /** Days of the current range that have elapsed (≤ periodDays). */
  elapsedDays: number;
  /** Total days in the current range. */
  periodDays: number;
}

/** Structural twin of CoverageResult (overview-sql.ts) / CoverageResponse (UI). */
export interface CoverageLike {
  start: string | null;
  end: string | null;
  months: readonly string[];
}

const DAY_MS = 86_400_000;
const YMD_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const YM_RE = /^(\d{4})-(\d{2})$/;

/** Epoch day for a real calendar date, or null (malformed / 2026-02-30). */
export function ymdToDay(s: string): number | null {
  const m = YMD_RE.exec(s);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  // Date.UTC maps years 0–99 to 1900–1999; real ledger dates are 4-digit years.
  if (y < 1000) return null;
  const t = Date.UTC(y, mo - 1, d);
  const back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  return Math.round(t / DAY_MS);
}

/** True for a real calendar date in strict YYYY-MM-DD form. */
export function isValidYmd(s: string): boolean {
  return ymdToDay(s) !== null;
}

/** Epoch day → YYYY-MM-DD. */
export function dayToYmd(day: number): string {
  const d = new Date(day * DAY_MS);
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
  const da = String(d.getUTCDate()).padStart(2, '0');
  return `${String(y).padStart(4, '0')}-${mo}-${da}`;
}

function mustDay(s: string, what: string): number {
  const day = ymdToDay(s);
  if (day === null) throw new RangeError(`${what} must be a YYYY-MM-DD date, got "${s}"`);
  return day;
}

function lastDayOfMonth(y: number, m0: number): number {
  return new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate();
}

/** First day of the month `months` away from (y, m0) — month index may overflow. */
function shiftMonthStart(y: number, m0: number, months: number): { y: number; m0: number } {
  const total = y * 12 + m0 + months;
  return { y: Math.floor(total / 12), m0: ((total % 12) + 12) % 12 };
}

function parts(s: string): { y: number; m0: number; d: number } {
  const m = YMD_RE.exec(s)!;
  return { y: Number(m[1]), m0: Number(m[2]) - 1, d: Number(m[3]) };
}

function ymdOf(y: number, m0: number, d: number): string {
  return `${String(y).padStart(4, '0')}-${String(m0 + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * Whole calendar months spanned when the window is month-aligned (starts on
 * the 1st, ends on a month's last day) — month, quarter, year presets and any
 * custom range of whole months. Null otherwise.
 */
export function alignedMonthCount(window: DateWindow): number | null {
  const s = parts(window.start);
  const e = parts(window.end);
  if (s.d !== 1 || e.d !== lastDayOfMonth(e.y, e.m0)) return null;
  const n = (e.y * 12 + e.m0) - (s.y * 12 + s.m0) + 1;
  return n >= 1 ? n : null;
}

/** Same calendar date `years` earlier/later; Feb 29 falls back to Feb 28. */
function shiftYears(s: string, years: number): string {
  const p = parts(s);
  const y = p.y + years;
  return ymdOf(y, p.m0, Math.min(p.d, lastDayOfMonth(y, p.m0)));
}

/**
 * The comparison window for the current range [start, end].
 *
 * - `prev`: the immediately preceding period. A month-aligned range of N whole
 *   months compares against the N calendar months before it (Oct → Sep,
 *   Q3 → Q2, a year → the prior year); any other range compares against the
 *   same number of days immediately before it.
 * - `yoy`: the same dates one year earlier (Feb 29 → Feb 28). A
 *   month-aligned range compares whole calendar months, so Feb 2029 compares
 *   against all 29 days of Feb 2028.
 *
 * PARTIAL periods: when the range extends past `asOf` (e.g. "this month" on
 * the 3rd), only the elapsed days count — the comparison window starts at the
 * prior period's start and spans the same number of elapsed days, clamped to
 * the prior period's end (Mar 1–30 elapsed vs a 28-day Feb → all of Feb).
 *
 * Returns null when no comparison is possible: the range has not started yet
 * (start > asOf), or a date is malformed / inverted.
 */
export function computeCompareWindow(range: DateWindow, mode: CompareMode, asOf: string): CompareWindow | null {
  const start = ymdToDay(range.start);
  const end = ymdToDay(range.end);
  const today = ymdToDay(asOf);
  if (start === null || end === null || today === null || end < start) return null;
  if (start > today) return null;

  const periodDays = end - start + 1;
  const effectiveEnd = Math.min(end, today);
  const elapsedDays = effectiveEnd - start + 1;
  const partial = effectiveEnd < end;

  let priorStart: number;
  let priorEnd: number;
  const months = alignedMonthCount(range);
  if (mode === 'yoy') {
    priorStart = mustDay(shiftYears(range.start, -1), 'start');
    if (months !== null) {
      // Whole calendar months compare against the WHOLE same months a year
      // earlier: Feb 2029 (28 days) vs all of Feb 2028, Feb 29 included.
      const e = parts(range.end);
      priorEnd = mustDay(ymdOf(e.y - 1, e.m0, lastDayOfMonth(e.y - 1, e.m0)), 'end');
    } else {
      priorEnd = mustDay(shiftYears(range.end, -1), 'end');
    }
  } else {
    if (months !== null) {
      const s = parts(range.start);
      const ps = shiftMonthStart(s.y, s.m0, -months);
      const pe = shiftMonthStart(s.y, s.m0, -1);
      priorStart = mustDay(ymdOf(ps.y, ps.m0, 1), 'start');
      priorEnd = mustDay(ymdOf(pe.y, pe.m0, lastDayOfMonth(pe.y, pe.m0)), 'end');
    } else {
      priorStart = start - periodDays;
      priorEnd = start - 1;
    }
  }

  // Partial periods: `prev` spans the same number of elapsed days; `yoy`
  // matches calendar dates (Jan 1 – Mar 10 vs Jan 1 – Mar 10 last year, even
  // across a Feb 29), both clamped to the prior period's end.
  const partialEnd =
    mode === 'yoy'
      ? mustDay(shiftYears(dayToYmd(effectiveEnd), -1), 'asOf')
      : priorStart + elapsedDays - 1;
  const compareEnd = partial ? Math.min(priorEnd, partialEnd) : priorEnd;
  return {
    start: dayToYmd(priorStart),
    end: dayToYmd(compareEnd),
    partial,
    elapsedDays,
    periodDays,
  };
}

/**
 * True when ANY day of the window is covered by imported data — the same
 * day-level predicate as the heatmap (lib/heatmapGrid.ts makeCoveredFn): the
 * day lies within [coverage.start, coverage.end] AND its month has at least
 * one imported transaction. A window entirely before the first import, after
 * the last, or inside a gap month has NO coverage — its spend is unknown
 * (null), which is distinct from a covered window with no spend (0).
 */
export function windowHasCoverage(window: DateWindow, coverage: CoverageLike): boolean {
  if (coverage.start === null || coverage.end === null) return false;
  const lo = window.start > coverage.start ? window.start : coverage.start;
  const hi = window.end < coverage.end ? window.end : coverage.end;
  if (lo > hi) return false;
  const months = new Set(coverage.months);
  return monthSpan(lo.slice(0, 7), hi.slice(0, 7)).some((m) => months.has(m));
}

/** Every YYYY-MM from `startMonth` to `endMonth` inclusive ([] when inverted). */
export function monthSpan(startMonth: string, endMonth: string): string[] {
  const a = YM_RE.exec(startMonth);
  const b = YM_RE.exec(endMonth);
  if (!a || !b) return [];
  let idx = Number(a[1]) * 12 + Number(a[2]) - 1;
  const last = Number(b[1]) * 12 + Number(b[2]) - 1;
  const out: string[] = [];
  while (idx <= last) {
    out.push(`${String(Math.floor(idx / 12)).padStart(4, '0')}-${String((idx % 12) + 1).padStart(2, '0')}`);
    idx++;
  }
  return out;
}

/**
 * The trailing `months`-month window ending with the month of `anchor`
 * (normally the coverage end): first day of the earliest month through the
 * LAST day of the anchor month. The drill's 12-month charts use this so they
 * stay put while the global range moves.
 */
export function trailingMonthsWindow(anchor: string, months: number = 12): DateWindow | null {
  if (!isValidYmd(anchor) || !Number.isInteger(months) || months < 1) return null;
  const p = parts(anchor);
  const first = shiftMonthStart(p.y, p.m0, -(months - 1));
  return {
    start: ymdOf(first.y, first.m0, 1),
    end: ymdOf(p.y, p.m0, lastDayOfMonth(p.y, p.m0)),
  };
}

/** Calendar bounds of a YYYY-MM month (null when malformed). */
export function monthBounds(month: string): DateWindow | null {
  const m = YM_RE.exec(month);
  if (!m) return null;
  const y = Number(m[1]);
  const m0 = Number(m[2]) - 1;
  if (m0 < 0 || m0 > 11) return null;
  return { start: ymdOf(y, m0, 1), end: ymdOf(y, m0, lastDayOfMonth(y, m0)) };
}
