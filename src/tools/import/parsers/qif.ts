import type { ParsedTransaction } from './chase.js';
import { FREEFORM_TO_PFC } from '../../../categories/pfc-taxonomy.js';
import type { PfcDetailed } from '../../../categories/pfc-taxonomy.js';

/**
 * Parse a QIF date string into YYYY-MM-DD format.
 *
 * Supported formats:
 *   M/D'YY   -> 20YY-0M-0D
 *   M-D'YY   -> 20YY-0M-0D
 *   M/D/YYYY -> YYYY-0M-0D
 *   M-D-YYYY -> YYYY-0M-0D
 *   MM/DD/YYYY -> YYYY-MM-DD
 */
export function parseQifDate(dateStr: string): string {
  const trimmed = dateStr.trim();

  // Handle apostrophe year format: M/D'YY or M-D'YY
  const apostropheMatch = trimmed.match(/^(\d{1,2})[/\-](\d{1,2})'(\d{2})$/);
  if (apostropheMatch) {
    const [, month, day, year] = apostropheMatch;
    return `20${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  }

  // Handle full year format: M/D/YYYY or M-D-YYYY
  const fullMatch = trimmed.match(/^(\d{1,2})[/\-](\d{1,2})[/\-](\d{4})$/);
  if (fullMatch) {
    const [, month, day, year] = fullMatch;
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  }

  return trimmed;
}

/**
 * Try to map a QIF category string (e.g. "Food:Groceries") to a PFC detailed code.
 *
 * Extracts the subcategory after the last colon, then looks it up in FREEFORM_TO_PFC.
 * Also tries the full category string and the part before the colon.
 */
function mapCategoryToPfc(category: string): PfcDetailed | undefined {
  if (!category) return undefined;

  // Try the full string first
  if (category in FREEFORM_TO_PFC) {
    return FREEFORM_TO_PFC[category];
  }

  // Try subcategory (after last colon)
  const colonIdx = category.lastIndexOf(':');
  if (colonIdx !== -1) {
    const subcategory = category.slice(colonIdx + 1).trim();
    if (subcategory in FREEFORM_TO_PFC) {
      return FREEFORM_TO_PFC[subcategory];
    }

    // Try primary (before colon)
    const primary = category.slice(0, colonIdx).trim();
    if (primary in FREEFORM_TO_PFC) {
      return FREEFORM_TO_PFC[primary];
    }
  }

  return undefined;
}

/**
 * Compute a simple hash for generating external IDs when no check number is available.
 */
function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const chr = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + chr;
    hash |= 0; // Convert to 32bit integer
  }
  return Math.abs(hash).toString(36);
}

interface QifRecord {
  date?: string;
  amount?: string;
  payee?: string;
  category?: string;
  memo?: string;
  checkNumber?: string;
  clearedStatus?: string;
  splits: Array<{
    category?: string;
    memo?: string;
    amount?: string;
  }>;
}

/**
 * Parse QIF (Quicken Interchange Format) content into ParsedTransactions.
 *
 * QIF is a line-based plain text format:
 * - Records separated by `^` on its own line
 * - Each line starts with a single-character code followed by the value
 * - File may start with `!Type:Bank`, `!Type:CCard`, `!Type:Cash`, etc.
 *
 * Field codes:
 *   D — Date          T — Amount        P — Payee
 *   L — Category      M — Memo          N — Check number
 *   C — Cleared status
 *   S — Split category   E — Split memo   $ — Split amount
 */
export function parseQif(content: string): ParsedTransaction[] {
  const lines = content.split(/\r?\n/);
  const transactions: ParsedTransaction[] = [];

  let current: QifRecord | null = null;
  let currentSplit: { category?: string; memo?: string; amount?: string } | null = null;

  function flushSplit() {
    if (currentSplit && current) {
      current.splits.push(currentSplit);
      currentSplit = null;
    }
  }

  function flushRecord() {
    flushSplit();
    if (!current || !current.date) {
      current = null;
      return;
    }

    const date = parseQifDate(current.date);
    const payee = current.payee?.trim();
    const memo = current.memo?.trim();
    const description = payee ?? memo ?? 'Unknown';
    const category = current.category?.trim() ?? '';
    const checkNumber = current.checkNumber?.trim();

    if (current.splits.length > 0) {
      // Split transaction: create one ParsedTransaction per split
      for (const split of current.splits) {
        const splitCategory = split.category?.trim() ?? category;
        const splitAmount = split.amount ? parseFloat(split.amount) : 0;
        const pfcCode = mapCategoryToPfc(splitCategory);
        const splitMemo = split.memo?.trim();

        transactions.push({
          date,
          description,
          amount: splitAmount,
          bank: 'qif',
          merchant_name: payee,
          category: splitCategory || undefined,
          category_detailed: pfcCode,
          check_number: checkNumber,
          external_id: checkNumber ?? `qif-${simpleHash(`${date}|${description}|${splitAmount}|${splitMemo ?? ''}`)}`,
        });
      }
    } else {
      // Regular (non-split) transaction
      const amount = current.amount ? parseFloat(current.amount) : 0;
      const pfcCode = mapCategoryToPfc(category);

      transactions.push({
        date,
        description,
        amount,
        bank: 'qif',
        merchant_name: payee,
        category: category || undefined,
        category_detailed: pfcCode,
        check_number: checkNumber,
        external_id: checkNumber ?? `qif-${simpleHash(`${date}|${description}|${amount}`)}`,
      });
    }

    current = null;
  }

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip empty lines and type headers
    if (!trimmed || trimmed.startsWith('!')) {
      continue;
    }

    // Record separator
    if (trimmed === '^') {
      flushRecord();
      continue;
    }

    // Start a new record if needed
    if (!current) {
      current = { splits: [] };
    }

    const code = trimmed[0];
    const value = trimmed.slice(1);

    switch (code) {
      case 'D':
        current.date = value;
        break;
      case 'T':
        current.amount = value;
        break;
      case 'P':
        current.payee = value;
        break;
      case 'L':
        current.category = value;
        break;
      case 'M':
        current.memo = value;
        break;
      case 'N':
        current.checkNumber = value;
        break;
      case 'C':
        current.clearedStatus = value;
        break;
      case 'S':
        // New split entry — flush any previous split
        flushSplit();
        currentSplit = { category: value };
        break;
      case 'E':
        if (currentSplit) currentSplit.memo = value;
        break;
      case '$':
        if (currentSplit) currentSplit.amount = value;
        break;
    }
  }

  // Flush any trailing record (no final ^)
  flushRecord();

  return transactions;
}

/**
 * Detect whether content looks like QIF format.
 *
 * Returns true if content starts with `!Type:` or has the QIF record pattern
 * (lines starting with D, T, P codes followed by `^`).
 */
export function isQifContent(content: string): boolean {
  const trimmed = content.trimStart();

  // Check for QIF type header
  if (trimmed.startsWith('!Type:')) {
    return true;
  }

  // Check for QIF record pattern: look for D/T/P lines and ^ separator
  const lines = trimmed.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let hasDate = false;
  let hasAmount = false;
  let hasSeparator = false;

  for (const line of lines) {
    if (line.match(/^D\d/)) hasDate = true;
    if (line.match(/^T-?\d/)) hasAmount = true;
    if (line === '^') hasSeparator = true;
    if (hasDate && hasAmount && hasSeparator) return true;
  }

  return false;
}
