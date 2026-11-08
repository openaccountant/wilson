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
 *   - Only effective on darwin: on Linux/Windows Bun links SQLite statically and
 *     `setCustomSQLite` is a silent no-op, so activation is verified by probe.
 */
import { closeSync, existsSync, openSync, readSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';

/** arm64 Homebrew prefix. */
const BREW_ARM64_DYLIB = '/opt/homebrew/opt/sqlcipher/lib/libsqlcipher.dylib';
/** Intel Homebrew prefix. */
const BREW_INTEL_DYLIB = '/usr/local/opt/sqlcipher/lib/libsqlcipher.dylib';

/** Distro packages (Debian/Ubuntu multiarch, Fedora/RHEL lib64, Arch, source installs). */
const LINUX_CANDIDATES = [
  '/usr/lib/x86_64-linux-gnu/libsqlcipher.so.1',
  '/usr/lib/x86_64-linux-gnu/libsqlcipher.so.0',
  '/usr/lib/aarch64-linux-gnu/libsqlcipher.so.1',
  '/usr/lib/aarch64-linux-gnu/libsqlcipher.so.0',
  '/usr/lib64/libsqlcipher.so.0',
  '/usr/lib/libsqlcipher.so.0',
  '/usr/local/lib/libsqlcipher.so',
];

/** Where a Windows user would plausibly drop a SQLCipher build. */
function windowsCandidates(env: Record<string, string | undefined>, home: string): string[] {
  const out = [join(home, '.openaccountant', 'lib', 'sqlcipher.dll')];
  if (env.LOCALAPPDATA) out.push(join(env.LOCALAPPDATA, 'openaccountant', 'sqlcipher.dll'));
  if (env.ProgramFiles) out.push(join(env.ProgramFiles, 'SQLCipher', 'sqlcipher.dll'));
  return out;
}

export interface ResolveOptions {
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  home?: string;
  exists?: (path: string) => boolean;
  /** Process architecture to match (default process.arch). */
  arch?: string;
  /** Architectures a Mach-O file contains (default: read its header). */
  machOArchs?: (path: string) => string[];
}

const MACHO_CPU: Record<number, string> = { 0x01000007: 'x64', 0x0100000c: 'arm64' };

/**
 * Architectures in a Mach-O dylib, from its header: thin 64-bit (MH_MAGIC_64) or fat
 * (FAT_MAGIC / FAT_MAGIC_64). [] when unreadable or not Mach-O.
 */
export function readMachOArchs(path: string): string[] {
  let fd: number | null = null;
  try {
    fd = openSync(path, 'r');
    const head = Buffer.alloc(8);
    if (readSync(fd, head, 0, 8, 0) < 8) return [];
    if (head.readUInt32LE(0) === 0xfeedfacf) {
      const cpu = MACHO_CPU[head.readUInt32LE(4)];
      return cpu ? [cpu] : [];
    }
    const magic = head.readUInt32BE(0);
    if (magic !== 0xcafebabe && magic !== 0xcafebabf) return [];
    const n = Math.min(head.readUInt32BE(4), 16);
    const entry = magic === 0xcafebabf ? 32 : 20;
    const table = Buffer.alloc(n * entry);
    readSync(fd, table, 0, table.length, 8);
    const out: string[] = [];
    for (let i = 0; i < n; i++) {
      const cpu = MACHO_CPU[table.readUInt32BE(i * entry)];
      if (cpu) out.push(cpu);
    }
    return out;
  } catch {
    return [];
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/**
 * Resolve the path to a SQLCipher shared library, or null if none is available.
 *
 * Resolution order:
 *   1. `OA_SQLCIPHER_LIB` env override (any platform)
 *   2. `WILSON_SQLCIPHER_DYLIB` (legacy name, any platform)
 *   3. platform locations: Homebrew arm64/Intel on darwin, distro paths on Linux,
 *      ~/.openaccountant/lib, %LOCALAPPDATA%, %ProgramFiles% on Windows
 *
 * Every candidate must pass `existsSync` — a non-existent path passed to
 * `setCustomSQLite` segfaults Bun, so we never return one we cannot stat.
 *
 * A resolved path is necessary, not sufficient: only Bun on macOS loads SQLite
 * dynamically. On Linux and Windows Bun links SQLite statically and
 * `setCustomSQLite` returns true without swapping anything, so `initSqlcipher`
 * probes for `cipher_version` before declaring encryption active.
 */
export function resolveSqlcipherDylibPath(opts: ResolveOptions = {}): string | null {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const exists = opts.exists ?? existsSync;

  const candidates: (string | undefined)[] = [env.OA_SQLCIPHER_LIB, env.WILSON_SQLCIPHER_DYLIB];
  if (platform === 'darwin') candidates.push(BREW_ARM64_DYLIB, BREW_INTEL_DYLIB);
  else if (platform === 'linux') candidates.push(...LINUX_CANDIDATES);
  else if (platform === 'win32') candidates.push(...windowsCandidates(env, opts.home ?? homedir()));

  // On macOS the library is dlopen'ed at the first `new Database`, after setCustomSQLite has
  // already succeeded — a wrong-architecture dylib (arm64 Homebrew under a Rosetta x64 binary)
  // throws there, uncatchably late. So only accept a dylib built for this process.
  const arch = opts.arch ?? process.arch;
  const archsOf = opts.machOArchs ?? readMachOArchs;
  const loadable = (p: string) => platform !== 'darwin' || archsOf(p).includes(arch);

  for (const candidate of candidates) {
    if (candidate && exists(candidate) && loadable(candidate)) return candidate;
  }
  return null;
}

/**
 * Platform-appropriate advice for when encryption at rest is unavailable.
 * Bun only honours a custom SQLite on macOS, so elsewhere there is no library
 * to install yet — point people at full-disk encryption instead.
 */
export function encryptionUnavailableHint(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'darwin') return 'Install SQLCipher for encryption at rest: brew install sqlcipher';
  if (platform === 'win32') {
    return 'Database encryption at rest is not yet supported on Windows; your data is stored unencrypted. ' +
      'Turn on BitLocker or Device Encryption to protect it.';
  }
  return 'Database encryption at rest is not yet supported on this platform; your data is stored unencrypted. ' +
    'Use full-disk encryption (e.g. LUKS) to protect it.';
}

/**
 * Whether the SQLite that `bun:sqlite` is now using is really SQLCipher.
 * `PRAGMA cipher_version` returns a row only from SQLCipher; plain SQLite
 * ignores the unknown pragma and returns nothing.
 */
function sqlcipherIsLoaded(): boolean {
  let db: Database | null = null;
  try {
    db = new Database(':memory:');
    const rows = db.prepare('PRAGMA cipher_version').all();
    return rows.length > 0;
  } catch {
    return false;
  } finally {
    db?.close();
  }
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

  // Off macOS, Bun's statically linked SQLite ignores setCustomSQLite (verified on
  // Linux with Bun 1.4.2). Only try when someone explicitly points us at a library;
  // the probe below keeps that honest.
  if (process.platform !== 'darwin' && !process.env.OA_SQLCIPHER_LIB) return false;

  try {
    Database.setCustomSQLite(dylibPath);
    // Never report encryption on a plain SQLite: keyed opens would silently
    // write plaintext (PRAGMA key is a no-op there).
    active = sqlcipherIsLoaded();
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
