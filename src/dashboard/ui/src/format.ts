/** Legacy name for {@link money}, kept for existing call sites. */
export function formatAmount(amount: number): string {
  return money(amount);
}

export function formatDate(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/**
 * Parse a DB timestamp. SQLite's datetime('now') is UTC with no zone marker
 * ("YYYY-MM-DD HH:MM:SS"), which `new Date()` would read as local time.
 * Strings that already carry a zone (e.g. ISO ending in 'Z') pass through.
 */
export function parseDbTimestamp(s: string): Date {
  return new Date(/[zZ]$|[+-]\d\d:?\d\d$/.test(s) ? s : s.replace(' ', 'T') + 'Z');
}

// ---------------------------------------------------------------------------
// Shared money / percent formatters (charts, cards, tooltips, axes).
// The sign always precedes the currency symbol: '-$1,234.56', never '$-1,234'.
// Intl.NumberFormat instances are cached — constructing one per call is slow.
// ---------------------------------------------------------------------------

const nfCache = new Map<string, Intl.NumberFormat>();

function nf(minFrac: number, maxFrac: number): Intl.NumberFormat {
  const key = `${minFrac}:${maxFrac}`;
  let f = nfCache.get(key);
  if (!f) {
    f = new Intl.NumberFormat('en-US', {
      minimumFractionDigits: minFrac,
      maximumFractionDigits: maxFrac,
    });
    nfCache.set(key, f);
  }
  return f;
}

/** Round |n| to `digits` and build the signed string (never '-$0.00'). */
function signedAbs(n: number, digits: number, render: (abs: number) => string, unit = ''): string {
  if (!Number.isFinite(n)) return '—';
  const factor = 10 ** digits;
  const abs = Math.round(Math.abs(n) * factor) / factor;
  return `${n < 0 && abs !== 0 ? '-' : ''}${unit}${render(abs)}`;
}

/** '-$1,234.56' — two decimals, thousands separators, sign before '$'. */
export function money(n: number): string {
  return signedAbs(n, 2, (abs) => nf(2, 2).format(abs), '$');
}

/** '-$1,235' — rounded to whole dollars. */
export function moneyWhole(n: number): string {
  return signedAbs(n, 0, (abs) => nf(0, 0).format(abs), '$');
}

/**
 * Compact axis/label money: '$950', '-$1.5k', '-$14k', '$1.2m', '$12m'.
 * Values under $10k / $10m keep one (trimmed) decimal; larger ones none.
 */
export function moneyCompact(n: number): string {
  if (!Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  let scaled: number;
  let suffix: string;
  if (Math.round(abs) < 1000) {
    scaled = Math.round(abs);
    suffix = '';
  } else if (Math.round(abs / 1000) < 1000) {
    scaled = abs / 1000;
    suffix = 'k';
  } else {
    scaled = abs / 1_000_000;
    suffix = 'm';
  }
  const digits = suffix && scaled < 10 ? 1 : 0;
  const factor = 10 ** digits;
  const rounded = Math.round(scaled * factor) / factor;
  return `${n < 0 && rounded !== 0 ? '-' : ''}$${nf(0, digits).format(rounded)}${suffix}`;
}

/** Percent from a value already in percent units: pct(12.345) → '12%', pct(-12.345, 1) → '-12.3%'. */
export function pct(n: number, digits = 0): string {
  return signedAbs(n, digits, (abs) => `${nf(digits, digits).format(abs)}%`);
}