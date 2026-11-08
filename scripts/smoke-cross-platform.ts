/**
 * Cross-platform smoke test (CI runs it on Linux, macOS and Windows).
 *
 *   bun run scripts/smoke-cross-platform.ts
 *
 * Opens a throwaway profile database, imports a Chase CSV fixture through the
 * real csv_import tool, re-imports it to prove dedup, and round-trips a secret
 * through this platform's default secret backend. Exits non-zero on any failure.
 * Never touches ~/.openaccountant: everything lives in a temp dir.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// The database itself must not reach the real OS keychain (on a Mac with SQLCipher it would
// leave a db-encryption-smoke entry behind). The explicit store below still tests the backend.
process.env.OA_SECRET_BACKEND ??= 'none';

const root = mkdtempSync(join(tmpdir(), 'wilson-smoke-'));
const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = join(repo, 'demos', 'fixtures', 'june-2026-chase.csv');

function fail(msg: string): never {
  console.error(`SMOKE FAIL: ${msg}`);
  process.exit(1);
}

try {
  const { initDatabase } = await import('../src/db/database.js');
  const { initImportTool, csvImportTool } = await import('../src/tools/import/csv-import.js');
  const { encryptionAvailable } = await import('../src/db/sqlcipher-dylib.js');

  const dbPath = join(root, 'profiles', 'smoke', 'data.db');
  const db = initDatabase(dbPath, 'smoke');
  console.log(`platform=${platform()} encryption=${encryptionAvailable()} db=${dbPath}`);

  initImportTool(db);
  const first = JSON.parse(await csvImportTool.func({ filePath: fixture }));
  if (!first.data?.success || !(first.data.transactionsImported > 0)) fail(`import: ${JSON.stringify(first)}`);
  console.log(`imported ${first.data.transactionsImported} transactions (${first.data.formatDetected})`);

  const second = JSON.parse(await csvImportTool.func({ filePath: fixture }));
  if (!second.data?.alreadyImported) fail(`re-import should be a no-op: ${JSON.stringify(second)}`);

  const { n } = db.prepare('SELECT count(*) AS n FROM transactions').get() as { n: number };
  if (n !== first.data.transactionsImported) fail(`row count ${n} != imported ${first.data.transactionsImported}`);
  db.close();

  // Secret round-trip through the default backend for this OS, scoped to the temp dir.
  const { createSecretStore } = await import('../src/utils/keychain.js');
  if (platform() !== 'darwin') {
    const store = createSecretStore({ oaRoot: root, env: {} });
    const secret = `smoke-${Date.now()}`;
    if (!store.set('smoke-test', secret)) fail(`secret set failed (backend ${store.primary.name})`);
    if (store.get('smoke-test') !== secret) fail(`secret get mismatch (backend ${store.primary.name})`);
    store.delete('smoke-test');
    console.log(`secret backend ${store.primary.name}: ok`);
  }

  console.log('SMOKE OK');
} finally {
  rmSync(root, { recursive: true, force: true });
}
