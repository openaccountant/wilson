import { z } from 'zod';
import { defineTool } from '../define-tool.js';
import { formatToolResult } from '../types.js';
import type { Database } from '../../db/compat-sqlite.js';
import type { TransactionInsert } from '../../db/queries.js';
import { getAccountByPlaidId, upsertAccountFromPlaid } from '../../db/net-worth-queries.js';
import { getPlaidItems, updatePlaidCursor, updatePlaidItemError, isReauthRequired } from '../../plaid/store.js';
import { syncTransactions, getBalances, PlaidError } from '../../plaid/client.js';
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
  modified: number;
  removed: number;
  skipped: number;
  linked: number;
  accountsCreated: number;
  accountsUpdated: number;
  needsReauth?: boolean;
  reauthRecommended?: boolean;
}

/**
 * Sync transactions for a single Plaid item. Shared by the tool and --sync.
 */
export async function syncPlaidItem(
  database: Database,
  item: PlaidItem,
  useProxy = false,
): Promise<PlaidSyncItemResult> {
  // Check if reauth is recommended (approaching 12-month expiry)
  const reauthRecommended = isReauthRequired(item);

  let added: SyncedTransaction[];
  let modified: SyncedTransaction[];
  let removed: string[];
  let nextCursor: string;

  try {
    const syncResult = await syncTransactions(item.accessToken, item.cursor, useProxy);
    added = syncResult.added;
    modified = syncResult.modified;
    removed = syncResult.removed;
    nextCursor = syncResult.nextCursor;
  } catch (err) {
    if (err instanceof PlaidError && err.errorCode === 'ITEM_LOGIN_REQUIRED') {
      updatePlaidItemError(item.itemId, { code: err.errorCode, message: err.message });
      return {
        institution: item.institutionName,
        added: 0,
        modified: 0,
        removed: 0,
        skipped: 0,
        linked: 0,
        accountsCreated: 0,
        accountsUpdated: 0,
        needsReauth: true,
        reauthRecommended,
      };
    }
    throw err;
  }

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

  // ── Handle modified transactions ──────────────────────────────────────────
  let modifiedCount = 0;
  if (modified.length > 0) {
    const updateStmt = database.prepare(`
      UPDATE transactions SET
        date = @date, amount = @amount, description = @description, pending = @pending,
        authorized_date = @authorized_date, merchant_name = @merchant_name,
        category = @category, category_detailed = @category_detailed, payment_channel = @payment_channel
      WHERE plaid_transaction_id = @plaid_transaction_id
    `);
    const insertStmt = database.prepare(`
      INSERT INTO transactions (date, description, amount, category, source_file, bank, account_last4,
        plaid_transaction_id, merchant_name, category_detailed, external_id, payment_channel, pending, authorized_date)
      VALUES (@date, @description, @amount, @category, @source_file, @bank, @account_last4,
        @plaid_transaction_id, @merchant_name, @category_detailed, @external_id, @payment_channel, @pending, @authorized_date)
    `);

    const updateAll = database.transaction(() => {
      for (const txn of modified) {
        const pfcDetailed = txn.personalFinanceCategory?.detailed ?? undefined;
        const pfcPrimary = txn.personalFinanceCategory?.primary ?? undefined;
        const category = txn.category.length > 0 ? txn.category[txn.category.length - 1] : null;
        const categoryDetailed = pfcDetailed ?? pfcPrimary ?? null;

        const result = updateStmt.run({
          date: txn.date,
          amount: -txn.amount,
          description: txn.name,
          pending: txn.pending ? 1 : 0,
          authorized_date: txn.authorizedDate ?? null,
          merchant_name: txn.merchantName ?? null,
          category,
          category_detailed: categoryDetailed,
          payment_channel: txn.paymentChannel ?? null,
          plaid_transaction_id: txn.transactionId,
        });

        if ((result as { changes: number }).changes > 0) {
          modifiedCount++;
        } else {
          // Edge case: modified transaction doesn't exist locally — insert it
          insertStmt.run({
            date: txn.date,
            description: txn.name,
            amount: -txn.amount,
            category,
            source_file: `plaid:${item.institutionName}`,
            bank: item.institutionName,
            account_last4: item.accounts.find((a) => a.id === txn.accountId)?.mask ?? null,
            plaid_transaction_id: txn.transactionId,
            merchant_name: txn.merchantName ?? null,
            category_detailed: categoryDetailed,
            external_id: txn.transactionId,
            payment_channel: txn.paymentChannel ?? null,
            pending: txn.pending ? 1 : 0,
            authorized_date: txn.authorizedDate ?? null,
          });
          modifiedCount++;
        }
      }
    });
    updateAll();
  }

  // ── Handle removed transactions ───────────────────────────────────────────
  let removedCount = 0;
  if (removed.length > 0) {
    const deleteStmt = database.prepare(
      'DELETE FROM transactions WHERE plaid_transaction_id = @tid'
    );
    const deleteAll = database.transaction(() => {
      for (const tid of removed) {
        const result = deleteStmt.run({ tid });
        removedCount += (result as { changes: number }).changes;
      }
    });
    deleteAll();
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
    modified: modifiedCount,
    removed: removedCount,
    skipped,
    linked,
    accountsCreated,
    accountsUpdated,
    reauthRecommended,
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
    let totalModified = 0;
    let totalRemoved = 0;
    let totalSkipped = 0;
    let totalLinked = 0;
    let totalAccountsCreated = 0;
    let totalAccountsUpdated = 0;
    const synced: PlaidSyncItemResult[] = [];

    for (const item of items) {
      const result = await syncPlaidItem(db, item, useProxy);
      totalAdded += result.added;
      totalModified += result.modified;
      totalRemoved += result.removed;
      totalSkipped += result.skipped;
      totalLinked += result.linked;
      totalAccountsCreated += result.accountsCreated;
      totalAccountsUpdated += result.accountsUpdated;
      synced.push(result);
    }

    let message = `Synced ${totalAdded} new transactions (${totalSkipped} duplicates skipped).`;
    if (totalModified > 0) message += ` ${totalModified} modified.`;
    if (totalRemoved > 0) message += ` ${totalRemoved} removed.`;
    if (totalAccountsCreated > 0) message += ` ${totalAccountsCreated} new account(s) created.`;
    if (totalAccountsUpdated > 0) message += ` ${totalAccountsUpdated} balance(s) updated.`;
    if (totalLinked > 0) message += ` ${totalLinked} transactions auto-linked to accounts.`;

    // Surface reauth warnings
    const reauthNeeded = synced.filter((r) => r.needsReauth);
    if (reauthNeeded.length > 0) {
      message += ` WARNING: ${reauthNeeded.map((r) => r.institution).join(', ')} need(s) re-authentication. Run: /connect reauth`;
    }
    const reauthRecommended = synced.filter((r) => r.reauthRecommended && !r.needsReauth);
    if (reauthRecommended.length > 0) {
      message += ` Note: ${reauthRecommended.map((r) => r.institution).join(', ')} approaching 12-month reauth deadline.`;
    }

    return formatToolResult({
      totalAdded,
      totalModified,
      totalRemoved,
      totalSkipped,
      totalLinked,
      totalAccountsCreated,
      totalAccountsUpdated,
      accounts: synced,
      message,
    });
  },
});
