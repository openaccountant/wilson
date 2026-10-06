/**
 * Question shapes a SINGLE read-tool call (and so a single deterministic template) cannot express
 * (specs/DECISIONS.md "Round 3", "Empty results"): what-if, comparison, trend and multi-period phrasing.
 * Such questions hand off to the server agent, which can call several tools and reason over them.
 *
 * PURE and total: a function of the question text only (no model, config or mirror call). A false
 * positive costs a server round trip; a false negative lets a template answer a different question
 * than the one asked (the Round-2 "forecast without golf dues answered as a plain forecast" defect).
 */

export type ComparisonKind = 'what-if' | 'comparison' | 'trend' | 'multi-period';

/** Phrases that contain a comparison word but are ONE tool call by design (profit_loss). */
const SINGLE_CALL_PHRASES: readonly RegExp[] = [
  /\bincome\s+(?:vs\.?|versus|minus|and)\s+expenses?\b/g,
  /\b(?:make|earn)\s+(?:vs\.?|versus)\s+spend(?:ing)?\b/g,
];

const WHAT_IF = /\bwhat\s+if\b|\bwithout\b|\bif\s+(?:i|we|my|our)\b|\bsuppose\b|\bassuming\b|\bwhat\s+happens\s+if\b|\binstead\s+of\b/;

const COMPARISON: readonly RegExp[] = [
  /(?:^|\s)(?:vs\.?|versus)(?=\s|$)/,
  /\bcompar(?:e|ed|es|ing|ison|isons)\b/,
  /\bthan\s+(?:last|previous|prior|usual|normal|average|before|expected|typical|ever)\b/,
  /\b(?:up|down|changed?|differ(?:ent|s|ence)?|increased?|decreased?|grew|dropped|rose)\s+(?:from|since)\b/,
  /\bdifference\s+between\b/,
  /\bsince\s+last\b/,
  /\brelative\s+to\b/,
];

const TREND = /\btrend(?:s|ing|ed)?\b|\bover\s+time\b|\b(?:year|month|quarter|week)\s+(?:over|on)\s+(?:year|month|quarter|week)\b|\b(?:yoy|mom|qoq)\b|\btrajectory\b|\bgrowth\b/;

const COUNT_WORDS = 'two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|few|several|couple(?:\\s+of)?';
const MULTI_PERIOD: readonly RegExp[] = [
  new RegExp(`\\b(?:last|past|previous|prior|recent)\\s+(?:(\\d+)|(${COUNT_WORDS}))\\s+(?:months|quarters|years)\\b`),
  /\b(?:month|quarter)\s+by\s+(?:month|quarter)\b|\beach\s+(?:month|quarter)\b/,
];

function normalise(question: string): string {
  return question
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/(?<=[a-z])-(?=[a-z])/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The kind of single-call-inexpressible phrasing in `question`, or null when one tool call can answer it. */
export function detectComparisonIntent(question: string): ComparisonKind | null {
  try {
    if (typeof question !== 'string') return null;
    let q = normalise(question);
    if (!q) return null;
    for (const phrase of SINGLE_CALL_PHRASES) q = q.replace(phrase, ' ');
    q = q.replace(/\s+/g, ' ');

    if (WHAT_IF.test(q)) return 'what-if';
    if (COMPARISON.some((re) => re.test(q))) return 'comparison';
    if (TREND.test(q)) return 'trend';
    for (const re of MULTI_PERIOD) {
      const m = re.exec(q);
      if (!m) continue;
      // "last 1 months" is not a series; a digit count must be at least 2.
      if (m[1] !== undefined && Number(m[1]) < 2) continue;
      return 'multi-period';
    }
    return null;
  } catch {
    return null;
  }
}
