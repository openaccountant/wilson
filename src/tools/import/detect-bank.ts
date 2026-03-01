export type BankType = 'chase' | 'amex' | 'generic';

/**
 * Detect the bank/institution from CSV headers.
 *
 * - Chase: headers include "Transaction Date" AND ("Post Date" OR "Category")
 * - Amex:  headers include "Date" AND "Description" AND ("Card Member" OR "Account #")
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

  return 'generic';
}
