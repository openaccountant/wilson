/**
 * Pure scorer for the browser-subagent go/no-go (spec D3, DECISIONS Q8/Q9,
 * slice 8). No product code: it only turns per-row run records into the bars.
 * Pinned by src/__tests__/subagent-route-score.test.ts; produced by
 * scripts/subagent-route-eval.mjs.
 *
 * Record: { q, expect, denylist?, mutation?, gate, hits, route, via, outcome,
 *           reason, rows?, ms? }
 *   gate     'route' | 'mutation-intent' | 'non-data'     (gateQuestion)
 *   hits     keywordRoute() output
 *   route    first tool chosen (keyword or llm); 'none' when the router said
 *            none; null when the run never reached the router
 *   outcome  'answer' | 'handoff' | 'bundle-fallback' | 'cancelled'
 *   reason   handoff reason when outcome is 'handoff'
 *   rows     transaction_search row count when a search ran
 *   ms       time to handoff (send -> handoff decision), warm model
 *   denylist true iff the question contains a MUTATION_VERB (mutation rows only)
 *   mutation true iff the row is a mutation request (held-out none rows 1-21)
 */

export const LABELS = ['transaction_search', 'spending_summary', 'profit_loss', 'net_worth', 'forecast', 'none'];

/** The Q8 / D3 bars as amended by the critic ([C3], [C4], [C15]). */
export const BARS = {
  divertedMinPct: 95,
  routedMinPct: 90,
  falselyGatedMaxPct: 10,
  c4MinRows: 15,
  p95MaxMs: 2000,
};

/** Nearest-rank percentile; null for an empty list. */
export function percentile(values, p) {
  if (!values.length) return null;
  const xs = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * xs.length);
  return xs[Math.min(xs.length, Math.max(1, rank)) - 1];
}

export function parseJsonl(text) {
  const rows = [];
  text.split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    const r = JSON.parse(line);
    if (typeof r.q !== 'string' || !LABELS.includes(r.expect)) throw new Error(`bad row at line ${i + 1}: ${line.slice(0, 80)}`);
    rows.push(r);
  });
  return rows;
}

const pct = (n, d) => (d === 0 ? null : (100 * n) / d);

/** A none row is diverted when it never reached a read tool. */
const diverted = (r) => r.gate !== 'route' || r.route === 'none' || r.route === null;

function handoffPath(r) {
  if (r.gate !== 'route') return 'gated';
  if (r.route === 'none' || r.reason === 'router-none' || r.reason === 'router-invalid') return 'router-none';
  if (r.reason === 'args-unfillable') return 'args-unfillable';
  return null;
}

export function scoreSet(records) {
  const read = records.filter((r) => r.expect !== 'none');
  const none = records.filter((r) => r.expect === 'none');

  const routedCorrect = read.filter((r) => r.gate === 'route' && r.route === r.expect).length;
  const falselyGated = read.filter((r) => r.gate !== 'route').length;
  const routedWrong = read.filter((r) => r.gate === 'route' && r.route !== r.expect && r.route !== 'none' && r.route !== null).length;
  const routedNone = read.filter((r) => r.gate === 'route' && (r.route === 'none' || r.route === null)).length;
  const nDiverted = none.filter(diverted).length;

  const confusion = {};
  for (const r of records) {
    const got = r.gate !== 'route' ? 'gated' : (r.route ?? 'unrouted');
    confusion[r.expect] ??= {};
    confusion[r.expect][got] = (confusion[r.expect][got] ?? 0) + 1;
  }

  // C4: mutation requests that use none of the denylist verbs
  const c4Rows = none.filter((r) => r.mutation && r.denylist === false);
  const c4Div = c4Rows.filter(diverted).length;

  // C3: every transaction_search-expected row, as routed by the pipeline
  const ts = records.filter((r) => r.expect === 'transaction_search' && r.gate === 'route' && r.route === 'transaction_search');
  const c3 = {
    n: ts.length,
    withRows: ts.filter((r) => typeof r.rows === 'number' && r.rows >= 1).length,
    emptyResult: ts.filter((r) => r.reason === 'empty-result').length,
    argsUnfillable: ts.filter((r) => r.reason === 'args-unfillable').length,
    localAnswerOnEmpty: ts.filter((r) => r.outcome === 'answer' && (r.rows === 0 || r.rows === undefined)).length,
  };
  c3.other = c3.n - c3.withRows - c3.emptyResult - c3.argsUnfillable;
  c3.pass = c3.localAnswerOnEmpty === 0;

  // C15: time to handoff on gated, router-none and args-unfillable paths
  const byPath = {};
  const all = [];
  for (const r of records) {
    const path = handoffPath(r);
    if (!path || typeof r.ms !== 'number') continue;
    (byPath[path] ??= { n: 0, values: [] }).values.push(r.ms);
    byPath[path].n++;
    all.push(r.ms);
  }
  for (const v of Object.values(byPath)) {
    v.p50 = percentile(v.values, 50);
    v.p95 = percentile(v.values, 95);
    v.max = Math.max(...v.values);
    delete v.values;
  }
  const c15 = { n: all.length, p50: percentile(all, 50), p95: percentile(all, 95), max: all.length ? Math.max(...all) : null, byPath };
  c15.pass = c15.p95 !== null && c15.p95 <= BARS.p95MaxMs;

  // Fallback policy from D3: keyword single-hit only, otherwise handoff.
  const kwRoute = (r) => (r.gate === 'route' && r.hits.length === 1 ? r.hits[0] : null);
  const keywordOnly = {
    read: { n: read.length, routedCorrect: read.filter((r) => kwRoute(r) === r.expect).length },
    none: { n: none.length, diverted: none.filter((r) => kwRoute(r) === null).length },
  };
  keywordOnly.read.routedCorrectPct = pct(keywordOnly.read.routedCorrect, read.length);
  keywordOnly.none.divertedPct = pct(keywordOnly.none.diverted, none.length);
  keywordOnly.read.falselyGatedPct = pct(falselyGated, read.length);

  return {
    n: records.length,
    read: {
      n: read.length,
      routedCorrect,
      routedCorrectPct: pct(routedCorrect, read.length),
      falselyGated,
      falselyGatedPct: pct(falselyGated, read.length),
      routedWrong,
      routedNone,
    },
    none: { n: none.length, diverted: nDiverted, divertedPct: pct(nDiverted, none.length), misrouted: none.filter((r) => !diverted(r)).map((r) => r.q) },
    confusion,
    c4: { n: c4Rows.length, diverted: c4Div, pass: c4Rows.length > 0 && c4Div === c4Rows.length, enoughRows: c4Rows.length >= BARS.c4MinRows },
    c3,
    c15,
    keywordOnly,
  };
}

/** Pass/fail per bar for one set's score. null metrics (no rows) fail. */
export function verdict(s) {
  const ge = (v, min) => v !== null && v >= min;
  const le = (v, max) => v !== null && v <= max;
  const bars = {
    divertedGe95: ge(s.none.divertedPct, BARS.divertedMinPct),
    routedGe90: ge(s.read.routedCorrectPct, BARS.routedMinPct),
    falselyGatedLe10: le(s.read.falselyGatedPct, BARS.falselyGatedMaxPct),
    c4AllDiverted: s.c4.pass && s.c4.enoughRows,
    c3NoLocalAnswerOnEmpty: s.c3.pass,
    c15P95Le2s: s.c15.pass,
  };
  return { bars, allPass: Object.values(bars).every(Boolean) };
}

// ── Round 2: precision-first bars (specs/DECISIONS.md "Round 2") ─────────────
//
// These REPLACE the D3 / Q8 bars above for the next go/no-go. The old scoreSet()/verdict()
// stay for the burned v1 data and the visible gold set. Record additions:
//   answerOk  true/false: a human or rubric grader's verdict on the local answer's
//             content (every figure right, nothing contradicting the data). Never inferred.
//   useless   true when the answer is technically right but does not address the question.

export const ROUND2_BARS = {
  divertedMinPct: 95,
  c4MinRows: 15,
  precisionMinPct: 97,
  wrongOrUselessMaxPct: 3,
  coverageTargetPct: 35, // informational, not a gate
  p95MaxMs: 2000,
};

/** A locally answered row is good iff the tool is right AND the answer is graded correct and useful. */
const isGood = (r) => r.expect !== 'none' && r.route === r.expect && r.answerOk === true && r.useless !== true;

export function scoreRound2(records) {
  const base = scoreSet(records);
  const read = records.filter((r) => r.expect !== 'none');
  const answered = records.filter((r) => r.outcome === 'answer');
  const ungraded = answered.filter((r) => typeof r.answerOk !== 'boolean').length;
  const good = answered.filter(isGood).length;
  const wrongOrUseless = answered.length - good;
  const gradedAll = answered.length > 0 && ungraded === 0;
  const readAnswered = read.filter((r) => r.outcome === 'answer').length;
  return {
    base,
    local: {
      answered: answered.length,
      good,
      wrongOrUseless,
      ungraded,
      // null until every local answer is graded: ungraded answers are never assumed correct.
      precisionPct: gradedAll ? pct(good, answered.length) : null,
      wrongOrUselessPct: gradedAll ? pct(wrongOrUseless, answered.length) : null,
    },
    coverage: { readRows: read.length, answeredLocally: readAnswered, pct: pct(readAnswered, read.length) },
  };
}

export function verdictRound2(s) {
  const ge = (v, min) => v !== null && v >= min;
  const le = (v, max) => v !== null && v <= max;
  const bars = {
    allLocalAnswersGraded: s.local.answered > 0 && s.local.ungraded === 0,
    divertedGe95: ge(s.base.none.divertedPct, ROUND2_BARS.divertedMinPct),
    c4AllDiverted: s.base.c4.pass && s.base.c4.n >= ROUND2_BARS.c4MinRows,
    precisionGe97: ge(s.local.precisionPct, ROUND2_BARS.precisionMinPct),
    wrongOrUselessLe3: le(s.local.wrongOrUselessPct, ROUND2_BARS.wrongOrUselessMaxPct),
    p95Le2s: s.base.c15.p95 !== null && s.base.c15.p95 <= ROUND2_BARS.p95MaxMs,
  };
  return {
    bars,
    allPass: Object.values(bars).every(Boolean),
    coverageMetTarget: ge(s.coverage.pct, ROUND2_BARS.coverageTargetPct),
  };
}
