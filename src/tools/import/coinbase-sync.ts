import { z } from 'zod';
import { defineTool } from '../define-tool.js';
import { formatToolResult } from '../types.js';
import type { Database } from '../../db/compat-sqlite.js';
import { getAccountByPlaidId, upsertAccountFromCoinbase } from '../../db/net-worth-queries.js';
import { getCoinbaseConnections, updateLastSyncedAt } from '../../coinbase/store.js';
import type { CoinbaseConnection } from '../../coinbase/store.js';
import { getAccounts, getTransactions, hasLocalCoinbaseCreds } from '../../coinbase/client.js';
import { getCoinbaseTransactionSign } from '../../coinbase/account-mapping.js';
import { hasLicense } from '../../licensing/license.js';
import { toolUpsell } from '../../licensing/upsell.js';

let db: Database;

export function initCoinbaseSyncTool(database: Database) {
  db = database;
}

export interface CoinbaseSyncResult {
  added: number;
  skipped: number;
  linked: number;
  accountsCreated: number;
  accountsUpdated: number;
}

/**
 * Sync transactions for a single Coinbase connection.
 * Shared by the tool and --sync.
 */
export async function syncCoinbaseConnection(
  database: Database,
  conn: CoinbaseConnection,
  useProxy: boolean,
): Promise<CoinbaseSyncResult> {
  // Fetch accounts — JWT is generated per-request, no refresh needed
  const accounts = await getAccounts(conn, useProxy);

  // Upsert accounts with balance snapshots
  let accountsCreated = 0;
  let accountsUpdated = 0;
  for (const acct of accounts) {
    const balance = parseFloat(acct.native_balance.amount);
    if (isNaN(balance)) continue;
    const { created } = upsertAccountFromCoinbase(database, {
      coinbaseAccountId: acct.id,
      name: acct.name,
      coinbaseType: acct.type,
      balance,
      currency: acct.native_balance.currency,
    });
    if (created) accountsCreated++;
    else accountsUpdated++;
  }

  // Fetch and insert transactions per account
  let totalAdded = 0;
  let totalSkipped = 0;
  let totalLinked = 0;

  for (const acct of accounts) {
    const txns = await getTransactions(conn, acct.id, useProxy);

    // Filter to completed only
    const completed = txns.filter((t) => t.status === 'completed');

    // Check for existing external_ids to dedup
    const externalIds = completed.map((t) => `coinbase:${t.id}`);
    const existingIds = new Set<string>();
    for (const eid of externalIds) {
      const row = database.prepare(
        'SELECT external_id FROM transactions WHERE external_id = @eid',
      ).get({ eid }) as { external_id: string } | undefined;
      if (row) existingIds.add(row.external_id);
    }

    const newTxns: Array<{
      date: string;
      description: string;
      amount: number;
      source_file: string;
      bank: string;
      external_id: string;
      category: string | null;
      coinbaseAccountId: string;
    }> = [];

    for (const txn of completed) {
      const externalId = `coinbase:${txn.id}`;
      if (existingIds.has(externalId)) {
        totalSkipped++;
        continue;
      }

      const sign = getCoinbaseTransactionSign(txn.type);
      if (sign === 0) {
        totalSkipped++;
        continue;
      }

      const nativeAmount = parseFloat(txn.native_amount.amount);
      if (isNaN(nativeAmount)) continue;

      // Apply sign: OA convention is negative=expense, positive=income
      const amount = sign * Math.abs(nativeAmount);

      const description = txn.details?.title ?? txn.description ?? txn.type;

      newTxns.push({
        date: txn.created_at.slice(0, 10),
        description,
        amount,
        source_file: 'coinbase',
        bank: 'Coinbase',
        external_id: externalId,
        category: txn.type,
        coinbaseAccountId: acct.id,
      });
    }

    if (newTxns.length > 0) {
      const stmt = database.prepare(`
        INSERT INTO transactions (date, description, amount, category, source_file, bank, external_id)
        VALUES (@date, @description, @amount, @category, @source_file, @bank, @external_id)
      `);

      const insertAll = database.transaction(() => {
        for (const txn of newTxns) {
          stmt.run({
            date: txn.date,
            description: txn.description,
            amount: txn.amount,
            category: txn.category,
            source_file: txn.source_file,
            bank: txn.bank,
            external_id: txn.external_id,
          });
        }
      });
      insertAll();
      totalAdded += newTxns.length;

      // Auto-link to accounts
      const account = getAccountByPlaidId(database, acct.id);
      if (account) {
        const linkStmt = database.prepare(
          'UPDATE transactions SET account_id = @accountId WHERE external_id = @externalId AND account_id IS NULL',
        );
        const linkAll = database.transaction(() => {
          for (const txn of newTxns) {
            const result = linkStmt.run({ accountId: account.id, externalId: txn.external_id });
            totalLinked += (result as { changes: number }).changes;
          }
        });
        linkAll();
      }
    }
  }

  updateLastSyncedAt(conn.keyName);

  return {
    added: totalAdded,
    skipped: totalSkipped,
    linked: totalLinked,
    accountsCreated,
    accountsUpdated,
  };
}

export const coinbaseSyncTool = defineTool({
  name: 'coinbase_sync',
  description: 'Sync transactions from linked Coinbase crypto accounts.',
  schema: z.object({}),
  func: async () => {
    if (!hasLicense('pro')) return toolUpsell('Coinbase sync');

    const useProxy = !hasLocalCoinbaseCreds() && hasLicense('pro');
    if (!useProxy && !hasLocalCoinbaseCreds()) {
      return formatToolResult({
        message: 'Coinbase not configured. Set COINBASE_KEY_NAME and COINBASE_PRIVATE_KEY, or use /connect-coinbase.',
      });
    }

    const connections = getCoinbaseConnections();
    if (connections.length === 0) {
      return formatToolResult({
        message: 'No Coinbase accounts linked. Use /connect-coinbase to link your account.',
      });
    }

    let totalAdded = 0;
    let totalSkipped = 0;
    let totalLinked = 0;
    let totalAccountsCreated = 0;
    let totalAccountsUpdated = 0;

    for (const conn of connections) {
      const result = await syncCoinbaseConnection(db, conn, useProxy);
      totalAdded += result.added;
      totalSkipped += result.skipped;
      totalLinked += result.linked;
      totalAccountsCreated += result.accountsCreated;
      totalAccountsUpdated += result.accountsUpdated;
    }

    let message = `Synced ${totalAdded} new Coinbase transactions (${totalSkipped} skipped).`;
    if (totalAccountsCreated > 0) message += ` ${totalAccountsCreated} new account(s) created.`;
    if (totalAccountsUpdated > 0) message += ` ${totalAccountsUpdated} balance(s) updated.`;
    if (totalLinked > 0) message += ` ${totalLinked} transactions auto-linked to accounts.`;

    return formatToolResult({
      totalAdded,
      totalSkipped,
      totalLinked,
      totalAccountsCreated,
      totalAccountsUpdated,
      message,
    });
  },
});
