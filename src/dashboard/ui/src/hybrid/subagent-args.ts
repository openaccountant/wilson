/**
 * Rule-based argument filling for the five READ tools (specs/browser-subagent.md
 * section 5.3).
 *
 * The LLM never writes tool arguments: a 0.6B model producing dates, category
 * names and what-if objects is the least reliable part of the loop. Instead
 * each tool has deterministic rules, and the result is validated against the
 * frozen JSON-schema snapshot (read-tool-schemas.ts). Anything the rules cannot
 * place with confidence is `unfillable` and the turn is handed to the server
 * agent: the code never guesses.
 *
 * transaction_search is special [C3]: the server parses a natural-language
 * `query` and turns EVERY residual non-stopword into a description LIKE filter,
 * so passing the raw question ("Show me every Whole Foods charge in June")
 * matches nothing. fillArgs builds a CANONICAL query from extracted parts
 * (merchant, date phrase, amount, recurring) and then proves it round-trips
 * through the same parser (read-core/nl-query) before using it.
 *
 * Pure: no DOM, no clock (the caller injects `now`), no network.
 */

import { MONTH_NAMES, parseNaturalQueryAt } from '../../../../tools/read-core/nl-query.js';
import { validateReadToolArgs } from './read-tool-schemas.js';
import type { ReadToolName } from '../store/mirror-tools.js';

export type FillResult = { ok: true; args: Record<string, unknown> } | { ok: false; why: string };

const unfillable = (why: string): FillResult => ({ ok: false, why });

// ── Number words ─────────────────────────────────────────────────────────────

const UNITS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const NUMBER_WORDS: Record<string, number> = {};
UNITS.forEach((w, i) => { if (i > 0) NUMBER_WORDS[w] = i; });
NUMBER_WORDS.twenty = 20;
for (let i = 1; i <= 4; i++) NUMBER_WORDS[`twenty-${UNITS[i]}`] = 20 + i;

const NUMBER_WORD_ALTERNATION = Object.keys(NUMBER_WORDS)
  .sort((a, b) => b.length - a.length)
  .map((w) => w.replace('-', '[- ]'))
  .join('|');
/** A count token: digits or a number word up to twenty-four. */
const COUNT = `(\\d+|${NUMBER_WORD_ALTERNATION})`;

/**
 * "three" -> 3, "twenty-four" -> 24, "12" -> 12. Words are supported up to 24;
 * zero, larger words and non-numbers are null.
 */
export function numberWordToInt(token: string): number | null {
  const t = token.trim().toLowerCase().replace(/\s+/g, '-');
  if (!t) return null;
  if (/^\d+$/.test(t)) {
    const n = parseInt(t, 10);
    return n > 0 && Number.isSafeInteger(n) ? n : null;
  }
  return Object.prototype.hasOwnProperty.call(NUMBER_WORDS, t) ? NUMBER_WORDS[t] : null;
}

// ── Text helpers ─────────────────────────────────────────────────────────────

const MONTH_FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONTH_LOOKUP: Record<string, number> = { ...MONTH_NAMES, sept: 9 };

function norm(q: string): string {
  return String(q ?? '')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface MonthHit {
  month: number;
  /** The token as written (for removal). */
  token: string;
}

/**
 * Month names in the question. "may" is also a modal verb, so it only counts
 * when capitalised in the original text or right after in/for/of/during/by.
 */
function findMonths(original: string): MonthHit[] {
  const hits: MonthHit[] = [];
  const re = /\b([A-Za-z]{3,9})\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(original)) !== null) {
    const word = m[1];
    const lower = word.toLowerCase();
    const month = MONTH_LOOKUP[lower];
    if (!month) continue;
    if (lower === 'may') {
      const before = original.slice(0, m.index).trimEnd().toLowerCase();
      const capital = word[0] === 'M';
      if (!capital && !/(?:\bin|\bfor|\bof|\bduring|\bby)$/.test(before)) continue;
      if (/(?:\bi|\bwe|\byou|\bit|\bthey|\bwhat|\bhow)$/.test(before) && !capital) continue;
    }
    // Abbreviations that are ordinary words in context are still ambiguous; accept only when
    // not immediately followed by an apostrophe-s style possessive of a longer name.
    hits.push({ month, token: word });
  }
  return hits;
}

const distinct = <T,>(xs: T[]): T[] => [...new Set(xs)];

const YEAR_NUMBER = /\b(?:19|20)\d{2}\b/;

/** Windows no tool can express exactly ("last 30 days", "yesterday", "since March"). */
const UNSUPPORTED_WINDOW: RegExp[] = [
  new RegExp(`\\b(?:last|past|previous|prior|next|recent|trailing|within)\\s+(?:${COUNT}|few|couple(?:\\s+of)?)\\s+(?:days?|weeks?|months?|quarters?|years?)\\b`, 'i'),
  /\b(?:days?|weeks?|weekly|daily|fortnight)\b/i,
  /\b(?:yesterday|today|tonight|weekend)\b/i,
  /\b(?:since|between|until|till)\b/i,
  /\b(?:before|after)\s+(?:\d|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i,
];

function hasUnsupportedWindow(text: string, original = text): boolean {
  return UNSUPPORTED_WINDOW.some((re) => re.test(text) || re.test(original)) || YEAR_NUMBER.test(text);
}

/**
 * "...compared to last month", "than the previous period": a comparison target,
 * not a period selector. Removed before period cues are read.
 */
function stripComparisons(text: string): string {
  return text.replace(
    /\b(?:compared?(?:\s+(?:to|with))?|than|versus|vs\.?|relative\s+to|against)\s+(?:the\s+)?(?:last|previous|prior)\s+(?:month|quarter|year|period)\b/g,
    ' '
  );
}

// ── Period cues (shared by spending_summary and profit_loss) ─────────────────

type PeriodUnit = 'month' | 'quarter' | 'year';
type PeriodCue = { unit: PeriodUnit; offset: number } | null | 'unsupported';

const ORDINAL_Q: Record<string, number> = { first: 1, '1st': 1, second: 2, '2nd': 2, third: 3, '3rd': 3, fourth: 4, '4th': 4 };

/**
 * Where the question points in time, relative to `now`:
 * "last/previous X" -> -1; "this/current/the X", "so far", YTD -> 0;
 * a month or quarter NAME in the current year -> its distance from now (must
 * be <= 0). Conflicting cues, windows, year numbers and future periods are
 * 'unsupported'; no cue at all is null.
 */
function periodCue(question: string, now: Date): PeriodCue {
  const original = String(question ?? '');
  const text = stripComparisons(norm(original));
  if (hasUnsupportedWindow(text, original.toLowerCase())) return 'unsupported';
  const curMonth = now.getMonth() + 1;
  const curQuarter = Math.floor((curMonth - 1) / 3) + 1;

  const cues: Array<{ unit: PeriodUnit; offset: number; weak?: boolean }> = [];

  for (const m of text.matchAll(/\b(last|previous|prior)\s+(month|quarter|year)\b/g)) {
    cues.push({ unit: m[2] as PeriodUnit, offset: -1 });
  }
  for (const m of text.matchAll(/\b(this|current)\s+(month|quarter|year)\b/g)) {
    cues.push({ unit: m[2] as PeriodUnit, offset: 0, weak: m[2] === 'year' });
  }
  if (/\b(?:ytd|year[- ]to[- ]date|so far)\b/.test(text)) cues.push({ unit: 'year', offset: 0, weak: true });
  for (const m of text.matchAll(/\b(?:for|in|over|during|of)\s+the\s+(month|quarter|year)\b/g)) {
    cues.push({ unit: m[1] as PeriodUnit, offset: 0, weak: true });
  }

  const months = distinct(findMonths(original).map((h) => h.month));
  if (months.length > 1) return 'unsupported';
  if (months.length === 1) {
    const offset = months[0] - curMonth;
    if (offset > 0) return 'unsupported';
    cues.push({ unit: 'month', offset });
  }

  const quarters: number[] = [];
  for (const m of text.matchAll(/\bq([1-4])\b/g)) quarters.push(parseInt(m[1], 10));
  for (const m of text.matchAll(/\b(first|second|third|fourth|1st|2nd|3rd|4th)\s+quarter\b/g)) quarters.push(ORDINAL_Q[m[1]]);
  const qs = distinct(quarters);
  if (qs.length > 1) return 'unsupported';
  if (qs.length === 1) {
    const offset = qs[0] - curQuarter;
    if (offset > 0) return 'unsupported';
    cues.push({ unit: 'quarter', offset });
  }

  // A named month/quarter makes a looser "this year" / "so far" cue redundant.
  const strong = cues.filter((c) => !c.weak);
  const hasNamed = months.length === 1 || qs.length === 1;
  const usable = hasNamed ? cues.filter((c) => !(c.weak && c.unit === 'year')) : cues;
  const pool = usable.length ? usable : strong;
  const keys = distinct(pool.map((c) => `${c.unit}:${c.offset}`));
  if (keys.length === 0) return null;
  if (keys.length > 1) return 'unsupported';
  return { unit: pool[0].unit, offset: pool[0].offset };
}

// ── spending_summary ─────────────────────────────────────────────────────────

function fillSpendingSummary(question: string, now: Date): FillResult {
  const cue = periodCue(question, now);
  if (cue === 'unsupported') return unfillable('period cannot be expressed by spending_summary');
  if (cue && cue.offset !== 0) return unfillable('spending_summary has no period offset');
  return { ok: true, args: { period: cue ? cue.unit : 'month', compareWithPrevious: true } };
}

// ── profit_loss ──────────────────────────────────────────────────────────────

function fillProfitLoss(question: string, now: Date): FillResult {
  const cue = periodCue(question, now);
  if (cue === 'unsupported') return unfillable('period cannot be placed');
  if (cue === null) return unfillable('no period cue');
  return { ok: true, args: { period: cue.unit, offset: cue.offset } };
}

// ── net_worth ────────────────────────────────────────────────────────────────

const NW_AGO = /\bago\b/;
const NW_COMPARATIVE = /\b(?:more|less|than|vs\.?|versus|compared?|up|down|better|worse)\b/;
const NW_PERIOD_UNIT = '(?:day|week|month|quarter|year|fiscal year|weekend|night|monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december)';
/** Any wording that points at a moment other than "now" (net_worth holds nothing else). */
const NW_TIME_QUALIFIER = new RegExp(
  [
    NW_AGO.source,
    `\\b(?:last|past|previous|prior|this|next|following|coming)\\s+${NW_PERIOD_UNIT}\\b`,
    '\\b(?:yesterday|tomorrow|tonight|previously|formerly|earlier|originally|ytd|mtd|qtd|year to date|back then|at the time)\\b',
    '\\b(?:end|start|beginning|close|middle|mid)\\s+of\\b',
    '\\bas of (?!(?:today|now|right now|this moment|the moment)\\b)',
    '\\b(?:since|before|after|until|till|between|during|throughout|by the end)\\b',
    '\\b(?:on|in|at|by)\\s+(?:the\\s+)?\\d{1,2}(?:st|nd|rd|th)?\\b',
    '\\bq[1-4]\\b',
    '\\b\\d{4}-\\d{1,2}-\\d{1,2}\\b|\\b\\d{1,2}/\\d{1,2}(?:/\\d{2,4})?\\b',
    '\\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\\b',
  ].join('|'),
  'i'
);

function fillNetWorth(question: string): FillResult {
  const original = String(question ?? '');
  const text = norm(original);
  if (findMonths(original).length > 0 || YEAR_NUMBER.test(text)) {
    return unfillable('net_worth cannot answer for a named month or year');
  }
  const trend =
    /\b(?:trend|over time|history|growth|grown|grew|changed?|changing|progress)\b/.test(text) ||
    /\bover the (?:last|past)\b/.test(text) ||
    (NW_AGO.test(text) && NW_COMPARATIVE.test(text));
  // Round 4: net_worth (summary / balance_sheet) is the CURRENT balance of every account and carries no
  // snapshot date. A point-in-time question about any other moment ("last month", "3 months ago",
  // "at the end of last year") cannot be answered from it, and a trend needs the licensed server tool.
  if (!trend && NW_TIME_QUALIFIER.test(text)) return unfillable('net_worth holds only current balances');
  if (!trend) {
    if (/\bbalance sheet\b/.test(text) || /\bassets?\s*(?:and|&|vs\.?|versus|,)\s*(?:liabilit(?:y|ies)|debts?)\b/.test(text) ||
        /\bliabilit(?:y|ies)\s*(?:and|&)\s*assets?\b/.test(text)) {
      return { ok: true, args: { action: 'balance_sheet' } };
    }
    return { ok: true, args: { action: 'summary' } };
  }

  let months = 12;
  const monthsRe = new RegExp(`\\b${COUNT}\\s+months?\\b`);
  const yearsRe = new RegExp(`\\b${COUNT}\\s+years?\\b`);
  const mm = text.match(monthsRe);
  const yy = text.match(yearsRe);
  if (mm) {
    const n = numberWordToInt(mm[1]);
    if (n === null) return unfillable('unreadable month count');
    months = n;
  } else if (yy) {
    const n = numberWordToInt(yy[1]);
    if (n === null) return unfillable('unreadable year count');
    months = n * 12;
  } // "a year", "the past year", "last year": the default 12
  if (months < 1 || months > 120) return unfillable('trend window out of range');
  return { ok: true, args: { action: 'trend', months } };
}

// ── forecast ─────────────────────────────────────────────────────────────────

const BASELINE_PHRASES: RegExp[] = [
  /\bif i (?:keep|continue|carry on|stay)\b/g,
  /\bat (?:my|the) current (?:pace|rate)\b/g,
  /\bat (?:this|that) (?:pace|rate)\b/g,
  /\blike this\b/g,
  /\bas (?:it|things) (?:is|are) now\b/g,
];

const WHAT_IF = /\b(?:what if|what happens if|what would happen if|suppose|assuming|if i|if we|if my)\b/;

function matchCategory(phrase: string, categories: string[]): string | null {
  const x = phrase.trim().toLowerCase();
  if (x.length < 3) return null;
  const hits = categories.filter((c) => {
    const lc = c.toLowerCase();
    return x.includes(lc) || lc.includes(x);
  });
  if (hits.length === 0) return null;
  hits.sort((a, b) => b.length - a.length);
  return hits[0];
}

function parseAmount(raw: string): number | null {
  const n = parseFloat(raw.replace(/,/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function parseWhatIf(original: string, categories: string[]): Array<Record<string, unknown>> | null {
  const items: Array<Record<string, unknown>> = [];

  const drop = original.match(
    /\b(?:cancel(?:l?ing)?|drop(?:ping)?|stop(?:\s+paying)?|quit|unsubscribe\s+from|eliminate)\b\s+(?:(?:my|the|our|paying|for)\s+)*(.+?)(?:\s+(?:subscription|membership|service|plan)s?)?(?=\s*(?:[,;.?!]|\b(?:how|what|will|would|and|then|by|for|in|next|over|each|every|per|this)\b)|$)/i
  );
  if (drop) {
    const description = drop[1].trim();
    if (!description || description.length > 40) return null;
    items.push({ type: 'drop_recurring', description });
  }

  const cut = original.match(
    /\b(cut|reduce|lower|decrease|trim|slash|increase|raise)\s+(?:my |the |our )?(.+?)\s+(?:spending\s+)?(?:by|down by|up by)\s+\$?(\d[\d,]*(?:\.\d+)?)/i
  );
  if (cut) {
    const amount = parseAmount(cut[3]);
    const category = matchCategory(cut[2], categories);
    if (amount === null || category === null) return null;
    const up = /^(increase|raise)$/i.test(cut[1]);
    items.push({ type: 'adjust_category', category, monthlyDelta: up ? amount : -amount });
  }

  const more = original.match(
    /\bspend\s+\$?(\d[\d,]*(?:\.\d+)?)\s+(more|less)\s+(?:on|for|at)\s+(.+?)(?=\s+(?:a|per|each|every)\s+month\b|\s+for\b|\s+in\b|[,.?!]|$)/i
  );
  if (more) {
    const amount = parseAmount(more[1]);
    const category = matchCategory(more[3], categories);
    if (amount === null || category === null) return null;
    items.push({ type: 'adjust_category', category, monthlyDelta: more[2].toLowerCase() === 'more' ? amount : -amount });
  }

  return items.length ? items : null;
}

function fillForecast(question: string, now: Date, categories: string[]): FillResult {
  const original = String(question ?? '');
  let text = norm(original);
  const curMonth = now.getMonth() + 1;

  // Baseline phrasing ("if I keep spending like this") is not a what-if.
  let withoutBaseline = text;
  for (const re of BASELINE_PHRASES) withoutBaseline = withoutBaseline.replace(re, ' ');

  let whatIf: Array<Record<string, unknown>> | undefined;
  if (WHAT_IF.test(withoutBaseline)) {
    const parsed = parseWhatIf(original, categories);
    if (!parsed) return unfillable('what-if phrase did not parse');
    whatIf = parsed;
  }

  // Horizon.
  const horizons: number[] = [];
  const inMonths = new RegExp(`\\b(?:in|over|for|within|next)\\s+(?:the\\s+)?(?:next\\s+)?${COUNT}\\s+months?\\b`).exec(text);
  if (inMonths) {
    const n = numberWordToInt(inMonths[1]);
    if (n === null) return unfillable('unreadable horizon');
    horizons.push(n);
  }
  const inYears = new RegExp(`\\b(?:in|over|for|within|next)\\s+(?:the\\s+)?(?:next\\s+)?${COUNT}\\s+years?\\b`).exec(text);
  if (inYears) {
    const n = numberWordToInt(inYears[1]);
    if (n === null) return unfillable('unreadable horizon');
    horizons.push(n * 12);
  }
  if (/\b(?:next year|in a year|a year from now|over the next year|in 1 year)\b/.test(text)) horizons.push(12);
  if (/\b(?:year[- ]end|end of (?:the |this )?year|by the end of the year)\b/.test(text)) {
    const left = 12 - curMonth;
    horizons.push(left > 0 ? left : 12);
  }
  const by = /\bby\s+(?:the\s+end\s+of\s+)?(?:the\s+)?([a-z]{3,9})\b/.exec(text);
  if (by) {
    const month = findMonths(by[1][0].toUpperCase() + by[1].slice(1))[0]?.month;
    if (month) {
      let left = month - curMonth;
      if (left <= 0) left += 12;
      horizons.push(left);
    }
  }
  const uniq = distinct(horizons);
  if (uniq.length > 1) return unfillable('conflicting horizons');
  const horizonMonths = uniq.length === 1 ? uniq[0] : 3;
  if (horizonMonths < 1 || horizonMonths > 24) return unfillable('horizon out of range');

  // Trailing window ("based on the last 6 months").
  let trailingMonths = 3;
  const trailing = new RegExp(`\\b(?:based on|using|from)\\s+(?:the\\s+)?(?:last|past|trailing)\\s+${COUNT}\\s+months?\\b`).exec(text);
  if (trailing) {
    const n = numberWordToInt(trailing[1]);
    if (n === null || n > 24) return unfillable('trailing window out of range');
    trailingMonths = n;
  }
  text = '';

  const args: Record<string, unknown> = { trailingMonths, horizonMonths };
  if (whatIf) args.whatIf = whatIf;
  return { ok: true, args };
}

// ── transaction_search ───────────────────────────────────────────────────────

/** Function words the server parser already ignores, plus question/verb filler. */
const FILLER = new Set([
  // question words and auxiliaries
  'what', 'whats', 'when', 'where', 'which', 'who', 'whom', 'whose', 'why', 'how', 'much', 'many',
  'did', 'do', 'does', 'done', 'am', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'will', 'would', 'can', 'could', 'should', 'may', 'might',
  // pronouns and determiners
  'i', 'me', 'my', 'mine', 'we', 'us', 'our', 'you', 'your', 'it', 'its', 'they', 'them', 'their',
  'this', 'that', 'these', 'those', 'there', 'here', 'the', 'a', 'an',
  // quantifiers
  'every', 'any', 'all', 'each', 'some', 'anything', 'everything', 'something', 'ever', 'also', 'just', 'only', 'again', 'still', 'even',
  'twice', 'thrice', 'once', 'times', 'time', 'total', 'totals', 'sum', 'number', 'amount', 'amounts', 'last', 'first', 'most', 'recent', 'recently',
  // request verbs
  'show', 'find', 'list', 'search', 'pull', 'give', 'tell', 'see', 'look', 'check', 'display', 'bring', 'fetch', 'get', 'got', 'gotten', 'let',
  'spend', 'spent', 'spending', 'pay', 'paid', 'paying', 'charge', 'charged', 'charges', 'bill', 'billed', 'bills', 'cost', 'costs', 'buy', 'bought',
  // prepositions and connectives
  'in', 'on', 'at', 'for', 'from', 'to', 'by', 'with', 'of', 'about', 'into', 'up', 'out', 'off', 'as', 'per', 'during', 'within', 'around',
  'than', 'then', 'and', 'or', 'not', 'no', 'so', 'if', 'but', 'please', 'over', 'under', 'above', 'below', 'more', 'less',
  // generic nouns about transactions
  'transaction', 'transactions', 'purchase', 'purchases', 'payment', 'payments', 'expense', 'expenses', 'ride', 'rides', 'order', 'orders', 'item', 'items', 'entry', 'entries', 'activity', 'record', 'records',
]);

const DATE_PHRASES = /\b(?:last month|this month|this year|last year|ytd|year to date|so far)\b/g;

interface TsDate { phrase: string }

function formatAmount(n: number): string {
  return Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`;
}

function fillTransactionSearch(question: string, now: Date, categories: string[]): FillResult {
  const original = String(question ?? '');
  const text = norm(original);
  if (!text) return unfillable('empty question');
  if (hasUnsupportedWindow(text, original.toLowerCase())) return unfillable('date window not expressible');
  if (/\b(?:quarter|quarters|q[1-4])\b/.test(text) || /\b(?:next|previous|prior|current)\s+(?:month|year)\b/.test(text)) {
    return unfillable('date phrase not expressible');
  }

  // Date.
  const dates: TsDate[] = [];
  for (const m of text.matchAll(DATE_PHRASES)) {
    const p = m[0];
    dates.push({ phrase: p === 'ytd' || p === 'year to date' || p === 'so far' ? 'this year' : p });
  }
  const monthHits = findMonths(original);
  const monthNums = distinct(monthHits.map((h) => h.month));
  if (monthNums.length > 1) return unfillable('several months named');
  if (monthNums.length === 1) dates.push({ phrase: `in ${MONTH_FULL[monthNums[0] - 1]}` });
  const datePhrases = distinct(dates.map((d) => d.phrase));
  if (datePhrases.length > 1) return unfillable('conflicting date phrases');
  const datePhrase = datePhrases[0];

  // Amounts: only "over/under $N" is expressible.
  let working = ` ${original} `;
  let overAmount: number | null = null;
  let underAmount: number | null = null;
  const overRe = /\b(?:over|above|more than|greater than|exceeds?|at least)\s*\$?\s*(\d[\d,]*(?:\.\d+)?)/i;
  const underRe = /\b(?:under|below|less than|cheaper than|at most)\s*\$?\s*(\d[\d,]*(?:\.\d+)?)/i;
  const ov = working.match(overRe);
  if (ov) {
    overAmount = parseAmount(ov[1]);
    if (overAmount === null) return unfillable('unreadable amount');
    working = working.replace(ov[0], ' ');
  }
  const un = working.match(underRe);
  if (un) {
    underAmount = parseAmount(un[1]);
    if (underAmount === null) return unfillable('unreadable amount');
    working = working.replace(un[0], ' ');
  }
  if (/\$\s*\d/.test(working)) return unfillable('an exact amount cannot be searched');

  // Recurring.
  const recurring = /\b(?:recurring|subscriptions?|autopay)\b/i.test(working);

  // Category (whole-word, exactly one).
  const lower = working.toLowerCase();
  const catHits = categories.filter((c) => lower.includes(c.toLowerCase()));
  let category: string | null = null;
  if (catHits.length > 1) return unfillable('several categories named');
  if (catHits.length === 1) {
    const c = catHits[0];
    if (!new RegExp(`(?<![a-z0-9])${escapeRe(c.toLowerCase())}(?![a-z0-9])`).test(lower)) {
      return unfillable('category name only appears inside another word');
    }
    category = c;
  }

  // Strip what we already extracted, then read the residual merchant words.
  let residual = working;
  residual = residual.replace(/\b(?:last month|this month|this year|last year|year to date|so far)\b/gi, ' ');
  residual = residual.replace(/\bytd\b/gi, ' ');
  for (const h of monthHits) residual = residual.replace(new RegExp(`\\b${escapeRe(h.token)}\\b`), ' ');
  residual = residual.replace(/\b(?:recurring|subscriptions?|autopay)\b/gi, ' ');
  if (category) residual = residual.replace(new RegExp(escapeRe(category), 'i'), ' ');
  const words = residual
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !FILLER.has(w.toLowerCase()) && !/^\d+$/.test(w));

  if (category && words.length > 0) return unfillable('a category and a merchant cannot both be searched');
  const merchant = words.join(' ');

  const parts = [category ?? merchant, datePhrase];
  if (overAmount !== null) parts.push(`over ${formatAmount(overAmount)}`);
  if (underAmount !== null) parts.push(`under ${formatAmount(underAmount)}`);
  if (recurring) parts.push('recurring');
  const canonical = parts.filter((p): p is string => Boolean(p)).join(' ');
  if (!canonical) return unfillable('empty canonical query');

  // The canonical query must round-trip through the server's own parser to exactly
  // what we meant, or we do not use it.
  const parsed = parseNaturalQueryAt(canonical, now, categories);
  const wantMerchant = category ? undefined : merchant || undefined;
  if (parsed.merchant !== wantMerchant) return unfillable('canonical query does not round-trip (merchant)');
  if ((parsed.category ?? null) !== category) return unfillable('canonical query does not round-trip (category)');
  if (Boolean(parsed.dateStart) !== Boolean(datePhrase)) return unfillable('canonical query does not round-trip (date)');
  if ((parsed.maxAmount ?? null) !== (overAmount === null ? null : -overAmount)) return unfillable('canonical query does not round-trip (over)');
  if ((parsed.minAmount ?? null) !== (underAmount === null ? null : -underAmount)) return unfillable('canonical query does not round-trip (under)');

  return { ok: true, args: { query: canonical } };
}

// ── Entry point ──────────────────────────────────────────────────────────────

/**
 * Fill the arguments for `tool` from the user's question.
 *
 * `now` is injected (the worker passes the run's instant); `categories` are the
 * mirror's category names (status.categories). Never throws: any internal
 * failure is `unfillable`. Successful args always pass the frozen schema.
 */
export function fillArgs(tool: ReadToolName, question: string, now: Date, categories: string[]): FillResult {
  try {
    let result: FillResult;
    switch (tool) {
      case 'transaction_search':
        result = fillTransactionSearch(question, now, categories);
        break;
      case 'spending_summary':
        result = fillSpendingSummary(question, now);
        break;
      case 'profit_loss':
        result = fillProfitLoss(question, now);
        break;
      case 'net_worth':
        result = fillNetWorth(question);
        break;
      case 'forecast':
        result = fillForecast(question, now, categories);
        break;
      default:
        return unfillable('unknown tool');
    }
    if (!result.ok) return result;
    const valid = validateReadToolArgs(tool, result.args);
    return valid.ok ? result : unfillable(`schema: ${valid.error}`);
  } catch (err) {
    return unfillable(`internal: ${err instanceof Error ? err.message : String(err)}`);
  }
}
