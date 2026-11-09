import { LedgerValidationError } from './errors.js';

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Validates a calendar date in yyyy-mm-dd form (lexicographic order == chronological order). */
export function assertIsoDate(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string') throw new LedgerValidationError(`${field} must be a yyyy-mm-dd string`);
  const m = ISO_DATE.exec(value);
  if (!m) throw new LedgerValidationError(`${field} must be yyyy-mm-dd, got ${JSON.stringify(value)}`);
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = utcDate(y, mo - 1, d);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) {
    throw new LedgerValidationError(`${field} is not a real calendar date: ${value}`);
  }
}

/** First day of the (calendar) fiscal year containing date. */
export function yearStart(date: string): string {
  return `${date.slice(0, 4)}-01-01`;
}

/** The day before date, as yyyy-mm-dd. */
export function dayBefore(date: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const dt = utcDate(y, m - 1, d - 1);
  return `${String(dt.getUTCFullYear()).padStart(4, '0')}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}

/** Date.UTC maps years 0-99 to 1900-1999; setUTCFullYear does not. */
function utcDate(y: number, monthIndex: number, d: number): Date {
  const dt = new Date(0);
  dt.setUTCFullYear(y, monthIndex, d);
  return dt;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

export function assertRange(start: string, end: string): void {
  assertIsoDate(start, 'start');
  assertIsoDate(end, 'end');
  if (start > end) throw new LedgerValidationError(`start ${start} is after end ${end}`);
}
