import { parse } from 'csv-parse/sync';
import type { ParsedTransaction } from './chase.js';

/**
 * Parse a Bank of America CSV export (checking/savings or credit card).
 *
 * Auto-detects the format:
 * - Checking/Savings: Date,Description,Amount,Running Bal.
 * - Credit Card: Posted Date,Reference Number,Payee,Address,Amount
 *
 * BofA checking exports often prepend non-CSV metadata lines (account info,
 * date range) before the actual CSV header. These are stripped automatically.
 *
 * Amount convention: negative = debit/charge, positive = credit/payment.
 * This matches our internal convention, so amounts are kept as-is.
 */
export function parseBofA(content: string): ParsedTransaction[] {
  if (content.includes('Posted Date') && content.includes('Reference Number')) {
    return parseBofACreditCard(content);
  }
  return parseBofAChecking(content);
}

/**
 * Strip non-CSV header lines that BofA prepends to checking/savings exports.
 * Scans for the line containing "Date,Description,Amount" and returns
 * everything from that line onward.
 */
function stripNonCsvHeaders(content: string): string {
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (/^Date,Description,Amount/i.test(lines[i].trim())) {
      return lines.slice(i).join('\n');
    }
  }
  // No header found — return as-is and let csv-parse handle it
  return content;
}

/**
 * Convert MM/DD/YYYY to YYYY-MM-DD.
 */
function parseBofADate(dateStr: string): string {
  const parts = dateStr.trim().split('/');
  if (parts.length !== 3) return dateStr;
  const [month, day, year] = parts;
  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

/**
 * Parse BofA checking/savings CSV.
 * Headers: Date,Description,Amount,Running Bal.
 */
function parseBofAChecking(content: string): ParsedTransaction[] {
  const cleaned = stripNonCsvHeaders(content);
  const records = parse(cleaned, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
  }) as Record<string, string>[];

  const transactions: ParsedTransaction[] = [];

  for (const row of records) {
    const rawDate = row['Date'] ?? '';
    const description = row['Description'] ?? '';
    const rawAmount = row['Amount'] ?? '';

    if (!rawDate || !description || !rawAmount) {
      continue;
    }

    const date = parseBofADate(rawDate);
    const amount = parseFloat(rawAmount);

    if (isNaN(amount)) {
      continue;
    }

    transactions.push({
      date,
      description: description.trim(),
      amount,
      bank: 'bofa',
    });
  }

  return transactions;
}

/**
 * Parse BofA credit card CSV.
 * Headers: Posted Date,Reference Number,Payee,Address,Amount
 */
function parseBofACreditCard(content: string): ParsedTransaction[] {
  const records = parse(content, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
  }) as Record<string, string>[];

  const transactions: ParsedTransaction[] = [];

  for (const row of records) {
    const rawDate = row['Posted Date'] ?? '';
    const payee = row['Payee'] ?? '';
    const rawAmount = row['Amount'] ?? '';
    const refNumber = row['Reference Number'] ?? '';

    if (!rawDate || !payee || !rawAmount) {
      continue;
    }

    const date = parseBofADate(rawDate);
    const amount = parseFloat(rawAmount);

    if (isNaN(amount)) {
      continue;
    }

    transactions.push({
      date,
      description: payee.trim(),
      amount,
      bank: 'bofa-cc',
      merchant_name: payee.trim(),
      external_id: refNumber || undefined,
    });
  }

  return transactions;
}
