/**
 * Round 4 (specs/browser-subagent-round4-openjev-router.md §5): choose the open-jev route
 * margin cut on DEV data only. Pure functions, unit tested in
 * src/__tests__/subagent-openjev-cut.test.ts, plus the harness guard that refuses an
 * arm-O run on the current held-out set without the frozen hash.
 *
 * Dev sets (DECISIONS Round 4: all burned, or never held out): heldout-router.v1-burned,
 * v2 and v3, and the spike route set (src/__tests__/fixtures/subagent-route-gold.json).
 * The current held-out set (heldout-router.v4 and later) is never read by this module.
 *
 * Population A: dev rows that pass the round-4 gate (gateQuestion route, no what-if /
 * comparison / trend shape) and get 0 or 2+ keyword hits. Each A record carries
 * { q, label (expected tool, or 'none' / 'mutation'), source, hits, top1, p1, p2, margin }.
 *
 * Procedure (pre-registered):
 *  1. candidate cuts c in {0.05, 0.10, ..., 0.95};
 *  2. S(c) = A rows with margin >= c that pass the multi-hit consistency rule;
 *  3. P(c) = read rows in S(c) whose top1 equals the label / |S(c)| (a none or mutation row is an error);
 *  4. L(c) = none / mutation rows in S(c);
 *  5. choose the smallest c with P(c) >= 0.97, L(c) = 0, |S(c)| >= 20, and P(c') >= 0.97 and
 *     L(c') = 0 for every c' >= c in the grid (an empty S(c') answers nothing, so it makes no
 *     error and passes);
 *  6. if no c qualifies: null (the caller runs the bare-label fallback once, then disables arm O).
 */
import { createHash } from 'node:crypto';
import { basename } from 'node:path';

export const READ_LABELS = ['transaction_search', 'spending_summary', 'profit_loss', 'net_worth', 'forecast'];

/** 0.05 .. 0.95 in 0.05 steps, exact two-decimal values. */
export const CUT_GRID = Array.from({ length: 19 }, (_, i) => Math.round((i + 1) * 5) / 100);

export const MIN_PRECISION = 0.97;
export const MIN_SELECTED = 20;

export function normalizeQuestion(q) {
  return String(q ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Rows from several sets, deduplicated by normalized question; a duplicate keeps its first label (set order). */
export function dedupeDevRows(sets) {
  const seen = new Set();
  const out = [];
  for (const set of sets) {
    for (const row of set.rows) {
      const key = normalizeQuestion(row.q);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ ...row, source: set.name });
    }
  }
  return out;
}

export function isReadLabel(label) {
  return READ_LABELS.includes(label);
}

/** Multi-hit rows need top1 among the keyword hits; 0-hit rows always pass. */
export function consistent(rec) {
  const hits = Array.isArray(rec.hits) ? rec.hits : [];
  return hits.length < 2 || hits.includes(rec.top1);
}

function selected(records, c) {
  return records.filter((r) => typeof r.margin === 'number' && Number.isFinite(r.margin) && r.margin >= c && consistent(r));
}

/** P/L/|S| for every grid cut. precision is null for an empty S(c). */
export function cutCurve(records, grid = CUT_GRID) {
  return grid.map((cut) => {
    const s = selected(records, cut);
    const correct = s.filter((r) => isReadLabel(r.label) && r.top1 === r.label).length;
    const leak = s.filter((r) => !isReadLabel(r.label)).length;
    return { cut, n: s.length, correct, wrong: s.length - correct, leak, precision: s.length ? correct / s.length : null };
  });
}

const errorFree = (p, minPrecision) => p.leak === 0 && (p.n === 0 || p.precision >= minPrecision);

/** §5 selection. Returns { cut, chosen, curve, reason }; cut null when nothing qualifies. */
export function selectCut(records, opts = {}) {
  const minPrecision = opts.minPrecision ?? MIN_PRECISION;
  const minN = opts.minN ?? MIN_SELECTED;
  const curve = cutCurve(records, opts.grid ?? CUT_GRID);
  for (let i = 0; i < curve.length; i++) {
    const p = curve[i];
    if (p.n < minN || !errorFree(p, minPrecision)) continue;
    if (!curve.slice(i).every((q) => errorFree(q, minPrecision))) continue;
    return { cut: p.cut, chosen: p, curve, reason: 'smallest stable cut' };
  }
  return { cut: null, chosen: null, curve, reason: `no viable cut on dev (need P >= ${minPrecision}, no leak, |S| >= ${minN}, stable above)` };
}

/** Wilson score interval lower bound (95% by default). */
export function wilsonLower(k, n, z = 1.96) {
  if (!n) return 0;
  const p = k / n;
  const z2 = z * z;
  const centre = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return (centre - margin) / (1 + z2 / n);
}

/**
 * Dev coverage gain at a cut: read rows of A newly routed correctly (consistent, margin >= cut,
 * top1 = label), over ALL dev read rows, overall, per tool and per source set.
 * `denominators` = { total, byTool: {tool: n}, bySource: {set: n} } (all dev read rows).
 */
export function coverageGain(records, cut, denominators) {
  const gained = cut === null ? [] : selected(records, cut).filter((r) => isReadLabel(r.label) && r.top1 === r.label);
  const byTool = {};
  for (const [tool, of] of Object.entries(denominators.byTool ?? {})) byTool[tool] = { gained: gained.filter((r) => r.label === tool).length, of };
  const bySource = {};
  for (const [src, of] of Object.entries(denominators.bySource ?? {})) bySource[src] = { gained: gained.filter((r) => r.source === src).length, of };
  return { rows: gained.length, share: denominators.total ? gained.length / denominators.total : 0, byTool, bySource };
}

/** Nearest-rank percentile of numbers (null for none). */
export function pct(xs, p) {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return null;
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
}

/** Margin histogram in 0.05 bins: { '0.00': n, '0.05': n, ... }. */
export function marginHistogram(records) {
  const h = {};
  for (let i = 0; i < 20; i++) h[(i * 0.05).toFixed(2)] = 0;
  for (const r of records) {
    if (!Number.isFinite(r.margin)) continue;
    const bin = Math.min(19, Math.max(0, Math.floor(r.margin / 0.05 + 1e-9)));
    h[(bin * 0.05).toFixed(2)]++;
  }
  return h;
}

export function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex');
}

/** heldout-router.vN with N >= 4 is the current (or a future) held-out set: locked for arm O. */
const LOCKED = /^heldout-router\.v(\d+)/;
export const FIRST_LOCKED_VERSION = 4;

export function isLockedHeldout(path) {
  const m = LOCKED.exec(basename(String(path ?? '')));
  return m !== null && Number(m[1]) >= FIRST_LOCKED_VERSION;
}

/**
 * Refuse an arm-O run on a locked held-out file unless --frozen-sha equals the sha256 of the
 * frozen JSON and the frozen cut is not null. Returns an error message, or null when allowed.
 * `frozen` = { sha, cut } of specs/eval/round4-openjev-frozen.json, or null when it is missing.
 * Stops accidental re-tuning; not a security control.
 */
export function armOGuard({ heldoutPath, frozenShaArg, frozen }) {
  if (!isLockedHeldout(heldoutPath)) return null;
  const name = basename(String(heldoutPath));
  if (!frozenShaArg) return `refusing arm O on ${name}: pass --frozen-sha <sha256 of specs/eval/round4-openjev-frozen.json>`;
  if (!frozen) return `refusing arm O on ${name}: specs/eval/round4-openjev-frozen.json is missing (freeze the dev cut first)`;
  if (frozenShaArg !== frozen.sha) return `refusing arm O on ${name}: --frozen-sha ${frozenShaArg} does not match the frozen JSON (${frozen.sha})`;
  if (frozen.cut === null || frozen.cut === undefined) return `refusing arm O on ${name}: the frozen cut is null (arm O disabled; skip this run)`;
  return null;
}
