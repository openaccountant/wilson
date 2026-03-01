import { parse } from 'csv-parse/sync';
import type { ParsedTransaction } from './chase.js';

/**
 * Parse an American Express CSV.
 *
 * Amex CSV headers typically: "Date", "Description", "Amount"
 *   (may also include "Card Member", "Account #", etc.)
 * Date format: MM/DD/YYYY -> YYYY-MM-DD
 * Amount convention: Amex uses positive = charge (expense).
 * We NEGATE amounts so that negative = expense in our internal convention.
 */
export function parseAmexCSV(content: string): ParsedTransaction[] {
  const records = parse(content, {
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

    const date = normalizeDate(rawDate);
    const amount = parseFloat(rawAmount);

    if (isNaN(amount)) {
      continue;
    }

    // Negate: Amex positive = expense, our convention negative = expense
    transactions.push({
      date,
      description: description.trim(),
      amount: -amount,
      bank: 'amex',
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
