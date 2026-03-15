import { initDatabase } from './db/database.js';
import { getPlaidItems } from './plaid/store.js';
import { hasLocalPlaidCreds } from './plaid/client.js';
import { syncPlaidItem } from './tools/import/plaid-sync.js';
import { initPlaidSyncTool } from './tools/import/plaid-sync.js';
import { initMonarchTool, monarchImportTool } from './tools/import/monarch.js';
import { initFireflyTool, fireflyImportTool } from './tools/import/firefly.js';
import { getCoinbaseConnections } from './coinbase/store.js';
import { hasLocalCoinbaseCreds } from './coinbase/client.js';
import { syncCoinbaseConnection } from './tools/import/coinbase-sync.js';
import { initCoinbaseSyncTool } from './tools/import/coinbase-sync.js';
import { hasLicense } from './licensing/license.js';
import { headlessUpsell } from './licensing/upsell.js';

interface SyncResult {
  name: string;
  added: number;
  linked: number;
  skipped: number;
  error?: string;
}

/**
 * Dedicated sync entry point for `wilson --sync`.
 * Runs all configured integrations (Plaid, Monarch, Firefly III) without the LLM agent.
 * Suitable for cron jobs. Each integration is isolated — one failure doesn't block others.
 */
export async function runSync(): Promise<void> {
  if (!hasLicense('pro')) {
    headlessUpsell('Bank sync');
  }

  const plaidUseProxy = !hasLocalPlaidCreds() && hasLicense('pro');
  const hasPlaid = hasLocalPlaidCreds() || plaidUseProxy;
  const hasMonarch = !!(process.env.MONARCH_TOKEN || (process.env.MONARCH_EMAIL && process.env.MONARCH_PASSWORD));
  const hasFirefly = !!(process.env.FIREFLY_API_URL && process.env.FIREFLY_API_TOKEN);
  const coinbaseUseProxy = !hasLocalCoinbaseCreds() && hasLicense('pro');
  const hasCoinbase = hasLocalCoinbaseCreds() || coinbaseUseProxy || getCoinbaseConnections().length > 0;

  if (!hasPlaid && !hasMonarch && !hasFirefly && !hasCoinbase) {
    console.log(`No integrations configured. Set environment variables to enable sync:

  Plaid:    PLAID_CLIENT_ID + PLAID_SECRET (or Pro license for zero-config)
  Monarch:  MONARCH_TOKEN (or MONARCH_EMAIL + MONARCH_PASSWORD)
  Firefly:  FIREFLY_API_URL + FIREFLY_API_TOKEN
  Coinbase: COINBASE_KEY_NAME + COINBASE_PRIVATE_KEY (or /connect-coinbase)`);
    return;
  }

  const db = initDatabase();
  const results: SyncResult[] = [];

  // ── Plaid ──────────────────────────────────────────────────────────────
  if (hasPlaid) {
    try {
      initPlaidSyncTool(db);
      const items = getPlaidItems();

      if (items.length === 0) {
        console.log('[Plaid] No bank accounts linked. Use /connect to link a bank account.');
      } else {
        let totalAdded = 0;
        let totalLinked = 0;
        let totalSkipped = 0;

        for (const item of items) {
          console.log(`[Plaid] Syncing ${item.institutionName}...`);
          const result = await syncPlaidItem(db, item, plaidUseProxy);
          totalAdded += result.added;
          totalLinked += result.linked;
          totalSkipped += result.skipped;

          if (result.added > 0 || result.skipped > 0) {
            console.log(`  ${result.added} new transactions (${result.skipped} skipped)`);
          }
          if (result.accountsCreated > 0) {
            console.log(`  ${result.accountsCreated} new account(s) created`);
          }
          if (result.accountsUpdated > 0) {
            console.log(`  ${result.accountsUpdated} balance(s) updated`);
          }
          if (result.linked > 0) {
            console.log(`  ${result.linked} transactions auto-linked to accounts`);
          }
        }

        results.push({ name: 'Plaid', added: totalAdded, linked: totalLinked, skipped: totalSkipped });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Plaid] Sync failed: ${msg}`);
      results.push({ name: 'Plaid', added: 0, linked: 0, skipped: 0, error: msg });
    }
  }

  // ── Monarch ────────────────────────────────────────────────────────────
  if (hasMonarch) {
    try {
      console.log('[Monarch] Syncing...');
      initMonarchTool(db);
      const raw = await monarchImportTool.func({});
      const parsed = JSON.parse(raw as string);
      const data = parsed.data ?? {};

      if (data.error) {
        console.error(`[Monarch] ${data.error}`);
        results.push({ name: 'Monarch', added: 0, linked: 0, skipped: 0, error: data.error });
      } else {
        const added = data.transactionsImported ?? 0;
        const linked = data.autoLinked ?? 0;
        const skipped = data.skipped ?? 0;
        console.log(`[Monarch] ${data.message ?? `${added} imported, ${skipped} skipped`}`);
        results.push({ name: 'Monarch', added, linked, skipped });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Monarch] Sync failed: ${msg}`);
      results.push({ name: 'Monarch', added: 0, linked: 0, skipped: 0, error: msg });
    }
  }

  // ── Firefly III ────────────────────────────────────────────────────────
  if (hasFirefly) {
    try {
      console.log('[Firefly] Syncing...');
      initFireflyTool(db);
      const raw = await fireflyImportTool.func({});
      const parsed = JSON.parse(raw as string);
      const data = parsed.data ?? {};

      if (data.error) {
        console.error(`[Firefly] ${data.error}`);
        results.push({ name: 'Firefly', added: 0, linked: 0, skipped: 0, error: data.error });
      } else {
        const added = data.transactionsImported ?? 0;
        const linked = data.autoLinked ?? 0;
        const skipped = data.skipped ?? 0;
        console.log(`[Firefly] ${data.message ?? `${added} imported, ${skipped} skipped`}`);
        results.push({ name: 'Firefly', added, linked, skipped });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Firefly] Sync failed: ${msg}`);
      results.push({ name: 'Firefly', added: 0, linked: 0, skipped: 0, error: msg });
    }
  }

  // ── Coinbase ────────────────────────────────────────────────────────────
  if (hasCoinbase) {
    try {
      initCoinbaseSyncTool(db);
      const connections = getCoinbaseConnections();

      if (connections.length === 0) {
        console.log('[Coinbase] No accounts linked. Use /connect-coinbase to link your Coinbase account.');
      } else {
        let totalAdded = 0;
        let totalLinked = 0;
        let totalSkipped = 0;

        for (const conn of connections) {
          const accountNames = conn.accounts.map((a) => a.name).join(', ');
          console.log(`[Coinbase] Syncing ${accountNames || 'accounts'}...`);
          const result = await syncCoinbaseConnection(db, conn, coinbaseUseProxy);
          totalAdded += result.added;
          totalLinked += result.linked;
          totalSkipped += result.skipped;

          if (result.added > 0 || result.skipped > 0) {
            console.log(`  ${result.added} new transactions (${result.skipped} skipped)`);
          }
          if (result.accountsCreated > 0) {
            console.log(`  ${result.accountsCreated} new account(s) created`);
          }
          if (result.accountsUpdated > 0) {
            console.log(`  ${result.accountsUpdated} balance(s) updated`);
          }
          if (result.linked > 0) {
            console.log(`  ${result.linked} transactions auto-linked to accounts`);
          }
        }

        results.push({ name: 'Coinbase', added: totalAdded, linked: totalLinked, skipped: totalSkipped });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Coinbase] Sync failed: ${msg}`);
      results.push({ name: 'Coinbase', added: 0, linked: 0, skipped: 0, error: msg });
    }
  }

  // ── Summary ────────────────────────────────────────────────────────────
  const totalAdded = results.reduce((s, r) => s + r.added, 0);
  const totalLinked = results.reduce((s, r) => s + r.linked, 0);
  const errors = results.filter((r) => r.error);

  const parts: string[] = [];
  if (totalAdded > 0) parts.push(`${totalAdded} transactions synced`);
  if (totalLinked > 0) parts.push(`${totalLinked} auto-linked`);
  if (errors.length > 0) parts.push(`${errors.length} integration(s) failed`);

  console.log(parts.length > 0 ? `\nSync complete: ${parts.join(', ')}.` : '\nSync complete. No new data.');
}
