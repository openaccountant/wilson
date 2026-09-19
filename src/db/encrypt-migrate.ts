/**
 * In-place migration of an existing plaintext SQLite database to an encrypted
 * SQLCipher database, preserving the original as a backup.
 *
 * Wilson databases created before encryption shipped are plaintext on disk. When
 * encryption becomes available (macOS + SQLCipher dylib + a keychain key), the
 * existing file must be rewritten in the encrypted format before it can be opened
 * with `PRAGMA key`. SQLCipher's `sqlcipher_export()` does this: attach an empty
 * keyed target, copy the whole logical database into it, then swap files.
 *
 * Requires the SQLCipher dylib to have been activated via `initSqlcipher()`
 * before any Database in this process was constructed — `ATTACH ... KEY` and
 * `sqlcipher_export` are SQLCipher extensions and are no-ops on plain bun:sqlite.
 *
 * Safety contract: on ANY failure the original file is left untouched and the
 * temporary encrypted copy is cleaned up. The swap only happens after a
 * successful export.
 */
import { Database } from 'bun:sqlite';
import {
  closeSync,
  existsSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
} from 'node:fs';

/** The 16-byte magic string every unencrypted SQLite file starts with. */
const SQLITE_PLAINTEXT_HEADER = Buffer.from('SQLite format 3\0', 'latin1');

/** Suffix for the preserved plaintext copy left behind after migration. */
const BACKUP_SUFFIX = '.unencrypted-backup';

/**
 * Whether the file at `path` is an unencrypted SQLite database, detected by its
 * 16-byte header. Returns false for missing, too-short, or encrypted files (a
 * SQLCipher file has an encrypted header that never equals the magic string).
 */
export function isPlaintextSqliteFile(path: string): boolean {
  if (!existsSync(path)) return false;

  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(16);
    const bytesRead = readSync(fd, buf, 0, 16, 0);
    if (bytesRead < 16) return false;
    return buf.equals(SQLITE_PLAINTEXT_HEADER);
  } finally {
    closeSync(fd);
  }
}

/** Escape a filesystem path for safe interpolation inside a single-quoted SQL literal. */
function sqlQuote(path: string): string {
  return path.replace(/'/g, "''");
}

/** Best-effort removal of a file, ignoring any error. */
function tryRemove(path: string): void {
  try {
    if (existsSync(path)) rmSync(path, { force: true });
  } catch {
    /* best-effort cleanup */
  }
}

/**
 * Rewrite the plaintext database at `path` as an encrypted SQLCipher database
 * keyed with `key` (64 hex chars), preserving the original at
 * `<path>.unencrypted-backup`.
 *
 * On success the encrypted database lives at the original `path` and a
 * plaintext backup sits alongside it. On any failure the original file is left
 * exactly as it was and no partial output remains; the error is rethrown.
 */
export function migrateToEncrypted(path: string, key: string): void {
  const tmpPath = `${path}.encrypting-${process.pid}-${Date.now()}`;
  const backupPath = `${path}${BACKUP_SUFFIX}`;

  // A stale tmp/backup from a previous interrupted run would corrupt this one.
  tryRemove(tmpPath);

  // Phase 1: export the plaintext DB into a fresh encrypted file. The original
  // is only ever read here, never mutated.
  try {
    const plain = new Database(path);
    try {
      plain.exec(`ATTACH DATABASE '${sqlQuote(tmpPath)}' AS encrypted KEY "x'${key}'"`);
      plain.query("SELECT sqlcipher_export('encrypted')").get();
      plain.exec('DETACH DATABASE encrypted');
    } finally {
      plain.close();
    }
  } catch (err) {
    tryRemove(tmpPath);
    throw new Error(
      `Failed to encrypt database at ${path}; the original file was left unchanged. ` +
        `Cause: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Phase 2: swap files. original -> backup, then tmp -> original. If the second
  // rename fails, restore the original from the backup so we never end up with
  // no database at `path`.
  if (existsSync(backupPath)) tryRemove(backupPath);
  try {
    renameSync(path, backupPath);
  } catch (err) {
    tryRemove(tmpPath);
    throw new Error(
      `Failed to back up plaintext database at ${path}; the original file was left unchanged. ` +
        `Cause: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  try {
    renameSync(tmpPath, path);
  } catch (err) {
    // Roll back: put the original back where it belongs.
    try {
      renameSync(backupPath, path);
    } catch {
      /* the plaintext data is still safe at backupPath */
    }
    tryRemove(tmpPath);
    throw new Error(
      `Failed to install encrypted database at ${path}. ` +
        `Your data is safe at ${existsSync(path) ? path : backupPath}. ` +
        `Cause: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // The new encrypted DB is a fresh file; drop any WAL/SHM sidecars left by the
  // old plaintext DB so the encrypted connection starts them clean.
  tryRemove(`${path}-wal`);
  tryRemove(`${path}-shm`);

  console.log(
    `Encrypted the database at ${path}. A plaintext backup was kept at ` +
      `${backupPath} — delete it once you have confirmed the encrypted database works.`,
  );
}
