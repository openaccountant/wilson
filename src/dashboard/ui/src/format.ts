export function formatAmount(amount: number): string {
  const abs = Math.abs(amount);
  return `${amount < 0 ? '-' : ''}$${abs.toFixed(2)}`;
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