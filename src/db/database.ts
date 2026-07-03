import { Database } from './compat-sqlite.js';
import { existsSync, mkdirSync } from 'fs';
import { basename, dirname } from 'path';
import { runMigrations } from './migrations.js';
import { getActiveProfile } from '../profile/active.js';
import { encryptionAvailable, initSqlcipher } from './sqlcipher-dylib.js';
import { getOrInitEncryptionKey } from './encryption-key.js';
import { isPlaintextSqliteFile, migrateToEncrypted } from './encrypt-migrate.js';
import { logger } from '../utils/logger.js';

/** Warn at most once per process when encryption is unavailable on macOS. */
let warnedNoEncryption = false;

/**
 * Derive the profile name from a database path. Wilson databases always live at
 * `.../profiles/<name>/data.db`, so the parent directory name is the profile.
 * Used when a caller passes an explicit path (e.g. db-manager) without a name.
 */
function deriveProfileName(dbPath: string): string {
  return basename(dirname(dbPath));
}

/**
 * Open the profile database, migrations run, ready to use.
 *
 * On macOS with the SQLCipher dylib installed the database is encrypted at rest
 * transparently: a per-profile key is fetched from (or created in) the OS
 * keychain, an existing plaintext database is migrated in place on first
 * encrypted open, and the connection is keyed. Everywhere else — no dylib, or a
 * `:memory:` database — this opens plain SQLite, unchanged.
 *
 * @param dbPath      Database file path; defaults to the active profile's DB.
 * @param profileName Profile whose keychain key to use; defaults to the active
 *                    profile (or, when only `dbPath` is given, is derived from it).
 */
export function initDatabase(dbPath?: string, profileName?: string): Database {
  // setCustomSQLite MUST run before ANY Database is constructed in this process
  // (Bun throws "SQLite already loaded" otherwise). Idempotent and never throws.
  initSqlcipher();

  const resolvedPath = dbPath ?? getActiveProfile().database;

  if (resolvedPath !== ':memory:') {
    const dir = dirname(resolvedPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  const db = openConnection(resolvedPath, profileName, dbPath !== undefined);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

/**
 * Resolve encryption and open the underlying connection. Split out so the
 * WAL/foreign-keys/migrations flow above stays identical for keyed and plain DBs.
 */
function openConnection(
  resolvedPath: string,
  explicitProfileName: string | undefined,
  pathWasExplicit: boolean,
): Database {
  // :memory: databases hold no at-rest data and are never keyed — this also
  // keeps the test-suite invariant intact (see compat-sqlite.ts).
  if (resolvedPath === ':memory:') {
    return new Database(resolvedPath);
  }

  if (!encryptionAvailable()) {
    if (process.platform === 'darwin' && !warnedNoEncryption) {
      warnedNoEncryption = true;
      logger.info('db:encryption:unavailable', {
        path: resolvedPath,
        hint: 'Install SQLCipher for encryption at rest: brew install sqlcipher',
      });
    }
    return new Database(resolvedPath);
  }

  const name =
    explicitProfileName ??
    (pathWasExplicit ? deriveProfileName(resolvedPath) : getActiveProfile().name);
  const key = getOrInitEncryptionKey(name);

  // Encryption available but no key could be obtained (e.g. keychain write
  // failed): fall back to plaintext rather than lock the user out of their data.
  if (!key) {
    return new Database(resolvedPath);
  }

  // An existing plaintext database must be rewritten in the encrypted format
  // before it can be opened keyed — a keyed open of a plaintext file fails.
  if (isPlaintextSqliteFile(resolvedPath)) {
    migrateToEncrypted(resolvedPath, key);
  }

  try {
    return new Database(resolvedPath, { key });
  } catch (err) {
    // A wrong key and a missing/deleted keychain entry are indistinguishable
    // here — SQLCipher reports both as "file is not a database".
    throw new Error(
      `Could not open the encrypted database at ${resolvedPath}. The key from the OS ` +
        `keychain (service "openaccountant", account "db-encryption-${name}") did not ` +
        `decrypt it. A wrong key and a missing/deleted keychain entry look identical ` +
        `(SQLite reports "file is not a database"). If you removed or changed that ` +
        `keychain entry, restore it; a plaintext backup may exist at ` +
        `${resolvedPath}.unencrypted-backup. Cause: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
