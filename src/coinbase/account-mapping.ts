import type { AccountSubtype } from '../tools/net-worth/account-types.js';

const COINBASE_TYPE_MAP: Record<string, AccountSubtype> = {
  wallet: 'crypto',
  vault: 'crypto',
  fiat: 'checking',
};

/**
 * Map a Coinbase account type to our AccountSubtype taxonomy.
 */
export function mapCoinbaseTypeToSubtype(coinbaseType: string): AccountSubtype {
  return COINBASE_TYPE_MAP[coinbaseType.toLowerCase()] ?? 'crypto';
}

// ── Transaction Sign Mapping ─────────────────────────────────────────────────

const NEGATIVE_TYPES = new Set(['buy', 'send', 'fiat_withdrawal']);
const POSITIVE_TYPES = new Set(['sell', 'receive', 'staking_reward', 'interest', 'fiat_deposit']);
const SKIPPED_TYPES = new Set(['trade', 'transfer', 'exchange_deposit', 'exchange_withdrawal']);

/**
 * Get the sign multiplier for a Coinbase transaction type.
 * Returns -1 (expense), 1 (income), or 0 (skip/internal).
 */
export function getCoinbaseTransactionSign(txnType: string): -1 | 0 | 1 {
  const t = txnType.toLowerCase();
  if (NEGATIVE_TYPES.has(t)) return -1;
  if (POSITIVE_TYPES.has(t)) return 1;
  if (SKIPPED_TYPES.has(t)) return 0;
  // Unknown types default to expense
  return -1;
}
