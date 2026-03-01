import { parse } from 'csv-parse/sync';

export type BankType = 'chase' | 'amex' | 'generic' | 'bofa' | 'bofa-cc' | 'ofx' | 'qif' | 'monarch' | 'plaid';

export interface ParsedTransaction {
  date: string;           // YYYY-MM-DD
  description: string;
  amount: number;
  bank: BankType;
  external_id?: string;        // OFX FITID, CSV hash, Plaid txn ID, etc.
  merchant_name?: string;      // Cleaned merchant name
  check_number?: string;       // Check number
  transaction_type?: string;   // OFX TRNTYPE or similar
  category?: string;           // Pre-existing category (from QIF L field)
  category_detailed?: string;  // PFC code if known
  payment_channel?: string;    // online, in_store, other
  pending?: boolean;           // Pending status
  authorized_date?: string;    // YYYY-MM-DD
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
