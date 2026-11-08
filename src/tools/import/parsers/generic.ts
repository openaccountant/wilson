import { parse } from 'csv-parse/sync';
import type { ParsedTransaction } from './chase.js';
import { parseAmount } from './amount.js';

/** Patterns used to auto-detect column roles from headers. */
const DATE_PATTERNS = /^(date|transaction\s*date|trans\s*date|posted?\s*date)$/i;
// Quicken's "Transaction Report" CSV labels its description column
// "Payee/Security" (it covers investment-security transactions too).
const DESCRIPTION_PATTERNS = /^(description|merchant|payee(\s*\/\s*security)?|memo|name|transaction\s*description)$/i;
const AMOUNT_PATTERNS = /^(amount|transaction\s*amount)$/i;
const DEBIT_PATTERNS = /^(debit|withdrawal|payment)$/i;
const CREDIT_PATTERNS = /^(credit|deposit)$/i;
// Some exports (e.g. Quicken's combined "Transaction Report" CSV) cover
// multiple accounts in one file and name the account per row.
const ACCOUNT_PATTERNS = /^(account|account\s*name)$/i;

/**
 * Some exports (e.g. Quicken's "Transaction Report" CSV) prepend a title and
 * report-metadata lines — like "All Transactions" / "Report Created: ..." —
 * before the actual header row, so the first line isn't a real header.
 * Scans for the first line that looks like one (contains both a date-like
 * and a description-like column) and strips everything before it, the same
 * way `parseBofA` strips BofA's non-CSV preamble.
 */
function stripReportPreamble(content: string): string {
  // Strip a leading UTF-8 BOM (common in Excel/Windows-originated exports),
  // which would otherwise corrupt the first cell of whichever line it lands on.
  const lines = content.replace(/^﻿/, '').split(/\r?\n/);
  for (let i = 0; i < Math.min(lines.length, 20); i++) {
    const cells = lines[i].split(',').map((c) => c.trim().replace(/^"|"$/g, ''));
    const hasDate = cells.some((c) => DATE_PATTERNS.test(c));
    const hasDesc = cells.some((c) => DESCRIPTION_PATTERNS.test(c));
    if (hasDate && hasDesc) {
      return lines.slice(i).join('\n');
    }
  }
  // No recognizable header found — return as-is and let the caller's
  // column-detection error surface with the real (unmodified) headers.
  return content;
}

/**
 * Parse a generic bank CSV by auto-detecting column roles.
 *
 * Looks for headers matching date, description, and amount patterns.
 * If separate debit/credit columns are found, merges them (debit = negative, credit = positive).
 * Tries to detect sign convention: if no amount is negative and most are positive, assumes positive = expense and negates.
 */
export function parseGenericCSV(content: string): ParsedTransaction[] {
  const cleaned = stripReportPreamble(content);
  const records = parse(cleaned, {
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
  const accountCol = headers.find((h) => ACCOUNT_PATTERNS.test(h.trim()));

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

  // A full Debit+Credit pair wins over a stray amount-like column (NN-07: credits
  // must not be dropped); a lone debit/credit-ish column only counts without an amount.
  const hasSeparateDebitCredit = !!((debitCol && creditCol) || ((debitCol || creditCol) && !amountCol));

  // First pass: parse raw amounts. In split mode a row's value comes from the
  // Debit/Credit cells; a row with no usable split value (blank, non-numeric or a
  // "0.00" placeholder in both) falls back to the Amount column, whose sign
  // convention is resolved after the pass.
  const rawTransactions: { date: string; description: string; amount: number; accountName?: string; fromAmount?: boolean }[] = [];
  // Rows carrying BOTH a split value and an Amount tell us how the Amount column is signed.
  let amountAgrees = 0;
  let amountUnsigned = 0;

  for (const row of records) {
    const rawDate = row[dateCol] ?? '';
    const description = row[descCol] ?? '';

    if (!rawDate || !description) continue;

    let amount: number;
    let fromAmount = false;

    if (hasSeparateDebitCredit) {
      const debit = debitCol ? parseAmount(row[debitCol] ?? '') : NaN;
      const credit = creditCol ? parseAmount(row[creditCol] ?? '') : NaN;
      // A zero is a placeholder for "not this side", never a value that outranks the other column.
      const debitVal = Number.isFinite(debit) && debit !== 0 ? -Math.abs(debit) : 0;
      const creditVal = Number.isFinite(credit) && credit !== 0 ? Math.abs(credit) : 0;
      const split = debitVal + creditVal;
      const rowAmount = amountCol ? parseAmount(row[amountCol] ?? '') : NaN;
      if (debitVal === 0 && creditVal === 0) {
        // No split value on this row: Amount column, else a blank row to skip.
        if (!Number.isFinite(rowAmount) || rowAmount === 0) continue;
        amount = rowAmount;
        fromAmount = true;
      } else {
        amount = split;
        if (Number.isFinite(rowAmount) && rowAmount !== 0) {
          // Only a debit is informative: a positive credit agrees under either convention.
          if (split < 0) {
            if (rowAmount < 0) amountAgrees++;
            else amountUnsigned++;
          }
        }
      }
    } else {
      amount = parseAmount(row[amountCol!] ?? '0');
      if (isNaN(amount)) continue;
    }

    const date = normalizeDate(rawDate);
    const accountName = accountCol ? row[accountCol]?.trim() || undefined : undefined;
    rawTransactions.push({ date, description: description.trim(), amount, accountName, fromAmount });
  }

  // Amount-only rows in a split file (NN-07: negative = expense). The rows that carry
  // both an Amount and a split value reveal the Amount convention: where Amount is
  // positive on a debit it is unsigned (positive = expense), so fallback rows flip.
  // With no such evidence, an Amount-only set with no negatives is treated as unsigned
  // like a plain Amount file; any negative means it is already signed.
  const fallbackRows = rawTransactions.filter((t) => t.fromAmount);
  let negateFallback = false;
  if (fallbackRows.length > 0) {
    if (amountUnsigned > 0 || amountAgrees > 0) {
      negateFallback = amountUnsigned > amountAgrees;
    } else {
      const pos = fallbackRows.filter((t) => t.amount > 0).length;
      negateFallback = !fallbackRows.some((t) => t.amount < 0) && pos > fallbackRows.length * 0.6;
    }
  }
  for (const t of fallbackRows) if (negateFallback) t.amount = -t.amount;

  // Detect sign convention: an unsigned export (positive = expense) has no
  // negative amounts at all, so we negate. Any negative row means the file is
  // already signed — a mostly-deposit savings statement must keep its signs (NN-07).
  const positiveCount = rawTransactions.filter((t) => t.amount > 0).length;
  const hasNegative = rawTransactions.some((t) => t.amount < 0);
  const shouldNegate = !hasSeparateDebitCredit && !hasNegative && positiveCount > rawTransactions.length * 0.6;

  const transactions: ParsedTransaction[] = rawTransactions.map((t) => ({
    date: t.date,
    description: t.description,
    amount: shouldNegate ? -t.amount : t.amount,
    bank: 'generic' as const,
    account_name: t.accountName,
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
