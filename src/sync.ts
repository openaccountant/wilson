import { initDatabase } from './db/database.js';
import { upsertAccountFromPlaid } from './db/net-worth-queries.js';
import { getPlaidItems } from './plaid/store.js';
import { getBalances } from './plaid/client.js';
import { syncPlaidItem } from './tools/import/plaid-sync.js';
import { initPlaidSyncTool } from './tools/import/plaid-sync.js';
import { hasLicense } from './licensing/license.js';

/**
 * Dedicated sync entry point for `wilson --sync`.
 * Runs Plaid transaction sync + balance fetch without the LLM agent.
 * Suitable for cron jobs.
 */
export async function runSync(): Promise<void> {
  if (!hasLicense('pro')) {
    console.error('Bank sync requires a Pro license.');
    process.exit(1);
  }

  if (!process.env.PLAID_CLIENT_ID || !process.env.PLAID_SECRET) {
    console.error('Plaid not configured. Set PLAID_CLIENT_ID and PLAID_SECRET.');
    process.exit(1);
  }

  const db = initDatabase();
  initPlaidSyncTool(db);

  const items = getPlaidItems();
  if (items.length === 0) {
    console.log('No bank accounts linked. Use /connect to link a bank account.');
    return;
  }

  let totalAdded = 0;
  let totalLinked = 0;
  let accountsCreated = 0;

  for (const item of items) {
    console.log(`Syncing ${item.institutionName}...`);

    // 1. Sync transactions
    const result = await syncPlaidItem(db, item);
    totalAdded += result.added;
    totalLinked += result.linked;

    if (result.added > 0 || result.skipped > 0) {
      console.log(`  ${result.added} new transactions (${result.skipped} skipped)`);
    }
    if (result.linked > 0) {
      console.log(`  ${result.linked} transactions auto-linked to accounts`);
    }

    // 2. Fetch balances and upsert accounts
    try {
      const balances = await getBalances(item.accessToken);
      for (const b of balances) {
        if (b.balanceCurrent !== null) {
          const { created } = upsertAccountFromPlaid(db, {
            plaidAccountId: b.accountId,
            name: b.name,
            mask: b.mask,
            plaidType: b.type,
            plaidSubtype: b.subtype,
            balance: b.balanceCurrent,
            currency: b.isoCurrencyCode ?? 'USD',
            institution: item.institutionName,
          });
          if (created) {
            accountsCreated++;
            console.log(`  New account: ${b.name} (****${b.mask})`);
          }
        }
      }
    } catch (err) {
      console.error(`  Warning: failed to fetch balances for ${item.institutionName}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const parts: string[] = [];
  if (totalAdded > 0) parts.push(`${totalAdded} transactions synced`);
  if (totalLinked > 0) parts.push(`${totalLinked} auto-linked`);
  if (accountsCreated > 0) parts.push(`${accountsCreated} new account(s)`);

  console.log(parts.length > 0 ? `Sync complete: ${parts.join(', ')}.` : 'Sync complete. No new data.');
}
