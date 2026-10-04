/**
 * Spending drill-down — pure state + view-model logic (unit-tested with bun).
 *
 * Levels are DERIVED from the URL; there is no depth key:
 *   L1  no cat              — categories (ranked bar list + small donut)
 *   L2  cat                 — merchants (or category_detailed) in the category
 *   L3  merchant (cat opt.) — one merchant's transactions ('all KFC' when no cat)
 *   L4  txn                 — transaction drawer over the level beneath it
 *
 * History: every drill step and breadcrumb jump PUSHES (Back goes up one
 * level); the by toggle REPLACES. A reload restores the exact depth because
 * the depth is the URL.
 *
 * No `@/` alias and no `window`: bun tests import this from the repo root.
 */
import {
  alignedMonthCount,
  computeCompareWindow,
  isValidYmd,
  monthBounds,
  trailingMonthsWindow,
  ymdToDay,
} from '../../../../db/compare-window.js';
import { isUncategorized, UNCATEGORIZED_LABEL } from '../../../../db/spend-rules.js';
import type { ChartTableData } from '../charts/chartCardState';
import { money, moneyWhole, pct } from '../format';
import { isNeutralLabel, PAYMENT_METHOD_LABELS } from './neutralLabels';
import { resolveDateRange } from './dateRange';
import { serializeHash, withTab, type UrlState } from './urlState';
import type { BreakdownResponse, BreakdownRow, SeriesResponse } from './spendingApi';

export type DrillLevel = 1 | 2 | 3 | 4;
export type BaseLevel = 1 | 2 | 3;
export type DrillBy = 'merchant' | 'detailed';

export interface Drill {
  level: DrillLevel;
  /** The level rendered under the txn drawer (== level below L4). */
  baseLevel: BaseLevel;
  cat: string | null;
  merchant: string | null;
  txn: number | null;
  /** Grouping at L2. Only 'detailed' when the URL says so AND we are at L2. */
  by: DrillBy;
}

export type DrillKeys = Pick<UrlState, 'cat' | 'merchant' | 'txn' | 'by'>;

function parseTxnId(v: string | null): number | null {
  if (!v || !/^\d+$/.test(v)) return null;
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

export function deriveDrill(s: DrillKeys): Drill {
  const cat = s.cat || null;
  const merchant = s.merchant || null;
  const txn = parseTxnId(s.txn);
  const baseLevel: BaseLevel = merchant ? 3 : cat ? 2 : 1;
  const level: DrillLevel = txn != null ? 4 : baseLevel;
  const by: DrillBy = baseLevel === 2 && s.by === 'detailed' ? 'detailed' : 'merchant';
  return { level, baseLevel, cat, merchant, txn, by };
}

// ── Navigation targets ──────────────────────────────────────────────────────

export type NavMode = 'push' | 'replace';

/** Drill actions and the history mode each one uses. */
export type DrillAction = 'drill' | 'up' | 'crumb' | 'openTxn' | 'by' | 'month';

export function drillNavMode(action: DrillAction): NavMode {
  return action === 'by' ? 'replace' : 'push';
}

/**
 * Patch for drilling into row `key` at the current base level, or null when
 * the row isn't drillable (L3 rows open the drawer; by=detailed rows are
 * category_detailed values, which no URL key can filter on).
 */
export function drillIntoPatch(drill: Drill, key: string): DrillKeys | null {
  if (drill.baseLevel === 1) return { cat: key, merchant: null, txn: null, by: null };
  if (drill.baseLevel === 2) {
    if (drill.by === 'detailed') return null;
    return { cat: drill.cat, merchant: key, txn: null, by: null };
  }
  return null;
}

export function isDrillable(drill: Drill): boolean {
  return drill.baseLevel === 1 || (drill.baseLevel === 2 && drill.by === 'merchant');
}

export function openTxnPatch(drill: Drill, id: number): DrillKeys {
  return { cat: drill.cat, merchant: drill.merchant, txn: String(id), by: drill.baseLevel === 2 && drill.by === 'detailed' ? 'detailed' : null };
}

/** One level up, or null at L1. L4 → closes the drawer. */
export function upPatch(drill: Drill): DrillKeys | null {
  switch (drill.level) {
    case 4:
      return { cat: drill.cat, merchant: drill.merchant, txn: null, by: drill.by === 'detailed' ? 'detailed' : null };
    case 3:
      return { cat: drill.cat, merchant: null, txn: null, by: null };
    case 2:
      return { cat: null, merchant: null, txn: null, by: null };
    default:
      return null;
  }
}

export function byPatch(drill: Drill, by: DrillBy): DrillKeys {
  return { cat: drill.cat, merchant: null, txn: null, by: by === 'detailed' ? 'detailed' : null };
}

export function applyDrill(state: UrlState, patch: DrillKeys): UrlState {
  return { ...state, extra: [...state.extra], ...patch };
}

// ── Breadcrumb ──────────────────────────────────────────────────────────────

export interface Crumb {
  id: 'all' | 'cat' | 'merchant';
  /** Possibly truncated display text. */
  label: string;
  /** Full text (title attribute when truncated). */
  full: string;
  truncated: boolean;
  /** URL keys this crumb navigates to (push). */
  patch: DrillKeys;
  current: boolean;
}

export const ROOT_CRUMB_LABEL = 'All spending';
export const CRUMB_MAX = 28;

export function truncateLabel(label: string, max = CRUMB_MAX): { text: string; truncated: boolean } {
  const chars = [...label];
  if (chars.length <= max) return { text: label, truncated: false };
  return { text: `${chars.slice(0, Math.max(1, max - 1)).join('').trimEnd()}…`, truncated: true };
}

export function breadcrumbs(drill: Drill): Crumb[] {
  const items: Omit<Crumb, 'current'>[] = [];
  const crumb = (id: Crumb['id'], full: string, patch: DrillKeys) => {
    const t = truncateLabel(full);
    items.push({ id, label: t.text, full, truncated: t.truncated, patch });
  };
  crumb('all', ROOT_CRUMB_LABEL, { cat: null, merchant: null, txn: null, by: null });
  if (drill.cat) crumb('cat', drill.cat, { cat: drill.cat, merchant: null, txn: null, by: null });
  if (drill.merchant) crumb('merchant', drill.merchant, { cat: drill.cat, merchant: drill.merchant, txn: null, by: null });
  return items.map((c, i) => ({ ...c, current: i === items.length - 1 }));
}

// ── Focus management ────────────────────────────────────────────────────────

export type FocusTarget = { kind: 'heading' } | { kind: 'row'; key: string } | null;

/**
 * Where focus goes after the URL moves from `prev` to `next`:
 *   deeper            → the new level's heading;
 *   shallower         → the row (at the new level) for the level just left;
 *   L3 ↔ L4 (drawer)  → null (the dialog manages its own focus/restore);
 *   same level, other key (e.g. Back between siblings) → heading.
 */
export function focusAfterTransition(prev: Drill | null, next: Drill): FocusTarget {
  if (!prev) return null;
  if (next.baseLevel > prev.baseLevel) return { kind: 'heading' };
  if (next.baseLevel < prev.baseLevel) {
    const key = next.baseLevel === 1 ? prev.cat : next.baseLevel === 2 ? prev.merchant : null;
    return key ? { kind: 'row', key } : { kind: 'heading' };
  }
  if (prev.cat !== next.cat || prev.merchant !== next.merchant) return { kind: 'heading' };
  return null;
}

// ── Keyboard ────────────────────────────────────────────────────────────────

/** Roving-tabindex move for a list key; null when the key isn't a list move. */
export function rovingIndex(key: string, index: number, count: number): number | null {
  if (count <= 0) return null;
  switch (key) {
    case 'ArrowDown':
      return Math.min(index + 1, count - 1);
    case 'ArrowUp':
      return Math.max(index - 1, 0);
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}

/** Backspace or Alt+ArrowUp = up one level. */
export function isUpKey(e: { key: string; altKey?: boolean }): boolean {
  return e.key === 'Backspace' || (e.key === 'ArrowUp' && !!e.altKey);
}

export function isActivateKey(key: string): boolean {
  return key === 'Enter' || key === ' ' || key === 'Spacebar';
}

// ── Labels and colors ───────────────────────────────────────────────────────

export { PAYMENT_METHOD_LABELS };

/**
 * Labels that never earn a palette hue: Uncategorized (NULL / blank /
 * 'Uncategorized'), catch-alls and payment-method labels. The SAME list the
 * session palette skips (lib/neutralLabels.ts), so they are grey everywhere
 * and never consume a palette slot.
 */
export function isNeutralDrillLabel(label: string | null | undefined): boolean {
  return isUncategorized(label) || isNeutralLabel(label);
}

/** Sentinel key of the folded 'N more' row — cannot collide with a real label. */
export const MORE_KEY = '\u0000more';

export const L1_TOP_N = 7;
export const L2_TOP_N = 12;

export interface MoreRow {
  key: typeof MORE_KEY;
  label: string;
  /** Number of folded groups. */
  groups: number;
  total: number;
  /** Transactions in the folded groups. */
  count: number;
}

/** 'N more categories' — never the bare word 'Other', which is a real category. */
export function moreLabel(groups: number, noun: 'category' | 'merchant' = 'category'): string {
  const plural = noun === 'category' ? 'categories' : 'merchants';
  return `${groups} more ${groups === 1 ? noun : plural}`;
}

/**
 * Top-N + fold. Rows past `n` the server returned anyway fold into the 'more'
 * row together with the server's otherTotal / otherCount.
 */
export function foldTopN(
  resp: Pick<BreakdownResponse, 'rows' | 'otherTotal' | 'otherCount'> & { otherTxnCount?: number },
  n: number,
  noun: 'category' | 'merchant' = 'category',
): { visible: BreakdownRow[]; more: MoreRow | null } {
  const visible = resp.rows.slice(0, n);
  const spill = resp.rows.slice(n);
  const groups = spill.length + Math.max(0, resp.otherCount || 0);
  const total = spill.reduce((s, r) => s + r.total, 0) + Math.max(0, resp.otherTotal || 0);
  const count = spill.reduce((s, r) => s + r.count, 0) + Math.max(0, resp.otherTxnCount || 0);
  if (groups <= 0 && total <= 0) return { visible, more: null };
  return { visible, more: { key: MORE_KEY, label: moreLabel(groups, noun), groups, total, count } };
}

/**
 * The shared scale max for a bar list: REAL rows only. The folded 'N more'
 * row is a text row (never a scaled bar), so a long tail can't squash them.
 */
export function barScaleMax(items: readonly { total: number; action?: string }[]): number {
  return items.reduce((m, it) => (it.action === 'expand' ? m : Math.max(m, it.total)), 0);
}

/**
 * The groups NOT yet loaded after expanding 'N more' (paging stopped at the
 * render cap, or 'Show more' not pressed yet), as a folded row — so a table of
 * the expanded rows still sums to the period total. Null when everything is loaded.
 */
export function expandedRemainder(
  loaded: readonly BreakdownRow[],
  all: { total: number; count: number; groups: number },
  noun: 'category' | 'merchant' = 'category',
): MoreRow | null {
  const groups = Math.max(0, all.groups - loaded.length);
  if (groups === 0) return null;
  const total = Math.max(0, Math.round((all.total - loaded.reduce((s, r) => s + r.total, 0)) * 100) / 100);
  const count = Math.max(0, all.count - loaded.reduce((s, r) => s + r.count, 0));
  return { key: MORE_KEY, label: moreLabel(groups, noun), groups, total, count };
}

/** Bar width (0–100) on one shared zero baseline. */
export function barPercent(value: number, max: number): number {
  if (!(max > 0) || !(value > 0)) return 0;
  return Math.min(100, (value / max) * 100);
}

/** '12%' of the period total ('<1%' for small non-zero shares). */
export function shareLabel(value: number, total: number): string {
  if (!(total > 0) || !(value > 0)) return '0%';
  const share = (value / total) * 100;
  if (share < 1) return '<1%';
  return pct(share);
}

export interface DonutSlice {
  key: string;
  name: string;
  value: number;
  color: string;
}

/**
 * Donut slices: the visible rows in their stable palette color, everything
 * else (the folded 'more' row, Uncategorized, payment methods) neutral grey.
 * Colored slices come first in rank order; every grey slice (neutral labels,
 * then 'more') forms ONE trailing run, so greys never interleave with hues —
 * the donut separates adjacent greys with its surface-colored stroke.
 */
export function donutSlices(
  visible: readonly BreakdownRow[],
  more: MoreRow | null,
  colorFor: (label: string) => string,
  neutral: string,
): DonutSlice[] {
  const colored: DonutSlice[] = [];
  const grey: DonutSlice[] = [];
  for (const r of visible) {
    if (!(r.total > 0)) continue;
    const isGrey = isNeutralDrillLabel(r.label);
    const color = isGrey ? neutral : colorFor(r.label);
    // A label the palette has no slot for comes back neutral too.
    (isGrey || color === neutral ? grey : colored).push({ key: r.key, name: r.label, value: r.total, color });
  }
  if (more && more.total > 0) grey.push({ key: more.key, name: more.label, value: more.total, color: neutral });
  return [...colored, ...grey];
}

export type DonutReplacement =
  | { kind: 'uncategorized'; share: number; total: number; count: number }
  | { kind: 'single'; label: string }
  | null;

/**
 * A donut carries no information when one slice dominates: >80% Uncategorized
 * (show the stat + a categorize CTA) or a single category.
 */
export function donutReplacement(resp: Pick<BreakdownResponse, 'rows' | 'total' | 'otherCount' | 'otherTotal'>): DonutReplacement {
  if (!(resp.total > 0)) return null;
  const uncat = resp.rows.find((r) => isUncategorized(r.key) || r.label === UNCATEGORIZED_LABEL);
  if (uncat && uncat.total / resp.total > 0.8) {
    return { kind: 'uncategorized', share: (uncat.total / resp.total) * 100, total: uncat.total, count: uncat.count };
  }
  if (resp.rows.length === 1 && !(resp.otherCount > 0) && !(resp.otherTotal > 0)) {
    return { kind: 'single', label: resp.rows[0].label };
  }
  return null;
}

// ── Comparison deltas ───────────────────────────────────────────────────────

/** Δ% is only meaningful on a base of at least this much spend. */
export const DELTA_PCT_MIN_BASE = 50;

export interface DeltaView {
  direction: 'up' | 'down' | 'flat';
  /** '▲' / '▼' / '–' — the non-color signal. */
  arrow: string;
  /** '+$120' / '-$80' / '$0' (always shown). */
  dollars: string;
  /** '+15%' — only when the base ≥ $50. */
  percent: string | null;
  /** Visible text: '▲ +$120 (+15%)'. */
  text: string;
  /** Screen-reader text: 'up $120 (15%) vs previous period'. */
  srText: string;
  /** For spending, up is bad. */
  tone: 'bad' | 'good' | 'neutral';
}

export type CompareMode = 'prev' | 'yoy';

export function compareLabel(cmp: CompareMode): string {
  return cmp === 'yoy' ? 'vs same period last year' : 'vs previous period';
}

/** compareStart/compareEnd for /api/spending/breakdown, plus what they mean. */
export interface DrillCompare {
  compareStart: string;
  compareEnd: string;
  /** The current period is in progress (or its data ends early). */
  partial: boolean;
  /** Days of the current period being compared. */
  elapsedDays: number;
  /** Visible caption under the header Δ: 'vs Aug 1–15 (same 15 days)'. */
  caption: string;
}

function ymdParts(ymd: string): { y: number; m: number; d: number } {
  const [y, m, d] = ymd.split('-').map(Number);
  return { y, m, d };
}

/** 'Aug 1–15', 'Jan 30 – Feb 12', 'Dec 20, 2025 – Jan 2, 2026' (year shown when not `currentYear`). */
export function spanLabel(start: string, end: string, currentYear: number): string {
  const a = ymdParts(start);
  const b = ymdParts(end);
  const abbr = (m: number) => MONTH_ABBR[m - 1] ?? '?';
  if (a.y !== b.y) return `${abbr(a.m)} ${a.d}, ${a.y} – ${abbr(b.m)} ${b.d}, ${b.y}`;
  const year = a.y === currentYear ? '' : `, ${a.y}`;
  if (start === end) return `${abbr(a.m)} ${a.d}${year}`;
  if (a.m === b.m) return `${abbr(a.m)} ${a.d}–${b.d}${year}`;
  return `${abbr(a.m)} ${a.d} – ${abbr(b.m)} ${b.d}${year}`;
}

/**
 * What the header Δ compares against, in words:
 *   partial window of the same length → 'vs Aug 1–15 (same 15 days)'
 *   one whole month                   → 'vs Oct 2025'
 *   a calendar quarter                → 'vs Q2 2026'
 *   a calendar year                   → 'vs 2025'
 *   other whole months                → 'vs Jan–Apr 2026'
 *   anything else                     → 'vs Jan 1–10'
 * `currentYear` is the current period's year (the year is omitted when equal).
 */
export function compareCaption(
  w: { start: string; end: string; partial: boolean; elapsedDays: number },
  currentYear: number,
): string {
  const a = ymdToDay(w.start);
  const b = ymdToDay(w.end);
  if (a === null || b === null) return '';
  const days = b - a + 1;
  if (w.partial && days === w.elapsedDays) {
    return `vs ${spanLabel(w.start, w.end, currentYear)} (same ${days} ${days === 1 ? 'day' : 'days'})`;
  }
  const months = alignedMonthCount(w);
  const s = ymdParts(w.start);
  const e = ymdParts(w.end);
  if (months === 1) return `vs ${monthLongLabel(w.start.slice(0, 7))}`;
  if (months === 3 && (s.m - 1) % 3 === 0) return `vs Q${(s.m - 1) / 3 + 1} ${s.y}`;
  if (months === 12 && s.m === 1) return `vs ${s.y}`;
  if (months !== null) {
    return s.y === e.y
      ? `vs ${MONTH_ABBR[s.m - 1]}–${MONTH_ABBR[e.m - 1]} ${e.y}`
      : `vs ${monthLongLabel(w.start.slice(0, 7))} – ${monthLongLabel(w.end.slice(0, 7))}`;
  }
  return `vs ${spanLabel(w.start, w.end, currentYear)}`;
}

/**
 * The comparison window for the header range + `cmp` URL key. Thin adapter
 * over the single shared implementation (db/compare-window.ts
 * computeCompareWindow): resolve the URL's preset to its PERIOD, then let the
 * shared math pick the prior window. `ytd` is the in-progress calendar year,
 * so it compares the same elapsed days of the prior year (Jan 1 – today's
 * date last year), not the N days before Jan 1.
 *
 * Elapsed days are measured to `asOf = min(today, coverageEnd)`: when imports
 * lag (data ends Sep 15), Sep 1–15 compares against Aug 1–15 — never the
 * whole of August against half a month of data.
 *
 * Null when `cmp` is off, `today` is malformed, or the period has not started
 * (or its data has not started yet).
 */
export function drillCompareWindow(input: {
  preset: UrlState['preset'];
  start: string | null;
  end: string | null;
  today: string;
  cmp: CompareMode | null | undefined;
  /** Last imported transaction date (coverage end); null/absent = unknown. */
  coverageEnd?: string | null;
}): DrillCompare | null {
  if (input.cmp !== 'prev' && input.cmp !== 'yoy') return null;
  if (!isValidYmd(input.today)) return null;
  const [y, m, d] = input.today.split('-').map(Number);
  const range = resolveDateRange(input, new Date(y, m - 1, d));
  const period = {
    start: range.startDate,
    end: input.preset === 'ytd' ? `${range.startDate.slice(0, 4)}-12-31` : range.endDate,
  };
  const cov = input.coverageEnd && isValidYmd(input.coverageEnd) ? input.coverageEnd : null;
  const asOf = cov && cov < input.today ? cov : input.today;
  const w = computeCompareWindow(period, input.cmp, asOf);
  if (!w) return null;
  return {
    compareStart: w.start,
    compareEnd: w.end,
    partial: w.partial,
    elapsedDays: w.elapsedDays,
    caption: compareCaption(w, Number(period.start.slice(0, 4))),
  };
}

/**
 * Delta of current spend vs the comparison window. `prev === null` (the
 * comparison window has no coverage) returns null — distinct from a $0 base,
 * which still shows Δ$ (but no Δ%).
 */
export function formatDelta(
  current: number,
  prev: number | null | undefined,
  cmp: CompareMode = 'prev',
  minBase = DELTA_PCT_MIN_BASE,
): DeltaView | null {
  if (prev == null || !Number.isFinite(prev) || !Number.isFinite(current)) return null;
  const diff = current - prev;
  const rounded = Math.round(diff);
  const direction: DeltaView['direction'] = rounded > 0 ? 'up' : rounded < 0 ? 'down' : 'flat';
  const arrow = direction === 'up' ? '▲' : direction === 'down' ? '▼' : '–';
  const dollars = direction === 'flat' ? '$0' : `${rounded > 0 ? '+' : ''}${moneyWhole(rounded)}`;
  const percent =
    Math.abs(prev) >= minBase && direction !== 'flat'
      ? `${diff > 0 ? '+' : ''}${pct((diff / Math.abs(prev)) * 100)}`
      : null;
  const text = `${arrow} ${dollars}${percent ? ` (${percent})` : ''}`;
  const absText = moneyWhole(Math.abs(rounded));
  const pctText = percent ? ` (${percent.replace(/^[+-]/, '')})` : '';
  const srText =
    direction === 'flat'
      ? `no change ${compareLabel(cmp)}`
      : `${direction} ${absText}${pctText} ${compareLabel(cmp)}`;
  const tone: DeltaView['tone'] = direction === 'up' ? 'bad' : direction === 'down' ? 'good' : 'neutral';
  return { direction, arrow, dollars, percent, text, srText, tone };
}

// ── Links ───────────────────────────────────────────────────────────────────

/**
 * '#transactions?…' keeping the global range / account / entity / cmp and the
 * given drill scope. `merchant`/`txn` survive only because they are passed
 * explicitly (a plain tab switch drops them).
 */
export function transactionsHash(
  state: UrlState,
  scope: { cat?: string | null; merchant?: string | null; txn?: number | null } = {},
): string {
  const next = withTab(state, 'transactions');
  if (scope.cat !== undefined) next.cat = scope.cat;
  next.merchant = scope.merchant ?? null;
  next.txn = scope.txn != null ? String(scope.txn) : null;
  return serializeHash(next);
}

/** Clicking a month bar: preset=custom over that calendar month (pushed). */
export function monthRangePatch(period: string): Pick<UrlState, 'preset' | 'start' | 'end'> {
  const b = monthBounds(period);
  return b ? { preset: 'custom', start: b.start, end: b.end } : { preset: 'custom', start: null, end: null };
}

/**
 * The 12-month series window, ANCHORED to the trailing 12 months ending at
 * the coverage end (falls back to today's month) — independent of the global
 * range, so the band can show where the range sits in the year. Same window
 * the server uses when /api/spending/series gets no dates
 * (db/compare-window.ts trailingMonthsWindow).
 */
export function seriesWindow(coverageEnd: string | null | undefined, today: string, months = 12) {
  const w =
    (coverageEnd ? trailingMonthsWindow(coverageEnd, months) : null) ?? trailingMonthsWindow(today, months);
  if (!w) return { startDate: today, endDate: today, startMonth: today.slice(0, 7), endMonth: today.slice(0, 7) };
  return { startDate: w.start, endDate: w.end, startMonth: w.start.slice(0, 7), endMonth: w.end.slice(0, 7) };
}

/** 'Jump to last 12 months' from the empty state (a filter change → replace). */
export function lastTwelveMonthsPatch(
  coverageEnd: string | null | undefined,
  today: string,
): Pick<UrlState, 'preset' | 'start' | 'end'> {
  const w = seriesWindow(coverageEnd, today);
  return { preset: 'custom', start: w.startDate, end: w.endDate };
}

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function monthShortLabel(period: string): string {
  const m = Number(period.slice(5, 7));
  return MONTH_ABBR[m - 1] ?? period;
}

export function monthLongLabel(period: string): string {
  const m = Number(period.slice(5, 7));
  return `${MONTH_ABBR[m - 1] ?? '?'} ${period.slice(0, 4)}`;
}

/** Height (% of the plot) of the hatched 'no data' placeholder strip. */
export const NO_DATA_STRIP_PCT = 12;
/** Smallest visible height (%) of a covered month with spend. */
export const MIN_BAR_PCT = 2;

export interface SeriesBar {
  period: string;
  /** 'Sep'. */
  label: string;
  /** Axis tick: the year is added at January and on the first tick ('Jan ’26'). */
  axisLabel: string;
  /** null = month outside coverage (no data); 0 = covered, no spend. */
  value: number | null;
  noData: boolean;
  /** Month overlaps the active global range. */
  inRange: boolean;
  /**
   * The coverage-end month when the data stops before its last day: drawn
   * outlined/lighter and left out of the average.
   */
  partial: boolean;
  /**
   * Bar height as % of the plot: covered months scale to the max (at least
   * MIN_BAR_PCT when non-zero; 0 → a 1px baseline); no-data months are a short
   * NO_DATA_STRIP_PCT hatched strip — never a full-height bar.
   */
  heightPct: number;
  /** The tallest covered month (direct-labelled). */
  isMax: boolean;
  /** value − average (null for no-data months or no average). */
  vsAverage: number | null;
}

/** "’26" for 2026. */
function shortYear(period: string): string {
  return `’${period.slice(2, 4)}`;
}

/**
 * View model for the 12-month bars: active-range band, short hatched no-data
 * strips, the partial coverage-end month, and the trailing average over
 * COVERED, COMPLETE months only (nulls and the partial month skipped, zeros
 * counted).
 */
export function buildSeriesBars(
  series: Pick<SeriesResponse, 'periods' | 'values'> | null | undefined,
  range: { startDate: string; endDate: string },
  opts: { coverageEnd?: string | null } = {},
): { bars: SeriesBar[]; average: number | null; max: number } {
  if (!series) return { bars: [], average: null, max: 0 };
  const coverageEnd = opts.coverageEnd && isValidYmd(opts.coverageEnd) ? opts.coverageEnd : null;
  const partialMonth =
    coverageEnd && coverageEnd < (monthBounds(coverageEnd.slice(0, 7))?.end ?? coverageEnd)
      ? coverageEnd.slice(0, 7)
      : null;
  const rangeStartMonth = range.startDate.slice(0, 7);
  const rangeEndMonth = range.endDate.slice(0, 7);

  const base = series.periods.map((period, i) => {
    const raw = series.values[i];
    const value = raw == null || !Number.isFinite(raw) ? null : raw;
    return { period, value, partial: value !== null && period === partialMonth };
  });
  const covered = base.filter((b) => b.value !== null);
  const max = covered.reduce((m, b) => Math.max(m, b.value as number), 0);
  const complete = covered.filter((b) => !b.partial);
  const average = complete.length ? complete.reduce((s, b) => s + (b.value as number), 0) / complete.length : null;
  const maxIndex = max > 0 ? base.findIndex((b) => b.value === max) : -1;

  const bars = base.map(({ period, value, partial }, i) => {
    const label = monthShortLabel(period);
    return {
      period,
      label,
      axisLabel: i === 0 || period.slice(5, 7) === '01' ? `${label} ${shortYear(period)}` : label,
      value,
      noData: value === null,
      inRange: period >= rangeStartMonth && period <= rangeEndMonth,
      partial,
      heightPct:
        value === null ? NO_DATA_STRIP_PCT : value > 0 && max > 0 ? Math.max(MIN_BAR_PCT, (value / max) * 100) : 0,
      isMax: i === maxIndex,
      // A partial month vs a full-month average is meaningless (and it is
      // already excluded from the average itself).
      vsAverage: value !== null && average !== null && !partial ? value - average : null,
    };
  });
  return { bars, average, max };
}

/** '+$120' / '-$80' / '$0'. */
export function signedMoney(n: number): string {
  const r = Math.round(n);
  if (r === 0) return '$0';
  return `${r > 0 ? '+' : ''}${moneyWhole(r)}`;
}

/** Where the month tooltip sits: centered on the bar, pinned to an edge near the ends. */
export function tooltipAnchor(index: number, count: number): { leftPct: number; align: 'start' | 'center' | 'end' } {
  if (count <= 0) return { leftPct: 50, align: 'center' };
  const i = Math.min(Math.max(0, index), count - 1);
  const leftPct = ((i + 0.5) / count) * 100;
  const align = i < 2 ? 'start' : i >= count - 2 ? 'end' : 'center';
  return { leftPct, align };
}

/** Tooltip content for one month bar. */
export function monthTooltip(
  bar: SeriesBar,
  opts: { coverageEnd?: string | null; count?: number | null } = {},
): { title: string; value: string; lines: string[] } {
  const title = monthLongLabel(bar.period);
  if (bar.noData) return { title, value: 'No data', lines: ['No imported statements'] };
  const lines: string[] = [];
  if (bar.vsAverage !== null) lines.push(`vs avg ${signedMoney(bar.vsAverage)}`);
  if (bar.inRange) lines.push('In selected range');
  if (bar.partial) {
    lines.push(opts.coverageEnd ? `Partial month (data through ${shortDate(opts.coverageEnd)})` : 'Partial month');
  }
  if (opts.count != null) lines.push(txnCountLabel(opts.count));
  return { title, value: money(bar.value ?? 0), lines };
}

/** Accessible name of one month bar button. */
export function monthBarAria(bar: SeriesBar): string {
  const name = monthLongLabel(bar.period);
  if (bar.noData) return `${name}: no data`;
  const parts = [`${name}: ${money(bar.value ?? 0)}`];
  if (bar.partial) parts.push('partial month');
  if (bar.vsAverage !== null) parts.push(`${signedMoney(bar.vsAverage)} vs average`);
  if (bar.inRange) parts.push('in the selected range');
  return `${parts.join(', ')}. Show this month`;
}

/** The 12-month series as a table (the Table toggle / screen-reader view). */
export function seriesTableData(
  bars: readonly SeriesBar[],
  average: number | null,
  caption: string,
): ChartTableData {
  return {
    caption: average !== null ? `${caption} Average ${moneyWhole(average)} a month over complete months.` : caption,
    columns: [{ label: 'Month' }, { label: 'Spent', numeric: true }, { label: 'vs avg', numeric: true }, { label: 'Note' }],
    rows: bars.map((b) => [
      monthLongLabel(b.period),
      b.noData ? 'No data' : money(b.value ?? 0),
      b.vsAverage !== null ? signedMoney(b.vsAverage) : '—',
      [b.partial ? 'Partial month' : '', b.inRange ? 'In selected range' : ''].filter(Boolean).join(', '),
    ]),
  };
}

/** Δ cell text for a table: '+$20 (+20%)', 'no prior data', or '—'. */
export function deltaCell(current: number, prev: number | null | undefined, cmp: CompareMode): string {
  if (prev === undefined) return '—';
  const d = formatDelta(current, prev, cmp);
  if (!d) return 'no prior data';
  return `${d.dollars}${d.percent ? ` (${d.percent})` : ''}`;
}

/**
 * A breakdown level as a table: every rendered row PLUS the folded row, so
 * the rows sum to the period total; a Δ column when a comparison is on.
 */
export function breakdownTableData(input: {
  rows: readonly BreakdownRow[];
  more: MoreRow | null;
  /** Folded-row label ('4 more categories', 'Other merchants (9)'). */
  moreText?: string;
  total: number;
  /** Comparison mode when the comparison is on, else null. */
  cmp: CompareMode | null;
  firstColumn: string;
  caption?: string;
}): ChartTableData {
  const { rows, more, total, cmp } = input;
  const columns: ChartTableData['columns'] = [
    { label: input.firstColumn },
    { label: 'Spent', numeric: true },
    { label: 'Share', numeric: true },
    { label: 'Txns', numeric: true },
  ];
  if (cmp) columns.push({ label: 'Change', numeric: true });
  const body: (string | number)[][] = rows.map((r) => {
    const cells: (string | number)[] = [r.label, money(r.total), shareLabel(r.total, total), r.count];
    if (cmp) cells.push(deltaCell(r.total, r.prevTotal, cmp));
    return cells;
  });
  if (more && (more.total > 0 || more.groups > 0)) {
    const cells: (string | number)[] = [input.moreText ?? more.label, money(more.total), shareLabel(more.total, total), more.count];
    if (cmp) cells.push('—');
    body.push(cells);
  }
  return { caption: input.caption, columns, rows: body };
}

// ── 'N more' expansion paging ───────────────────────────────────────────────

export const EXPAND_PAGE_SIZE = 100;
export const EXPAND_ROW_CAP = 200;

/**
 * Next page to fetch when expanding the folded rows, or null when every
 * group (up to the render cap) is loaded.
 */
export function nextExpandPage(
  loaded: number,
  totalGroups: number,
  pageSize = EXPAND_PAGE_SIZE,
  cap = EXPAND_ROW_CAP,
): { offset: number; limit: number } | null {
  const target = Math.min(totalGroups, cap);
  if (loaded >= target) return null;
  return { offset: loaded, limit: Math.min(pageSize, target - loaded) };
}

/** Rendered rows were capped: show 'see all in Transactions'. */
export function expandCapped(loaded: number, totalGroups: number, cap = EXPAND_ROW_CAP): boolean {
  return loaded >= cap && totalGroups > cap;
}

/** Merge a fetched page into the loaded rows (dedupe by key, keep order). */
export function mergeRows(existing: readonly BreakdownRow[], page: readonly BreakdownRow[]): BreakdownRow[] {
  const seen = new Set(existing.map((r) => r.key));
  const out = [...existing];
  for (const r of page) {
    if (seen.has(r.key)) continue;
    seen.add(r.key);
    out.push(r);
  }
  return out;
}

// ── Copy ────────────────────────────────────────────────────────────────────

function formatYmd(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number);
  return `${MONTH_ABBR[m - 1] ?? '?'} ${d}, ${y}`;
}

export function shortDate(ymd: string | null | undefined): string {
  return ymd && /^\d{4}-\d{2}-\d{2}/.test(ymd) ? formatYmd(ymd.slice(0, 10)) : '—';
}

/** Empty-range copy: 'No spending in March 2026 — data through Feb 28, 2026'. */
export function emptyRangeMessage(periodLabel: string, coverageEnd: string | null | undefined): string {
  const base = `No spending in ${periodLabel}`;
  return coverageEnd ? `${base} — data through ${shortDate(coverageEnd)}` : base;
}

/** Footnote under the period total. */
export function excludedFootnote(excludedTotal: number): string | null {
  if (!(excludedTotal > 0)) return null;
  return `Excludes ${moneyWhole(excludedTotal)} in transfers & card payments`;
}

/** The level heading text. */
export function levelHeading(drill: Drill): string {
  if (drill.baseLevel === 3) return drill.merchant ?? '';
  if (drill.baseLevel === 2) return drill.cat ?? '';
  return 'Spending by category';
}

export function txnCountLabel(n: number): string {
  return `${n} ${n === 1 ? 'transaction' : 'transactions'}`;
}

/** 'See all 42 spending transactions' — the count is spend rows only. */
export function seeAllLabel(n: number): string {
  return `See all ${n.toLocaleString('en-US')} spending ${n === 1 ? 'transaction' : 'transactions'}`;
}

/** 'Categorize 12 spending transactions' (Uncategorized CTA). */
export function categorizeLabel(n: number): string {
  return `Categorize ${n.toLocaleString('en-US')} spending ${n === 1 ? 'transaction' : 'transactions'}`;
}

// ── Focus fallback ──────────────────────────────────────────────────────────

/**
 * After going up, focus waits for the row of the level just left. Once the
 * level's rows have rendered (data settled) and that row is NOT among them —
 * e.g. a category reached through the expanded 'N more' list, which collapses
 * on the way back — focus moves to the 'N more' control when there is one,
 * else stays on the heading. Returns the key to focus, 'heading', or null
 * when nothing is pending / the row is there (registration already focused it).
 */
export function settledFocusKey(
  pendingKey: string | null,
  isRendered: (key: string) => boolean,
): string | 'heading' | null {
  if (pendingKey == null || isRendered(pendingKey)) return null;
  return isRendered(MORE_KEY) ? MORE_KEY : 'heading';
}

// ── History entries the drill pushed ────────────────────────────────────────

/** history.state key marking a txn-drawer entry this app pushed. */
export const DRILL_TXN_STATE_KEY = 'wilsonDrillTxn';

/**
 * history.state for a pushed entry: the previous entry's state WITHOUT its
 * drawer marker (a marker belongs to one entry), plus this entry's marker
 * when it opens the drawer for `txnId`.
 */
export function pushedHistoryState(prev: unknown, txnId: number | null): Record<string, unknown> | null {
  const base: Record<string, unknown> =
    prev && typeof prev === 'object' && !Array.isArray(prev) ? { ...(prev as Record<string, unknown>) } : {};
  delete base[DRILL_TXN_STATE_KEY];
  if (txnId != null) base[DRILL_TXN_STATE_KEY] = txnId;
  return Object.keys(base).length ? base : null;
}

/**
 * True when the current history entry is a drawer entry this app pushed for
 * `txnId` — closing then goes Back (no duplicate L3 entry). The mark lives in
 * history.state, so it survives Back → Forward (a ref would not).
 */
export function isAppPushedTxnEntry(state: unknown, txnId: number | null): boolean {
  if (txnId == null || !state || typeof state !== 'object') return false;
  return (state as Record<string, unknown>)[DRILL_TXN_STATE_KEY] === txnId;
}
