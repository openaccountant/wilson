/**
 * Outbound egress guard for REMOTE MCP servers (http / SSE transport).
 *
 * Every argument Wilson sends to a server that is not on this machine is
 * scanned first. Personal financial data — dollar amounts, tax ids (SSN /
 * ITIN / EIN), account and card numbers, emails, phone numbers — is replaced
 * by a placeholder such as `[amount]`, or, with `egress: "block"` in
 * mcp.json, the call is refused. A general question ("QBI deduction
 * threshold 2025 married filing jointly") goes out unchanged.
 *
 * Built on the same pieces as `maskPii` (./text-hygiene.ts): the compat fold
 * so fullwidth digits are seen as digits, hidden-character stripping so a
 * zero-width space cannot split a number past the patterns, and the shared
 * email / phone patterns. On top of that every Unicode decimal digit is read
 * as its ASCII digit, combining marks on digits are dropped, and any run of
 * whitespace (or a spaced " - ", a dot, an underscore) counts as a separator
 * inside a number. Unlike `maskPii` nothing of the value is kept (not
 * even the last 4 digits): the receiver is a third party.
 *
 * Stdio servers are not scanned (they run locally, chosen by the user).
 */
import { EMAIL_RE, PHONE_RE, foldCompat, stripHiddenChars } from './text-hygiene.js';

export type EgressKind = 'email' | 'tax_id' | 'amount' | 'phone' | 'number';

export interface EgressScan<T> {
  /** The value to send: unchanged when nothing was found. */
  value: T;
  /** How many values were replaced in total. */
  redactions: number;
  /** Replacements by kind (only kinds that occurred). */
  kinds: Partial<Record<EgressKind, number>>;
}

const PLACEHOLDER: Record<EgressKind, string> = {
  email: '[email]',
  tax_id: '[tax-id]',
  amount: '[amount]',
  phone: '[phone]',
  number: '[number]',
};

// Dash look-alikes (hyphen, non-breaking hyphen, figure / en / em dash, minus, small / fullwidth hyphen-minus).
const DASHES_RE = /[‐-―−﹣－]/g;

/**
 * Every Unicode decimal digit (Arabic-Indic, Devanagari, Bengali, Thai, mathematical ...) as its ASCII digit.
 * Unicode guarantees decimal digits come in contiguous runs of ten, 0 to 9, so a digit's value is its distance
 * from the start of its run, mod 10 (the mathematical digits are five such runs back to back).
 */
const ND_RE = /\p{Nd}/u;
function foldDigits(s: string): string {
  return s.replace(/\p{Nd}/gu, (ch) => {
    let cp = ch.codePointAt(0)!;
    if (cp < 0x80) return ch;
    let offset = 0;
    while (offset < 60 && ND_RE.test(String.fromCodePoint(cp - 1))) { cp--; offset++; }
    return String(offset % 10);
  });
}

// Combining marks on a digit or a separator ("1́2́") would otherwise split a number past the patterns.
const MARK_AFTER_DIGIT_RE = /(?<=[\d\s\-.\/_])\p{M}+/gu;

// A separator inside a number: one punctuation mark with optional whitespace around it ("123 - 45", "123.45",
// "123_45"), or any run of whitespace (double spaces, tabs and newlines from pasted statements).
const SEP = String.raw`(?:\s*[-.\/_]\s*|\s+)`;

// SSN / ITIN 123-45-6789 (any separator above), EIN 12-3456789, or a bare 9-digit run. Never inside a longer number.
const TAX_ID_RE = new RegExp(
  String.raw`(?<![\d.\-_\/])(?:\d{3}${SEP}\d{2}${SEP}\d{4}|\d{2}\s*-\s*\d{7}|\d{9})(?!\d|[-.\/_]\d)`,
  'g',
);

const NUM = String.raw`\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?`;
const CUR_SIGN = String.raw`(?:US|CA|C|AU|A|NZ)?\$|[€£¥₹₩]`;
const CUR_CODE = String.raw`USD|CAD|EUR|GBP|AUD|NZD|JPY|CHF|MXN|INR|CNY|HKD|SGD|SEK|NOK|DKK|BRL|ZAR`;
const CUR_WORD = String.raw`dollars?|bucks|euros?|pounds?|yen|pesos?|rupees?|francs?`;
const MAG_WORD = String.raw`thousand|million|billion|grand`;
// After a currency sign or before a currency word: $50k, $1.2 m, 3 million dollars.
const MAGNITUDE = String.raw`(?:\s?(?:k|mm|m|bn|b|${MAG_WORD})\b)?`;
// Amounts (case-insensitive):
//  - a currency sign, code or word around a number: $1,234.56, -$50, US$ 20, €300, USD 4500, 4500 EUR, 45 dollars;
//  - a number with a magnitude: 95k, 1.2m, 120 thousand, 1.2 million (401k and 403b are plan names);
//  - a comma-grouped number (12,500.00) or a space-grouped one (85 000);
//  - a signed number (-1234.5, -300);
//  - a number of 1 or more with cents (1234.56). A rate (1.45%, 0.67) and a regulation (1.62-2) are left alone.
const AMOUNT_RE = new RegExp(
  [
    String.raw`-?(?:${CUR_SIGN})\s?-?(?:${NUM})${MAGNITUDE}`,
    String.raw`-?(?<![\w.,])(?:${NUM})${MAGNITUDE}\s?(?:${CUR_CODE}|${CUR_WORD})\b`,
    String.raw`\b(?:${CUR_CODE})\s?-?(?:${NUM})${MAGNITUDE}(?![\d])`,
    String.raw`(?<![\w.,])(?:${NUM})\s?(?:${MAG_WORD})\b`,
    String.raw`(?<![\w.,])(?!40[13]k\b|1099k\b)(?:${NUM})(?:k|mm|m|bn)\b`,
    String.raw`(?<![\d.,])\d{1,3}(?:,\d{3})+(?:\.\d+)?(?![\d,])`,
    String.raw`(?<![\d.,])\d{1,3}(?:[   ]\d{3})+(?:\.\d+)?(?!\d|\s\d)`,
    String.raw`(?<![\w.\-])-(?:\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+\.\d+|\d{2,})(?![\d%])`,
    String.raw`(?<![\d.,])[1-9]\d*\.\d{2}(?![\d.,%]|\s?%|\s?percent|-\d)`,
  ].join('|'),
  'gi',
);

// A maximal run of digits joined by separators. Each run is classified by `classifyRun`.
const DIGIT_RUN_RE = new RegExp(String.raw`(?<!\d)\d+(?:${SEP}\d+)*(?!\d)`, 'g');

// Pieces of a run that are not personal: dates (2025-04-15, 04/15/2025, 1/15/26), year ranges (2024-2025, 2024/25),
// IRS document numbers (Rev. Proc. 2024-40, Notice 2024-7) and regulation citations (1.6654-2, 301.7701-3).
const MONTH = String.raw`(?:0?[1-9]|1[0-2])`;
const DAY = String.raw`(?:0?[1-9]|[12]\d|3[01])`;
const YEAR = String.raw`(?:19|20)\d{2}`;
const BENIGN_CHUNK_RE = new RegExp(
  '^(?:' +
    [
      String.raw`${YEAR}`,
      String.raw`${YEAR}([-\/.])${MONTH}\1${DAY}`,
      String.raw`${MONTH}([-\/.])${DAY}\2(?:${YEAR}|\d{2})`,
      String.raw`${YEAR}[-\/](?:${YEAR}|\d{1,3})`,
      String.raw`\d{1,3}\.\d{1,5}-\d{1,3}`,
    ].join('|') +
    ')$',
);
// A form, publication or code-section number right after its keyword: "Form 14039", "Form 13614-C", "§ 1031".
const DOC_KEYWORD_RE = /(?:\bforms?|\bpub(?:lication)?s?\.?|\bnotices?|\bschedules?|\bsch\.?|\bsec(?:tion)?s?\.?|§+|\birc|\bproc\.?|\brul\.?)\s*$/i;

/** True when one separator-joined piece (no whitespace inside) looks like an account, card or policy number. */
function chunkIsPersonal(chunk: string, docContext: boolean): boolean {
  const digits = chunk.replace(/\D/g, '').length;
  if (BENIGN_CHUNK_RE.test(chunk)) return false;
  if (docContext && digits <= 5) return false;
  // A single dot with at most 4 digits on each side is a decimal, version or citation ("1.6654", "26.1");
  // anything else dot-joined ("12.3456789", "1234.5678.9012") is judged like a hyphen-joined number.
  if (!/[-\/_]/.test(chunk) && /^\d{1,4}\.\d{1,4}$/.test(chunk)) return false;
  return digits >= 5;
}

/**
 * Classify one digit run. Whitespace-separated groups are a card, account or tax id number when together they have
 * 9 or more digits, unless every group is a year or form-like ("tax years 2023 2024 2025", "forms 1040 1099 8995").
 * Otherwise each group is judged on its own.
 */
function classifyRun(run: string, docContext: boolean, hit: () => string): string {
  const chunks = run.replace(/\s*([-.\/_])\s*/g, '$1').split(/\s+/);
  if (chunks.length > 1) {
    const total = chunks.reduce((n, c) => n + c.replace(/\D/g, '').length, 0);
    const allBenign = chunks.every((c) => BENIGN_CHUNK_RE.test(c));
    // A short list of form-like numbers is exempt only right after a document keyword ("forms 1040 1099 8995");
    // without one, "1234 5678 9012" is an account or card number.
    const listLike =
      docContext && chunks.length <= 4 && chunks.every((c) => /^[1-9]\d{0,3}$/.test(c) || BENIGN_CHUNK_RE.test(c));
    // 9 digits is the shortest personal number split into groups (an SSN as "123 45 6789").
    if (total >= 9 && !allBenign && !listLike) return hit();
  }
  const personal = chunks.map((c) => chunkIsPersonal(c, docContext));
  if (!personal.some(Boolean)) return run;
  return chunks.map((c, i) => (personal[i] ? hit() : c)).join(' ');
}

/** Scan one string. Returns it unchanged when nothing personal was found. */
export function scrubEgressText(s: string): EgressScan<string> {
  const kinds: Partial<Record<EgressKind, number>> = {};
  let redactions = 0;
  const hit = (kind: EgressKind): string => {
    kinds[kind] = (kinds[kind] ?? 0) + 1;
    redactions++;
    return PLACEHOLDER[kind];
  };

  const text = foldDigits(foldCompat(stripHiddenChars(s, { allowNewlines: true })))
    .replace(MARK_AFTER_DIGIT_RE, '')
    .replace(DASHES_RE, '-');
  const out = text
    .replace(EMAIL_RE, () => hit('email'))
    .replace(TAX_ID_RE, () => hit('tax_id'))
    .replace(PHONE_RE, () => hit('phone'))
    .replace(AMOUNT_RE, () => hit('amount'))
    .replace(DIGIT_RUN_RE, (run: string, offset: number, whole: string) =>
      classifyRun(run, DOC_KEYWORD_RE.test(whole.slice(Math.max(0, offset - 24), offset)), () => hit('number')),
    );

  return redactions === 0 ? { value: s, redactions: 0, kinds } : { value: out, redactions, kinds };
}

const MAX_DEPTH = 32;

/** A fraction below 1 passed as a number (a rate). */
const isRateNumber = (v: unknown) => typeof v === 'number' && !Number.isInteger(v) && Math.abs(v) < 1;
/** A sibling value judged in an object's joined scan: digit-bearing, and not a rate. */
const joinable = (v: unknown): v is string | number | bigint => hasDigits(v) && !isRateNumber(v);

/** A string or number that contains a digit (any script). */
function hasDigits(v: unknown): v is string | number | bigint {
  return (typeof v === 'string' || typeof v === 'number' || typeof v === 'bigint') && /\p{Nd}/u.test(String(v));
}

/** Integers in [-2100, 2100] and finite fractions with |n| < 1. */
export function isBenignNumber(n: number | bigint): boolean {
  if (typeof n === 'bigint') return n >= -2100n && n <= 2100n;
  if (!Number.isFinite(n)) return false;
  if (Number.isInteger(n)) return Math.abs(n) <= 2100;
  return Math.abs(n) < 1;
}

/**
 * Scan every string and number in a tool's arguments, recursively (object
 * keys included). Numbers pass only when `isBenignNumber`; booleans and null
 * pass through. Nesting deeper than
 * 32 levels is replaced by "[redacted]" and counted, so a deep payload cannot
 * slip past the scan.
 */
export function scrubEgressArgs<T>(args: T): EgressScan<T> {
  const kinds: Partial<Record<EgressKind, number>> = {};
  let redactions = 0;
  const add = (scan: EgressScan<unknown>) => {
    redactions += scan.redactions;
    for (const [k, n] of Object.entries(scan.kinds) as Array<[EgressKind, number]>) kinds[k] = (kinds[k] ?? 0) + n;
  };

  const walk = (value: unknown, depth: number): unknown => {
    if (typeof value === 'string') {
      const scan = scrubEgressText(value);
      add(scan);
      return scan.value;
    }
    if (typeof value === 'number' || typeof value === 'bigint') {
      // A number argument can carry an amount, account number or tax id just as a string can. Only values
      // that cannot identify money or a person pass: small integers (limits, years ≤ 2100) and fractions
      // below 1 (rates). Everything else is replaced, counted, and blocked under egress "block".
      if (isBenignNumber(value)) return value;
      redactions++;
      kinds.number = (kinds.number ?? 0) + 1;
      return '[number]';
    }
    if (value === null || typeof value !== 'object') return value;
    if (depth >= MAX_DEPTH) {
      redactions++;
      kinds.number = (kinds.number ?? 0) + 1;
      return '[redacted]';
    }
    const countNumber = () => {
      redactions++;
      kinds.number = (kinds.number ?? 0) + 1;
    };
    if (Array.isArray(value)) {
      const mapped = value.map((v) => walk(v, depth + 1));
      // A number can be split across array elements (["1234", "5678", "9012"] or [123, 45, 6789]), each of
      // which passes alone. Judge the digit-bearing elements together as one space-joined run as well.
      // The originals are joined, not the scanned values: an element already replaced must still count.
      const parts = value.filter(hasDigits);
      if (parts.length > 1 && scrubEgressText(parts.map(String).join(' ')).redactions > 0) {
        return mapped.map((v, i) => {
          if (hasDigits(value[i]) && v !== '[number]') {
            countNumber();
            return '[number]';
          }
          return v;
        });
      }
      return mapped;
    }
    // The same for an object: a number can be split across its keys and sibling values
    // ({"1234": "5678", "9012": "x"}, {a: "1234", b: "5678", c: "9012"}). Digit-bearing keys and primitive values
    // are judged together, in order, and on a hit every one of them is replaced. Replaced keys get a suffix
    // ("[number]", "[number]_b") so no field is lost to a key collision. A rate argument (a fraction below 1,
    // rate: 0.067) is left out of the join: it sits next to a limit and a tax year in an ordinary lookup.
    const entries = Object.entries(value as Record<string, unknown>);
    const parts: string[] = [];
    for (const [key, v] of entries) {
      if (hasDigits(key)) parts.push(key);
      if (joinable(v)) parts.push(String(v));
    }
    const joinedHit = parts.length > 1 && scrubEgressText(parts.join(' ')).redactions > 0;
    const out: Record<string, unknown> = {};
    // The suffix is letters, not a number, so a replaced key carries no digits at all.
    const letters = (n: number): string => (n < 26 ? '' : letters(Math.floor(n / 26) - 1)) + String.fromCharCode(97 + (n % 26));
    const freshKey = (base: string): string => {
      if (!(base in out)) return base;
      let n = 1;
      while (`${base}_${letters(n)}` in out) n++;
      return `${base}_${letters(n)}`;
    };
    for (const [key, v] of entries) {
      let outKey: string;
      if (joinedHit && hasDigits(key)) {
        countNumber();
        outKey = freshKey('[number]');
      } else {
        const keyScan = scrubEgressText(key);
        add(keyScan);
        outKey = freshKey(keyScan.value);
      }
      let outValue = walk(v, depth + 1);
      if (joinedHit && joinable(v) && outValue !== '[number]') {
        countNumber();
        outValue = '[number]';
      }
      out[outKey] = outValue;
    }
    return out;
  };

  const value = walk(args, 0) as T;
  return redactions === 0 ? { value: args, redactions: 0, kinds } : { value, redactions, kinds };
}
