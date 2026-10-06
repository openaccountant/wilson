/**
 * Date-range math for the dashboard header, driven by URL state.
 *
 * Pure (takes `now` explicitly) so it is testable from bun; every date is a
 * *local* calendar date (YYYY-MM-DD) — never derived from toISOString, which
 * would flip the month near midnight for users west of UTC.
 */
import type { DateRange } from '../types';
import type { UrlPreset, UrlState } from './urlState';

export type { DateRange };
export type RangePreset = UrlPreset;

const pad = (n: number) => String(n).padStart(2, '0');

export function ymd(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function parseYmd(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function monthRange(d: Date): DateRange {
  const start = new Date(d.getFullYear(), d.getMonth(), 1);
  const end = new Date(d.getFullYear(), d.getMonth() + 1, 0);
  return { startDate: ymd(start), endDate: ymd(end) };
}

export function quarterRange(d: Date): DateRange {
  const qMonth = Math.floor(d.getMonth() / 3) * 3;
  const start = new Date(d.getFullYear(), qMonth, 1);
  const end = new Date(d.getFullYear(), qMonth + 3, 0);
  return { startDate: ymd(start), endDate: ymd(end) };
}

export function yearRange(year: number): DateRange {
  return { startDate: `${year}-01-01`, endDate: `${year}-12-31` };
}

export function ytdRange(now: Date): DateRange {
  return { startDate: `${now.getFullYear()}-01-01`, endDate: ymd(now) };
}

/** The concrete range a URL state describes, relative to `now`. */
export function resolveDateRange(state: Pick<UrlState, 'preset' | 'start' | 'end'>, now: Date): DateRange {
  const anchor = state.start ? parseYmd(state.start) : now;
  switch (state.preset) {
    case 'quarter':
      return quarterRange(anchor);
    case 'ytd':
      return ytdRange(now);
    case 'year':
      return yearRange(anchor.getFullYear());
    case 'prev-year':
      return yearRange(now.getFullYear() - 1);
    case 'custom':
      if (state.start && state.end) {
        return state.start <= state.end
          ? { startDate: state.start, endDate: state.end }
          : { startDate: state.end, endDate: state.start };
      }
      return monthRange(now);
    case 'month':
    default:
      return monthRange(anchor);
  }
}

type DatePatch = Pick<UrlState, 'preset' | 'start' | 'end'>;

/**
 * URL keys for a period-based preset anchored at `periodStart`. The anchor is
 * omitted when it is the current period, so a bookmark of "this month" keeps
 * meaning this month next month.
 */
function periodPatch(preset: 'month' | 'quarter' | 'year', periodStart: string, now: Date): DatePatch {
  const current =
    preset === 'month'
      ? monthRange(now).startDate
      : preset === 'quarter'
        ? quarterRange(now).startDate
        : yearRange(now.getFullYear()).startDate;
  return { preset, start: periodStart === current ? null : periodStart, end: null };
}

/** Clicking a preset pill: always the current period. */
export function presetPatch(preset: RangePreset): DatePatch {
  // 'custom' has no pill; selecting it without dates means "this month".
  return { preset: preset === 'custom' ? 'month' : preset, start: null, end: null };
}

/** Any explicit range (import window, chart brush, …) is a custom range. */
export function customRangePatch(range: DateRange): DatePatch {
  const [a, b] =
    range.startDate <= range.endDate ? [range.startDate, range.endDate] : [range.endDate, range.startDate];
  return { preset: 'custom', start: a, end: b };
}

/**
 * The header's ← / → arrows. Quarter steps by quarter; year-like presets step
 * by year (and become `year`); month and custom step by calendar month from
 * the range start (custom becomes `month`, so the pill matches the label).
 */
export function stepPatch(state: DatePatch, dir: -1 | 1, now: Date): DatePatch {
  const range = resolveDateRange(state, now);
  const d = parseYmd(range.startDate);
  switch (state.preset) {
    case 'quarter':
      return periodPatch('quarter', quarterRange(new Date(d.getFullYear(), d.getMonth() + 3 * dir, 1)).startDate, now);
    case 'year':
    case 'ytd':
    case 'prev-year':
      return periodPatch('year', yearRange(d.getFullYear() + dir).startDate, now);
    case 'month':
    case 'custom':
    default:
      return periodPatch('month', monthRange(new Date(d.getFullYear(), d.getMonth() + dir, 1)).startDate, now);
  }
}

/** Header label for a resolved range. */
export function rangeLabel(preset: RangePreset, range: DateRange): string {
  const start = parseYmd(range.startDate);
  const end = parseYmd(range.endDate);

  if (start.getMonth() === end.getMonth() && start.getFullYear() === end.getFullYear()) {
    if (preset === 'custom' && !(range.startDate.endsWith('-01') && range.endDate === monthRange(start).endDate)) {
      const fmtDay = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      return range.startDate === range.endDate
        ? start.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
        : `${fmtDay(start)} – ${fmtDay(end)}, ${start.getFullYear()}`;
    }
    return start.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  }
  if (preset === 'quarter') return `Q${Math.floor(start.getMonth() / 3) + 1} ${start.getFullYear()}`;
  if (preset === 'ytd') return `YTD ${start.getFullYear()}`;
  if (range.startDate.endsWith('-01-01') && range.endDate.endsWith('-12-31') && start.getFullYear() === end.getFullYear()) {
    return String(start.getFullYear());
  }
  const fmtShort = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
  return `${fmtShort(start)} – ${fmtShort(end)}`;
}
