import type { BankType } from './parsers/chase.js';
export type { BankType };

export interface DetectedFormat {
  format: 'csv' | 'ofx' | 'qif';
  bank?: BankType;
}

/**
 * Detect the file format and bank from raw file content.
 *
 * Checks OFX/QIF by content sniffing first, then falls back to CSV header detection.
 */
export function detectFormat(content: string): DetectedFormat {
  const trimmed = content.trimStart();

  // OFX v1.x (SGML): starts with OFXHEADER:
  if (trimmed.startsWith('OFXHEADER:')) {
    return { format: 'ofx', bank: 'ofx' };
  }

  // OFX v2.x (XML): starts with <?OFX or contains <OFX>
  if (trimmed.startsWith('<?OFX') || trimmed.startsWith('<OFX>')) {
    return { format: 'ofx', bank: 'ofx' };
  }

  // QIF: lines starting with !Type: or first non-empty line starts with D followed by date
  const lines = trimmed.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length > 0) {
    if (lines[0].startsWith('!Type:')) {
      return { format: 'qif', bank: 'qif' };
    }
    // First non-empty line starts with D followed by a date-like pattern (e.g. D01/15/2026)
    if (/^D\d{1,2}[\/\-]/.test(lines[0])) {
      return { format: 'qif', bank: 'qif' };
    }
  }

  // Fall back to CSV — scan lines for the best header row.
  // Some banks (e.g. BofA checking) prepend summary rows before the real headers,
  // so we check each line until we find a recognized bank or exhaust the scan.
  let bestBank: BankType = 'generic';
  for (let i = 0; i < Math.min(lines.length, 20); i++) {
    const headers = lines[i].split(',').map((h) => h.trim().replace(/^"|"$/g, ''));
    const bank = detectBank(headers);
    if (bank !== 'generic') {
      bestBank = bank;
      break;
    }
  }

  return { format: 'csv', bank: bestBank };
}

/**
 * Detect the bank/institution from CSV headers.
 *
 * - Chase:   headers include "Transaction Date" AND ("Post Date" OR "Category")
 * - Amex:    headers include "Date" AND "Description" AND ("Card Member" OR "Account #")
 * - BofA checking: headers include "Description" AND "Running Bal." (without Chase's "Transaction Date")
 * - BofA credit card: headers include "Posted Date" AND "Reference Number" AND "Payee"
 * - Generic: fallback for unknown formats
 */
export function detectBank(headers: string[]): BankType {
  const normalized = headers.map((h) => h.trim().toLowerCase());

  // Chase detection
  const hasTransactionDate = normalized.includes('transaction date');
  const hasPostDate = normalized.includes('post date');
  const hasCategory = normalized.includes('category');

  if (hasTransactionDate && (hasPostDate || hasCategory)) {
    return 'chase';
  }

  // Amex detection
  const hasDate = normalized.includes('date');
  const hasDescription = normalized.includes('description');
  const hasCardMember = normalized.includes('card member');
  const hasAccountNumber = normalized.includes('account #');

  if (hasDate && hasDescription && (hasCardMember || hasAccountNumber)) {
    return 'amex';
  }

  // BofA credit card detection (must check before checking account — more specific)
  const hasPostedDate = normalized.includes('posted date');
  const hasReferenceNumber = normalized.includes('reference number');
  const hasPayee = normalized.includes('payee');

  if (hasPostedDate && hasReferenceNumber && hasPayee) {
    return 'bofa-cc';
  }

  // BofA checking detection
  const hasRunningBal = normalized.includes('running bal.');

  if (hasDescription && hasRunningBal && !hasTransactionDate) {
    return 'bofa';
  }

  return 'generic';
}
