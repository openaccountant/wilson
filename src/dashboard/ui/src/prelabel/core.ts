/**
 * open-jev pre-labeler: pure, import-free core (specs/open-jev-labeler.md §6, §7, §10.3).
 *
 * No DOM, worker, network or open-jev access, so it is shared by the main
 * thread, the worker engine and the bun tests, and typechecks under both the
 * root and the UI tsconfigs.
 *
 * `formatState` and `buildQuestion` are the spike's template
 * (`prelabel-tmpl-v1`) and must stay byte-identical to it: the spike's
 * predictions are the regression oracle. Descriptions as options collapsed
 * accuracy to 26.5% (spike §5), so options are bare labels only.
 */

// ── Template (prelabel-tmpl-v1) ─────────────────────────────────────────────

export interface PrelabelStateInput {
  description: string;
  amount: number;
  /** ISO date or datetime; only the first 10 characters (YYYY-MM-DD) are used. */
  date: string;
}

/**
 * `description: X | amount: -12.30 | date: YYYY-MM-DD`.
 * The caller must have checked that `amount` is finite (`bad_amount`) and the
 * description is non-empty (`empty_description`); this does not validate.
 */
export function formatState(t: PrelabelStateInput): string {
  return `description: ${t.description} | amount: ${t.amount.toFixed(2)} | date: ${t.date.slice(0, 10)}`;
}

export const PRELABEL_QUESTION = 'Which spending category does this transaction belong to?';

/** The question and the options for `decide()`. Options are bare label names. */
export function buildQuestion(labels: readonly string[]): { question: string; options: string[] } {
  return { question: PRELABEL_QUESTION, options: [...labels] };
}

// ── Margin ──────────────────────────────────────────────────────────────────

export interface TopTwo {
  top2: [[string, number], [string, number]];
  p1: number;
  p2: number;
  /** p1 - p2 over the calibrated probabilities (spike definition, harness/web/main.js:69). */
  margin: number;
}

/** The two most probable options, best first; ties keep insertion order. Null if fewer than two. */
export function topTwo(probabilities: Readonly<Record<string, number>>): TopTwo | null {
  const sorted = Object.entries(probabilities)
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => b.entry[1] - a.entry[1] || a.index - b.index)
    .map((e) => e.entry);
  if (sorted.length < 2) return null;
  const [first, second] = sorted;
  return { top2: [[first[0], first[1]], [second[0], second[1]]], p1: first[1], p2: second[1], margin: first[1] - second[1] };
}

/** p1 - p2 over `answer.probabilities`. With a single option p2 is 0, as in the spike. */
export function marginOf(probabilities: Readonly<Record<string, number>>): number {
  const t = topTwo(probabilities);
  if (t) return t.margin;
  const only = Object.values(probabilities)[0];
  return only === undefined ? 0 : only;
}

/** `.42` for 0.42, `1.00` for 1: two decimals, leading zero dropped below 1. */
export function formatMargin(margin: number): string {
  return margin.toFixed(2).replace(/^0\./, '.');
}

// ── Router and lanes (§6) ───────────────────────────────────────────────────

/** Per-profile default of the `prelabelMarginCut` setting. Re-checked by S6. */
export const DEFAULT_MARGIN_CUT = 0.3;

/** The slice of a worker result the router needs (PrelabelResult satisfies it structurally). */
export type LaneResult = { ok: true; choice: string; margin: number } | { ok: false };

export type Lane = 'ATTENTION' | 'QUICK';
export type LaneKind = 'none' | 'skipped' | 'unsure' | 'agrees' | 'disagrees';

export interface LaneRoute {
  lane: Lane;
  kind: LaneKind;
  /** B1-a chip text. A disagreeing chip never names open-jev's category (§2). */
  chip: string;
}

/**
 * Route one pending review row (B1-a column of the §6 table).
 *
 * `suggested` is the stored LLM suggestion. A missing suggestion can never
 * agree, so a confident result for it lands in DISAGREES (the literal
 * `choice !== suggested` row; B1-c, which would treat it differently, is parked).
 */
export function routeLane(suggested: string | null | undefined, result: LaneResult | undefined, marginCut: number): LaneRoute {
  if (!result) return { lane: 'ATTENTION', kind: 'none', chip: 'JEV —' };
  if (!result.ok) return { lane: 'ATTENTION', kind: 'skipped', chip: 'JEV SKIPPED' };
  if (result.margin < marginCut) {
    return { lane: 'ATTENTION', kind: 'unsure', chip: `JEV UNSURE · M ${formatMargin(result.margin)}` };
  }
  if (suggested != null && result.choice === suggested) {
    return { lane: 'QUICK', kind: 'agrees', chip: `JEV AGREES · M ${formatMargin(result.margin)}` };
  }
  return { lane: 'ATTENTION', kind: 'disagrees', chip: 'JEV DISAGREES' };
}

export interface LaneEntry<T> {
  item: T;
  route: LaneRoute;
}

/** Rank inside ATTENTION: DISAGREES, then UNSURE, then not-yet-scored (none and skipped). */
const ATTENTION_RANK: Record<LaneKind, number> = { disagrees: 0, unsure: 1, none: 2, skipped: 2, agrees: 3 };

/**
 * Stable, pure ordering. ATTENTION before QUICK. Inside ATTENTION: DISAGREES
 * (input order), UNSURE by ascending margin, then not-yet-scored/skipped
 * (input order). Inside QUICK: descending margin. With no results every row is
 * `none`, so the server order is returned unchanged.
 */
export function orderByLane<T extends { transaction_id: number; suggested_category: string }>(
  items: readonly T[],
  results: ReadonlyMap<number, LaneResult>,
  marginCut: number,
): LaneEntry<T>[] {
  const margin = (r: LaneResult | undefined) => (r && r.ok ? r.margin : 0);
  return items
    .map((item, index) => {
      const result = results.get(item.transaction_id);
      return { item, route: routeLane(item.suggested_category, result, marginCut), index, margin: margin(result) };
    })
    .sort((a, b) => {
      if (a.route.lane !== b.route.lane) return a.route.lane === 'ATTENTION' ? -1 : 1;
      if (a.route.lane === 'QUICK') return b.margin - a.margin || a.index - b.index;
      const ra = ATTENTION_RANK[a.route.kind];
      const rb = ATTENTION_RANK[b.route.kind];
      if (ra !== rb) return ra - rb;
      if (a.route.kind === 'unsure') return a.margin - b.margin || a.index - b.index;
      return a.index - b.index;
    })
    .map(({ item, route }) => ({ item, route }));
}

// ── Cache key (§7) ──────────────────────────────────────────────────────────

export interface CacheKeyParts {
  profile: string;
  labelSetVersion: string;
  modelId: string;
  revision: string;
  templateVersion: string;
}

/** sessionStorage key for cached scores of one {profile, label set, model, pin, template}. */
export function cacheKey(p: CacheKeyParts): string {
  return `wilson-prelabel:v1:${p.profile}:${p.labelSetVersion}:${p.modelId}:${p.revision}:${p.templateVersion}`;
}

// ── Throughput estimate (§7) ────────────────────────────────────────────────

/** Warm, bare-label, q4f16 decision time on the spike's M4 Pro: p50 across two runs. */
const SPIKE_MS_PER_ROW_LOW = 67;
const SPIKE_MS_PER_ROW_HIGH = 86;
/** Run-to-run noise measured by the spike. */
const SPIKE_NOISE = 0.25;

/** Decision time for `rows` rows (excludes model load): optimistic, midpoint and noisy-pessimistic. */
export function estimateRunMs(rows: number): { lowMs: number; expectedMs: number; highMs: number } {
  if (!Number.isFinite(rows) || rows <= 0) return { lowMs: 0, expectedMs: 0, highMs: 0 };
  return {
    lowMs: rows * SPIKE_MS_PER_ROW_LOW,
    expectedMs: rows * ((SPIKE_MS_PER_ROW_LOW + SPIKE_MS_PER_ROW_HIGH) / 2),
    highMs: rows * SPIKE_MS_PER_ROW_HIGH * (1 + SPIKE_NOISE),
  };
}

// ── Measurement (S6, spec §10.2 MeasurePanel) ───────────────────────────────

/** Margin cuts the measurement panel evaluates (policy §4 table columns). */
export const MEASURE_CUTS: readonly number[] = [0.1, 0.2, 0.3, 0.5, 0.7];

/** Below this many rows the panel shows a "small n" warning. */
export const SMALL_N_WARNING_BELOW = 200;

/** One scored, human-labelled row. */
export interface MeasureRow {
  label: string;
  pred: string;
  margin: number;
}

export interface RoutingRow {
  cut: number;
  /** Rows with margin >= cut (what open-jev would be trusted with). */
  auto: number;
  autoCorrect: number;
  /** autoCorrect / auto; null when nothing clears the cut. */
  autoAccuracy: number | null;
  autoShare: number;
  reviewShare: number;
}

export interface RoutingTable {
  n: number;
  correct: number;
  accuracy: number;
  rows: RoutingRow[];
}

/** auto-share, auto-accuracy, review-share at each cut (policy §4, classifier-label-policy.md:209-211). */
export function routingTable(rows: readonly MeasureRow[], cuts: readonly number[] = MEASURE_CUTS): RoutingTable {
  const n = rows.length;
  const correct = rows.filter((r) => r.pred === r.label).length;
  return {
    n,
    correct,
    accuracy: n === 0 ? 0 : correct / n,
    rows: cuts.map((cut) => {
      const kept = rows.filter((r) => r.margin >= cut);
      const autoCorrect = kept.filter((r) => r.pred === r.label).length;
      return {
        cut,
        auto: kept.length,
        autoCorrect,
        autoAccuracy: kept.length === 0 ? null : autoCorrect / kept.length,
        autoShare: n === 0 ? 0 : kept.length / n,
        reviewShare: n === 0 ? 0 : (n - kept.length) / n,
      };
    }),
  };
}

/** Nearest-rank percentile of an unsorted list; 0 when empty. */
export function percentileOf(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil(p * sorted.length)));
  return sorted[rank - 1];
}

export interface MeasuredRow extends MeasureRow {
  txnId: number;
  p1: number;
  p2: number;
  ms: number;
}

export interface MeasureReport {
  n: number;
  smallN: boolean;
  p50Ms: number;
  p95Ms: number;
  table: RoutingTable;
  /** `{txnId, label, pred, p1, p2, margin, ms}` only: no descriptions, merchants or amounts. */
  rows: MeasuredRow[];
  context?: { modelId: string; labelSetVersion: string; revision: string; templateVersion: string };
}

/** The downloadable measurement file. Picks fields explicitly so it can never carry ledger text. */
export function buildMeasureReport(
  results: readonly MeasuredRow[],
  opts: { p50Ms: number; p95Ms: number; context?: MeasureReport['context'] },
): MeasureReport {
  const rows = results.map((r) => ({
    txnId: r.txnId,
    label: r.label,
    pred: r.pred,
    p1: r.p1,
    p2: r.p2,
    margin: r.margin,
    ms: r.ms,
  }));
  return {
    n: rows.length,
    smallN: rows.length < SMALL_N_WARNING_BELOW,
    p50Ms: opts.p50Ms,
    p95Ms: opts.p95Ms,
    table: routingTable(rows),
    rows,
    ...(opts.context ? { context: opts.context } : {}),
  };
}
