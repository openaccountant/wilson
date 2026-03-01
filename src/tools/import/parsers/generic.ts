import { parse } from 'csv-parse/sync';
import type { ParsedTransaction } from './chase.js';

/** Patterns used to auto-detect column roles from headers. */
const DATE_PATTERNS = /^(date|transaction\s*date|trans\s*date|posted?\s*date)$/i;
const DESCRIPTION_PATTERNS = /^(description|merchant|payee|memo|name|transaction\s*description)$/i;
const AMOUNT_PATTERNS = /^(amount|debit|credit|transaction\s*amount)$/i;
const DEBIT_PATTERNS = /^(debit|withdrawal|payment)$/i;
const CREDIT_PATTERNS = /^(credit|deposit)$/i;

/**
 * Parse a generic bank CSV by auto-detecting column roles.
 *
 * Looks for headers matching date, description, and amount patterns.
 * If separate debit/credit columns are found, merges them (debit = negative, credit = positive).
 * Tries to detect sign convention: if most amounts are positive, assumes positive = expense and negates.
 */
export function parseGenericCSV(content: string): ParsedTransaction[] {
  const records = parse(content, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
  }) as Record<string, string>[];

  if (records.length === 0) return [];

  const headers = Object.keys(records[0]);

  // Detect column roles
  const dateCol = headers.find((h) => DATE_PATTERNS.test(h.trim()));
  const descCol = headers.find((h) => DESCRIPTION_PATTERNS.test(h.trim()));
  const amountCol = headers.find((h) => AMOUNT_PATTERNS.test(h.trim()));
  const debitCol = headers.find((h) => DEBIT_PATTERNS.test(h.trim()));
  const creditCol = headers.find((h) => CREDIT_PATTERNS.test(h.trim()));

  if (!dateCol || !descCol) {
    throw new Error(
      `Could not auto-detect CSV columns. Found headers: ${headers.join(', ')}. ` +
      `Need at least a date column and a description column.`
    );
  }

  if (!amountCol && !debitCol && !creditCol) {
    throw new Error(
      `Could not auto-detect amount column. Found headers: ${headers.join(', ')}. ` +
      `Need an amount, debit, or credit column.`
    );
  }

  const hasSeparateDebitCredit = !!(debitCol || creditCol) && !amountCol;

  // First pass: parse raw amounts to detect sign convention
  const rawTransactions: { date: string; description: string; amount: number }[] = [];

  for (const row of records) {
    const rawDate = row[dateCol] ?? '';
    const description = row[descCol] ?? '';

    if (!rawDate || !description) continue;

    let amount: number;

    if (hasSeparateDebitCredit) {
      const debit = debitCol ? parseFloat(row[debitCol] || '0') : 0;
      const credit = creditCol ? parseFloat(row[creditCol] || '0') : 0;
      // Debit = negative (expense), credit = positive (income)
      amount = isNaN(debit) ? 0 : -Math.abs(debit);
      amount += isNaN(credit) ? 0 : Math.abs(credit);
    } else {
      amount = parseFloat(row[amountCol!] ?? '0');
      if (isNaN(amount)) continue;
    }

    const date = normalizeDate(rawDate);
    rawTransactions.push({ date, description: description.trim(), amount });
  }

  // Detect sign convention: if most amounts are positive, the bank likely uses
  // positive = expense, so we negate.
  const positiveCount = rawTransactions.filter((t) => t.amount > 0).length;
  const shouldNegate = !hasSeparateDebitCredit && positiveCount > rawTransactions.length * 0.6;

  const transactions: ParsedTransaction[] = rawTransactions.map((t) => ({
    date: t.date,
    description: t.description,
    amount: shouldNegate ? -t.amount : t.amount,
    bank: 'generic' as const,
  }));

  return transactions;
}

/**
 * Attempt to normalize various date formats to YYYY-MM-DD.
 * Supports: MM/DD/YYYY, MM-DD-YYYY, YYYY-MM-DD, YYYY/MM/DD, DD/MM/YYYY (if month > 12 detected).
 */
function normalizeDate(raw: string): string {
  const trimmed = raw.trim();

  // Already YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return trimmed;
  }

  // YYYY/MM/DD
  if (/^\d{4}\/\d{2}\/\d{2}$/.test(trimmed)) {
    return trimmed.replace(/\//g, '-');
  }

  // MM/DD/YYYY or MM-DD-YYYY
  const slashMatch = trimmed.match(/^(\d{1,2})[/\-](\d{1,2})[/\-](\d{4})$/);
  if (slashMatch) {
    const [, first, second, year] = slashMatch;
    // If first > 12, assume DD/MM/YYYY
    const month = parseInt(first) > 12 ? second : first;
    const day = parseInt(first) > 12 ? first : second;
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  }

  // Fallback: return as-is
  return trimmed;
}
