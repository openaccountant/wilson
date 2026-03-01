import { z } from 'zod';
import { defineTool } from '../define-tool.js';
import { formatToolResult } from '../types.js';
import type { Database } from '../../db/compat-sqlite.js';
import { insertTransactions, type TransactionInsert } from '../../db/queries.js';
import { getPlaidItems, updatePlaidCursor } from '../../plaid/store.js';
import { syncTransactions } from '../../plaid/client.js';
import { hasLicense } from '../../licensing/license.js';

let db: Database;

export function initPlaidSyncTool(database: Database) {
  db = database;
}

export const plaidSyncTool = defineTool({
  name: 'plaid_sync',
  description: 'Sync transactions from all linked bank accounts via Plaid.',
  schema: z.object({}),
  func: async () => {
    // Pro license gate
    if (!hasLicense('pro')) {
      return formatToolResult({
        error: 'Bank sync is a Pro feature. Run `/license` for details or visit openaccountant.ai/pricing.',
      });
    }

    if (!process.env.PLAID_CLIENT_ID || !process.env.PLAID_SECRET) {
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
    const synced: Array<{ institution: string; added: number; skipped: number }> = [];

    for (const item of items) {
      const { added, nextCursor } = await syncTransactions(item.accessToken, item.cursor);

      // Build account name lookup
      const accountMap = new Map(item.accounts.map((a) => [a.id, a.name]));

      // Check for existing plaid_transaction_ids to dedup
      const existingIds = new Set<string>();
      if (added.length > 0) {
        for (const txn of added) {
          const row = db.prepare(
            'SELECT plaid_transaction_id FROM transactions WHERE plaid_transaction_id = @tid'
          ).get({ tid: txn.transactionId }) as { plaid_transaction_id: string } | undefined;
          if (row) {
            existingIds.add(row.plaid_transaction_id);
          }
        }
      }

      const newTxns: TransactionInsert[] = [];
      let skipped = 0;

      for (const txn of added) {
        if (existingIds.has(txn.transactionId)) {
          skipped++;
          continue;
        }

        // Map Plaid personal_finance_category to category_detailed
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
          // New columns from schema migration
          merchant_name: txn.merchantName ?? undefined,
          category_detailed: pfcDetailed ?? pfcPrimary ?? undefined,
          external_id: txn.transactionId,
          payment_channel: txn.paymentChannel ?? undefined,
          pending: txn.pending ? 1 : 0,
          authorized_date: txn.authorizedDate ?? undefined,
        });
      }

      if (newTxns.length > 0) {
        // Insert with plaid_transaction_id + new columns for dedup and enrichment
        const stmt = db.prepare(`
          INSERT INTO transactions (date, description, amount, category, source_file, bank, account_last4,
            plaid_transaction_id, merchant_name, category_detailed, external_id, payment_channel, pending, authorized_date)
          VALUES (@date, @description, @amount, @category, @source_file, @bank, @account_last4,
            @plaid_transaction_id, @merchant_name, @category_detailed, @external_id, @payment_channel, @pending, @authorized_date)
        `);

        const insertAll = db.transaction(() => {
          for (let i = 0; i < newTxns.length; i++) {
            const txn = newTxns[i];

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

      updatePlaidCursor(item.itemId, nextCursor);

      totalAdded += newTxns.length;
      totalSkipped += skipped;
      synced.push({ institution: item.institutionName, added: newTxns.length, skipped });
    }

    return formatToolResult({
      totalAdded,
      totalSkipped,
      accounts: synced,
      message: `Synced ${totalAdded} new transactions (${totalSkipped} duplicates skipped).`,
    });
  },
});
