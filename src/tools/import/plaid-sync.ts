import { z } from 'zod';
import { defineTool } from '../define-tool.js';
import { formatToolResult } from '../types.js';
import type { Database } from '../../db/compat-sqlite.js';
import type { TransactionInsert } from '../../db/queries.js';
import { getAccountByPlaidId, upsertAccountFromPlaid } from '../../db/net-worth-queries.js';
import { getPlaidItems, updatePlaidCursor } from '../../plaid/store.js';
import { syncTransactions, getBalances } from '../../plaid/client.js';
import type { SyncedTransaction } from '../../plaid/client.js';
import type { PlaidItem } from '../../plaid/store.js';
import { hasLicense } from '../../licensing/license.js';
import { toolUpsell } from '../../licensing/upsell.js';
import { hasLocalPlaidCreds } from '../../plaid/client.js';

let db: Database;

export function initPlaidSyncTool(database: Database) {
  db = database;
}

export interface PlaidSyncItemResult {
  institution: string;
  added: number;
  skipped: number;
  linked: number;
  accountsCreated: number;
  accountsUpdated: number;
}

/**
 * Sync transactions for a single Plaid item. Shared by the tool and --sync.
 */
export async function syncPlaidItem(
  database: Database,
  item: PlaidItem,
  useProxy = false,
): Promise<PlaidSyncItemResult> {
  const { added, nextCursor } = await syncTransactions(item.accessToken, item.cursor, useProxy);

  // Check for existing plaid_transaction_ids to dedup
  const existingIds = new Set<string>();
  if (added.length > 0) {
    for (const txn of added) {
      const row = database.prepare(
        'SELECT plaid_transaction_id FROM transactions WHERE plaid_transaction_id = @tid'
      ).get({ tid: txn.transactionId }) as { plaid_transaction_id: string } | undefined;
      if (row) {
        existingIds.add(row.plaid_transaction_id);
      }
    }
  }

  const newTxns: TransactionInsert[] = [];
  // Track which Plaid account ID each new transaction belongs to
  const txnPlaidAccountIds: string[] = [];
  let skipped = 0;

  for (const txn of added) {
    if (existingIds.has(txn.transactionId)) {
      skipped++;
      continue;
    }

    const pfcDetailed = txn.personalFinanceCategory?.detailed ?? undefined;
    const pfcPrimary = txn.personalFinanceCategory?.primary ?? undefined;

    newTxns.push({
      date: txn.date,
      description: txn.name,
      // Plaid uses positive for debits, negative for credits — flip for OA convention
      amount: -txn.amount,
      category: txn.category.length > 0 ? txn.category[txn.category.length - 1] : undefined,
      source_file: `plaid:${item.institutionName}`,
      bank: item.institutionName,
      account_last4: item.accounts.find((a) => a.id === txn.accountId)?.mask ?? undefined,
      merchant_name: txn.merchantName ?? undefined,
      category_detailed: pfcDetailed ?? pfcPrimary ?? undefined,
      external_id: txn.transactionId,
      payment_channel: txn.paymentChannel ?? undefined,
      pending: txn.pending ? 1 : 0,
      authorized_date: txn.authorizedDate ?? undefined,
    });
    txnPlaidAccountIds.push(txn.accountId);
  }

  if (newTxns.length > 0) {
    const stmt = database.prepare(`
      INSERT INTO transactions (date, description, amount, category, source_file, bank, account_last4,
        plaid_transaction_id, merchant_name, category_detailed, external_id, payment_channel, pending, authorized_date)
      VALUES (@date, @description, @amount, @category, @source_file, @bank, @account_last4,
        @plaid_transaction_id, @merchant_name, @category_detailed, @external_id, @payment_channel, @pending, @authorized_date)
    `);

    const insertAll = database.transaction(() => {
      for (const txn of newTxns) {
        stmt.run({
          date: txn.date,
          description: txn.description,
          amount: txn.amount,
          category: txn.category ?? null,
          source_file: txn.source_file ?? null,
          bank: txn.bank ?? null,
          account_last4: txn.account_last4 ?? null,
          plaid_transaction_id: txn.external_id ?? null,
          merchant_name: txn.merchant_name ?? null,
          category_detailed: txn.category_detailed ?? null,
          external_id: txn.external_id ?? null,
          payment_channel: txn.payment_channel ?? null,
          pending: txn.pending ?? 0,
          authorized_date: txn.authorized_date ?? null,
        });
      }
    });
    insertAll();
  }

  // Upsert accounts from Plaid balance data so accounts exist before linking
  let accountsCreated = 0;
  let accountsUpdated = 0;
  try {
    const balances = await getBalances(item.accessToken, useProxy);
    for (const b of balances) {
      if (b.balanceCurrent !== null) {
        const { created } = upsertAccountFromPlaid(database, {
          plaidAccountId: b.accountId,
          name: b.name,
          mask: b.mask,
          plaidType: b.type,
          plaidSubtype: b.subtype,
          balance: b.balanceCurrent,
          currency: b.isoCurrencyCode ?? 'USD',
          institution: item.institutionName,
        });
        if (created) accountsCreated++;
        else accountsUpdated++;
      }
    }
  } catch {
    // Non-fatal — balance fetch may fail but transactions are already synced
  }

  // Auto-link newly inserted transactions to their accounts by plaid_account_id
  let linked = 0;
  if (newTxns.length > 0) {
    // Build a map of plaid_account_id → our account_id
    const plaidAccountIds = [...new Set(txnPlaidAccountIds)];
    const accountIdMap = new Map<string, number>();
    for (const plaidAccountId of plaidAccountIds) {
      const account = getAccountByPlaidId(database, plaidAccountId);
      if (account) {
        accountIdMap.set(plaidAccountId, account.id);
      }
    }

    if (accountIdMap.size > 0) {
      const linkStmt = database.prepare(
        'UPDATE transactions SET account_id = @accountId WHERE plaid_transaction_id = @txnId AND account_id IS NULL'
      );
      const linkAll = database.transaction(() => {
        for (let i = 0; i < newTxns.length; i++) {
          const plaidAccountId = txnPlaidAccountIds[i];
          const accountId = accountIdMap.get(plaidAccountId);
          if (accountId && newTxns[i].external_id) {
            const result = linkStmt.run({ accountId, txnId: newTxns[i].external_id });
            linked += (result as { changes: number }).changes;
          }
        }
      });
      linkAll();
    }
  }

  updatePlaidCursor(item.itemId, nextCursor);

  return {
    institution: item.institutionName,
    added: newTxns.length,
    skipped,
    linked,
    accountsCreated,
    accountsUpdated,
  };
}

export const plaidSyncTool = defineTool({
  name: 'plaid_sync',
  description: 'Sync transactions from all linked bank accounts via Plaid.',
  schema: z.object({}),
  func: async () => {
    if (!hasLicense('pro')) return toolUpsell('Bank sync');

    const useProxy = !hasLocalPlaidCreds() && hasLicense('pro');
    if (!useProxy && !hasLocalPlaidCreds()) {
      return formatToolResult({
        message: 'Plaid not configured. Set PLAID_CLIENT_ID and PLAID_SECRET.',
      });
    }

    const items = getPlaidItems();
    if (items.length === 0) {
      return formatToolResult({
        message: 'No bank accounts linked. Use /connect to link a bank account.',
      });
    }

    let totalAdded = 0;
    let totalSkipped = 0;
    let totalLinked = 0;
    let totalAccountsCreated = 0;
    let totalAccountsUpdated = 0;
    const synced: PlaidSyncItemResult[] = [];

    for (const item of items) {
      const result = await syncPlaidItem(db, item, useProxy);
      totalAdded += result.added;
      totalSkipped += result.skipped;
      totalLinked += result.linked;
      totalAccountsCreated += result.accountsCreated;
      totalAccountsUpdated += result.accountsUpdated;
      synced.push(result);
    }

    let message = `Synced ${totalAdded} new transactions (${totalSkipped} duplicates skipped).`;
    if (totalAccountsCreated > 0) message += ` ${totalAccountsCreated} new account(s) created.`;
    if (totalAccountsUpdated > 0) message += ` ${totalAccountsUpdated} balance(s) updated.`;
    if (totalLinked > 0) message += ` ${totalLinked} transactions auto-linked to accounts.`;

    return formatToolResult({
      totalAdded,
      totalSkipped,
      totalLinked,
      totalAccountsCreated,
      totalAccountsUpdated,
      accounts: synced,
      message,
    });
  },
});
