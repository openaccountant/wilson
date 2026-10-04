// ── Offline mirror: net_worth driver (summary, balance_sheet) ────────────────
//
// Async mirror counterpart of the `net_worth` READ tool
// (src/tools/net-worth/net-worth.ts), computed from the v4 mirror's `accounts`
// and `loans` tables. The SQL is a verbatim copy of getAccounts,
// getNetWorthSummary and getEquitySummary (src/db/net-worth-queries.ts); the
// result shape is exactly what the tool returns after executeRead unwraps
// `{data}` (key order included). Parity: src/__tests__/mirror-tool-parity.test.ts.
//
// `trend` is NOT served here: it is licensed server-side (net-worth.ts hasLicense
// 'pro') and stays server-only (DECISIONS Q2).
//
// Pure module: no browser glue, no bun:sqlite.

import { SUBTYPE_LABELS, type AccountSubtype } from '../../../../tools/net-worth/account-types.js';
import type { SqliteBinding } from './types.js';

export type NetWorthAction = 'summary' | 'balance_sheet';

interface AccountRow {
  id: number;
  name: string;
  account_type: string;
  account_subtype: string;
  institution: string | null;
  current_balance: number;
  is_active: number;
}

interface SubtypeTotal {
  subtype: string;
  total: number;
  count: number;
}

interface EquityRow {
  assetName: string;
  assetValue: number;
  loanBalance: number;
  equity: number;
  equityPercent: number;
}

/** Copy of getAccounts(db, { active: true }). */
export async function mirrorGetActiveAccounts(db: SqliteBinding): Promise<AccountRow[]> {
  return (await db
    .prepare('SELECT * FROM accounts WHERE is_active = @active ORDER BY account_type, account_subtype, name')
    .all({ active: 1 })) as unknown as AccountRow[];
}

/** Copy of getNetWorthSummary. */
export async function mirrorGetNetWorthSummary(db: SqliteBinding) {
  const accounts = await mirrorGetActiveAccounts(db);

  const assetsBySubtype = (await db
    .prepare(`
    SELECT account_subtype AS subtype, SUM(current_balance) AS total, COUNT(*) AS count
    FROM accounts WHERE account_type = 'asset' AND is_active = 1
    GROUP BY account_subtype ORDER BY total DESC
  `)
    .all()) as unknown as SubtypeTotal[];

  const liabilitiesBySubtype = (await db
    .prepare(`
    SELECT account_subtype AS subtype, SUM(current_balance) AS total, COUNT(*) AS count
    FROM accounts WHERE account_type = 'liability' AND is_active = 1
    GROUP BY account_subtype ORDER BY total DESC
  `)
    .all()) as unknown as SubtypeTotal[];

  const totalAssets = assetsBySubtype.reduce((sum, r) => sum + r.total, 0);
  const totalLiabilities = liabilitiesBySubtype.reduce((sum, r) => sum + r.total, 0);

  return {
    totalAssets,
    totalLiabilities,
    netWorth: totalAssets - totalLiabilities,
    assetsBySubtype,
    liabilitiesBySubtype,
    accounts,
  };
}

/** Copy of getEquitySummary. */
export async function mirrorGetEquitySummary(db: SqliteBinding): Promise<EquityRow[]> {
  const rows = (await db
    .prepare(`
    SELECT
      a.name AS assetName,
      a.current_balance AS assetValue,
      la.current_balance AS loanBalance
    FROM loans l
    JOIN accounts la ON la.id = l.account_id
    JOIN accounts a ON a.id = l.linked_asset_id
    WHERE la.is_active = 1 AND a.is_active = 1
    ORDER BY a.current_balance DESC
  `)
    .all()) as unknown as { assetName: string; assetValue: number; loanBalance: number }[];

  return rows.map((r) => {
    const equity = r.assetValue - r.loanBalance;
    return {
      assetName: r.assetName,
      assetValue: r.assetValue,
      loanBalance: r.loanBalance,
      equity,
      equityPercent: r.assetValue > 0 ? Math.round((equity / r.assetValue) * 100) : 0,
    };
  });
}

const label = (subtype: string): string => SUBTYPE_LABELS[subtype as AccountSubtype] ?? subtype;

/**
 * The `net_worth` tool's `.data` for `summary` and `balance_sheet`. Keys are
 * built in the tool's order and `equity` is omitted (not undefined) when there
 * are no equity rows, so JSON.stringify output matches byte for byte.
 */
export async function mirrorNetWorth(db: SqliteBinding, action: NetWorthAction): Promise<Record<string, unknown>> {
  const summary = await mirrorGetNetWorthSummary(db);

  if (action === 'summary') {
    if (summary.accounts.length === 0) {
      return { message: 'No accounts configured. Add accounts to track net worth.' };
    }
    return {
      netWorth: summary.netWorth,
      totalAssets: summary.totalAssets,
      totalLiabilities: summary.totalLiabilities,
      assets: summary.assetsBySubtype.map((a) => ({ subtype: label(a.subtype), total: a.total, count: a.count })),
      liabilities: summary.liabilitiesBySubtype.map((l) => ({ subtype: label(l.subtype), total: l.total, count: l.count })),
    };
  }

  if (summary.accounts.length === 0) {
    return { message: 'No accounts configured.' };
  }
  const equity = await mirrorGetEquitySummary(db);
  const row = (a: AccountRow) => ({
    id: a.id,
    name: a.name,
    subtype: label(a.account_subtype),
    balance: a.current_balance,
    institution: a.institution,
  });
  const out: Record<string, unknown> = {
    netWorth: summary.netWorth,
    assets: summary.accounts.filter((a) => a.account_type === 'asset').map(row),
    liabilities: summary.accounts.filter((a) => a.account_type === 'liability').map(row),
  };
  if (equity.length > 0) out.equity = equity;
  out.totalAssets = summary.totalAssets;
  out.totalLiabilities = summary.totalLiabilities;
  return out;
}

/** Starting cash for the forecast: active checking / savings / cash assets, summed in getAccounts order. */
export async function mirrorStartingCash(db: SqliteBinding): Promise<number> {
  const cashSubtypes = new Set(['checking', 'savings', 'cash']);
  const accounts = await mirrorGetActiveAccounts(db);
  return accounts
    .filter((a) => a.account_type === 'asset' && a.is_active && cashSubtypes.has(a.account_subtype))
    .reduce((sum, a) => sum + a.current_balance, 0);
}
