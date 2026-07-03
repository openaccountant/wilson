/**
 * SQLCipher dylib resolution for transparent encryption-at-rest.
 *
 * `bun:sqlite` can be pointed at an alternate SQLite-ABI-compatible C library via
 * `Database.setCustomSQLite(path)`. Homebrew's `libsqlcipher.dylib` exports the
 * identical `sqlite3_*` ABI, so loading it swaps in SQLCipher with no npm deps —
 * `PRAGMA key` is then handled inside the dylib (see `compat-sqlite.ts`).
 *
 * CRITICAL invariants (validated in scripts/spike-setcustom-sqlcipher.ts):
 *   - `setCustomSQLite` MUST run BEFORE any Database is constructed.
 *   - Passing a path that does not exist SEGFAULTS Bun (oven-sh/bun#18811), so
 *     every candidate is guarded with `existsSync` before it is handed to Bun.
 *   - Only meaningful on darwin; returns null / false elsewhere.
 */
import { existsSync } from 'node:fs';
import { Database } from 'bun:sqlite';

/** arm64 Homebrew prefix. */
const BREW_ARM64_DYLIB = '/opt/homebrew/opt/sqlcipher/lib/libsqlcipher.dylib';
/** Intel Homebrew prefix. */
const BREW_INTEL_DYLIB = '/usr/local/opt/sqlcipher/lib/libsqlcipher.dylib';

/**
 * Resolve the path to a usable SQLCipher dylib, or null if none is available.
 *
 * darwin only. Resolution order:
 *   1. `WILSON_SQLCIPHER_DYLIB` env override
 *   2. arm64 Homebrew path
 *   3. Intel Homebrew path
 *
 * Every candidate must pass `existsSync` — a non-existent path passed to
 * `setCustomSQLite` segfaults Bun, so we never return one we cannot stat.
 */
export function resolveSqlcipherDylibPath(): string | null {
  if (process.platform !== 'darwin') return null;

  const candidates = [
    process.env.WILSON_SQLCIPHER_DYLIB,
    BREW_ARM64_DYLIB,
    BREW_INTEL_DYLIB,
  ];

  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return null;
}

let initialized = false;
let active = false;

/**
 * Idempotently point `bun:sqlite` at SQLCipher if a dylib is available.
 *
 * MUST be called before any Database instance is constructed. Never throws:
 * if resolution or `setCustomSQLite` fails, SQLCipher is simply left inactive
 * and the caller falls back to plaintext SQLite.
 *
 * @returns whether SQLCipher is active after this call.
 */
export function initSqlcipher(): boolean {
  if (initialized) return active;
  initialized = true;

  const dylibPath = resolveSqlcipherDylibPath();
  if (!dylibPath) return false;

  try {
    Database.setCustomSQLite(dylibPath);
    active = true;
  } catch {
    // Leave SQLCipher inactive; caller falls back to plaintext SQLite.
    active = false;
  }
  return active;
}

/**
 * Whether SQLCipher encryption is currently available.
 *
 * Runs `initSqlcipher()` (idempotent) so a caller can query availability
 * without separately arranging initialization.
 */
export function encryptionAvailable(): boolean {
  return initSqlcipher();
}
