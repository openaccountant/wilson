import { parse } from 'csv-parse/sync';

export interface ParsedTransaction {
  date: string;
  description: string;
  amount: number;
  bank: 'chase' | 'amex' | 'generic';
}

/**
 * Parse a Chase credit card or checking account CSV.
 *
 * Chase CSV headers: "Transaction Date", "Post Date", "Description", "Category", "Type", "Amount"
 * Date format: MM/DD/YYYY -> YYYY-MM-DD
 * Amount convention: negative = charge (expense), positive = credit/payment
 * This matches our internal convention, so amounts are kept as-is.
 */
export function parseChaseCSV(content: string): ParsedTransaction[] {
  const records = parse(content, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
  }) as Record<string, string>[];

  const transactions: ParsedTransaction[] = [];

  for (const row of records) {
    const rawDate = row['Transaction Date'] ?? '';
    const description = row['Description'] ?? '';
    const rawAmount = row['Amount'] ?? '';

    if (!rawDate || !description || !rawAmount) {
      continue;
    }

    const date = normalizeDate(rawDate);
    const amount = parseFloat(rawAmount);

    if (isNaN(amount)) {
      continue;
    }

    transactions.push({
      date,
      description: description.trim(),
      amount,
      bank: 'chase',
    });
  }

  return transactions;
}

/**
 * Convert MM/DD/YYYY to YYYY-MM-DD.
 */
function normalizeDate(raw: string): string {
  const parts = raw.split('/');
  if (parts.length !== 3) return raw;
  const [month, day, year] = parts;
  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}
