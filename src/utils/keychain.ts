import { execFileSync } from 'child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { homedir, platform as osPlatform } from 'os';
import { join } from 'path';
import { logger } from './logger.js';

const SERVICE = 'openaccountant';

/**
 * OS secret storage, one backend per platform:
 *
 *   darwin  → macOS Keychain via the `security` CLI (no file fallback).
 *   win32   → DPAPI (CurrentUser scope) via Windows PowerShell. The ciphertext lives in
 *             ~/.openaccountant/secrets/<account>.dpapi; only this Windows user on this machine
 *             can decrypt it. Same protection class as Credential Manager (which is DPAPI too),
 *             with no native FFI and no npm dependency.
 *   linux   → libsecret via `secret-tool` (GNOME Keyring / KWallet) when it is installed and a
 *             Secret Service is reachable.
 *
 * When the platform store is unavailable (Linux without a keyring, Windows without PowerShell)
 * secrets fall back to a plaintext file with 0600 perms under ~/.openaccountant/secrets/, and a
 * one-time warning is printed. Degrade loudly, never silently.
 *
 * `OA_SECRET_BACKEND` forces a backend: auto (default) | keychain | dpapi | secret-tool | file | none.
 * `file` is the sane choice for headless Linux and containers; `none` disables secret storage.
 *
 * Reads are three-valued (`readSecret`): found, not-found, or error. A locked keychain, a denied
 * prompt or a timeout is an *error*, never "not found" — callers that would otherwise create a
 * fresh secret (the database key) must not mistake one for the other. `createSecret` never
 * overwrites: it reports `exists` instead.
 *
 * Secrets never appear in logs: exec failures are reported by exit status / error code only,
 * because a child-process error message embeds the full argv.
 */

export type SecretBackendName = 'keychain' | 'dpapi' | 'secret-tool' | 'file' | 'none';

export type SecretRead =
  | { status: 'found'; value: string }
  | { status: 'not-found' }
  | { status: 'error'; reason: string };

export type SecretCreate =
  | { status: 'created' }
  | { status: 'exists' }
  | { status: 'failed'; reason: string };

/** Minimal process runner, injectable so tests can fake `security` / `secret-tool` / PowerShell. */
export type ExecFn = (
  file: string,
  args: string[],
  opts: { input?: string; timeoutMs?: number },
) => string;

export interface SecretBackend {
  readonly name: SecretBackendName;
  /** Whether a secret written here is protected by the OS (not a plaintext file). */
  readonly secure: boolean;
  /** Create or replace. */
  set(account: string, secret: string): boolean;
  read(account: string): SecretRead;
  /** Create only if absent; never replaces an existing secret. */
  create(account: string, secret: string): SecretCreate;
  delete(account: string): boolean;
}

export interface SecretStoreOptions {
  platform?: NodeJS.Platform;
  /** Directory that holds wilson state (default ~/.openaccountant). */
  oaRoot?: string;
  exec?: ExecFn;
  env?: Record<string, string | undefined>;
  /** Called once per store, the first time a secret lands in the plaintext file fallback. */
  warn?: (message: string) => void;
  /** Per-call timeout for the default runner (default SECRET_EXEC_TIMEOUT_MS). */
  execTimeoutMs?: number;
}

export interface SetSecretOptions {
  /**
   * Refuse the plaintext-file fallback. For secrets whose whole point is to live apart from
   * the data they protect (the database encryption key).
   */
  requireSecure?: boolean;
}

export interface SecretStore {
  /** Backend that is tried first. */
  readonly primary: SecretBackend;
  set(account: string, secret: string, opts?: SetSecretOptions): boolean;
  read(account: string): SecretRead;
  create(account: string, secret: string, opts?: SetSecretOptions): SecretCreate;
  get(account: string): string | null;
  delete(account: string): boolean;
}

/** A keychain prompt nobody answers (or a hung D-Bus) must not hang wilson forever. */
export const SECRET_EXEC_TIMEOUT_MS = 30_000;

const defaultExec: ExecFn = (file, args, opts) =>
  execFileSync(file, args, {
    input: opts.input,
    encoding: 'utf-8',
    stdio: 'pipe',
    timeout: opts.timeoutMs ?? SECRET_EXEC_TIMEOUT_MS,
    windowsHide: true,
  });

interface ExecError {
  status?: number | null;
  signal?: string | null;
  code?: string;
  stderr?: string | Buffer;
}

/** Describe a child-process failure without its message (which contains the argv, i.e. secrets). */
export function describeExecError(err: unknown): string {
  const e = (err ?? {}) as ExecError;
  if (e.code === 'ETIMEDOUT') return 'timed out (a keychain prompt may be waiting)';
  if (e.code) return e.code;
  if (typeof e.status === 'number') return `exit ${e.status}`;
  if (e.signal) return `killed by ${e.signal}`;
  return err instanceof Error ? err.name : 'unknown error';
}

const exitStatus = (err: unknown): number | undefined => {
  const s = (err as ExecError | undefined)?.status;
  return typeof s === 'number' ? s : undefined;
};

/** Map an account name to a safe, reversible file name on every OS. */
export function accountFileStem(account: string): string {
  return account.replace(/[^A-Za-z0-9._-]/g, (c) =>
    [...Buffer.from(c, 'utf-8')].map((b) => `%${b.toString(16).padStart(2, '0').toUpperCase()}`).join(''),
  );
}

// ── macOS Keychain ──────────────────────────────────────────────────────────

/** errSecItemNotFound, as `security` reports it. */
const SECURITY_NOT_FOUND = 44;
/** errSecDuplicateItem. */
const SECURITY_DUPLICATE = 45;

export function macKeychainBackend(exec: ExecFn = defaultExec): SecretBackend {
  return {
    name: 'keychain',
    secure: true,
    set(account, secret) {
      try {
        // Delete existing entry if it exists (ignore errors)
        try {
          exec('security', ['delete-generic-password', '-s', SERVICE, '-a', account], {});
        } catch { /* entry may not exist */ }

        exec('security', [
          'add-generic-password', '-s', SERVICE, '-a', account, '-w', secret, '-U',
        ], {});
        return true;
      } catch (err) {
        logger.info('keychain:set:error', { account, error: describeExecError(err) });
        return false;
      }
    },
    read(account) {
      try {
        const result = exec('security', ['find-generic-password', '-s', SERVICE, '-a', account, '-w'], {});
        return { status: 'found', value: result.trim() };
      } catch (err) {
        if (exitStatus(err) === SECURITY_NOT_FOUND) return { status: 'not-found' };
        return { status: 'error', reason: `security find-generic-password: ${describeExecError(err)}` };
      }
    },
    create(account, secret) {
      // No delete, no -U: an existing item makes add fail with errSecDuplicateItem
      // instead of being replaced.
      try {
        exec('security', ['add-generic-password', '-s', SERVICE, '-a', account, '-w', secret], {});
        return { status: 'created' };
      } catch (err) {
        if (exitStatus(err) === SECURITY_DUPLICATE) return { status: 'exists' };
        return { status: 'failed', reason: `security add-generic-password: ${describeExecError(err)}` };
      }
    },
    delete(account) {
      try {
        exec('security', ['delete-generic-password', '-s', SERVICE, '-a', account], {});
        return true;
      } catch {
        return false;
      }
    },
  };
}

// ── Windows DPAPI ───────────────────────────────────────────────────────────

/**
 * PowerShell programs. The secret travels base64 over stdin/stdout, never argv (process
 * listings) and never through the console code page (which would mangle non-ASCII).
 * Entropy binds the blobs to wilson so another DPAPI consumer can't decrypt them by accident.
 */
const PS_PRELUDE =
  "$ErrorActionPreference='Stop';" +
  'Add-Type -AssemblyName System.Security;' +
  "$e=[Text.Encoding]::UTF8.GetBytes('openaccountant');" +
  '$b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim());';
const PS_PROTECT =
  PS_PRELUDE +
  '$o=[Security.Cryptography.ProtectedData]::Protect($b,$e,[Security.Cryptography.DataProtectionScope]::CurrentUser);' +
  '[Console]::Out.Write([Convert]::ToBase64String($o))';
const PS_UNPROTECT =
  PS_PRELUDE +
  '$o=[Security.Cryptography.ProtectedData]::Unprotect($b,$e,[Security.Cryptography.DataProtectionScope]::CurrentUser);' +
  '[Console]::Out.Write([Convert]::ToBase64String($o))';

function encodePs(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

function runPowerShell(exec: ExecFn, script: string, inputB64: string): string {
  return exec(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodePs(script)],
    { input: inputB64 },
  ).trim();
}

export function windowsDpapiBackend(secretsDir: string, exec: ExecFn = defaultExec): SecretBackend {
  const pathFor = (account: string) => join(secretsDir, `${accountFileStem(account)}.dpapi`);
  const protect = (secret: string): string => {
    const blob = runPowerShell(exec, PS_PROTECT, Buffer.from(secret, 'utf-8').toString('base64'));
    if (!blob) throw new Error('DPAPI returned no ciphertext');
    return blob;
  };
  return {
    name: 'dpapi',
    secure: true,
    set(account, secret) {
      try {
        const blob = protect(secret);
        ensurePrivateDir(secretsDir);
        writeFileSync(pathFor(account), blob, { mode: 0o600 });
        return true;
      } catch (err) {
        logger.info('keychain:dpapi:set:error', { account, error: describeExecError(err) });
        return false;
      }
    },
    read(account) {
      const p = pathFor(account);
      if (!existsSync(p)) return { status: 'not-found' };
      try {
        const out = runPowerShell(exec, PS_UNPROTECT, readFileSync(p, 'utf-8').trim());
        return { status: 'found', value: Buffer.from(out, 'base64').toString('utf-8') };
      } catch (err) {
        return { status: 'error', reason: `DPAPI unprotect of ${p}: ${describeExecError(err)}` };
      }
    },
    create(account, secret) {
      const p = pathFor(account);
      if (existsSync(p)) return { status: 'exists' };
      try {
        const blob = protect(secret);
        ensurePrivateDir(secretsDir);
        writeFileSync(p, blob, { mode: 0o600, flag: 'wx' });
        return { status: 'created' };
      } catch (err) {
        if ((err as ExecError).code === 'EEXIST') return { status: 'exists' };
        return { status: 'failed', reason: `DPAPI protect: ${describeExecError(err)}` };
      }
    },
    delete(account) {
      const p = pathFor(account);
      if (!existsSync(p)) return false;
      rmSync(p, { force: true });
      return true;
    },
  };
}

// ── Linux libsecret ─────────────────────────────────────────────────────────

export function secretToolBackend(exec: ExecFn = defaultExec): SecretBackend {
  const attrs = (account: string) => ['service', SERVICE, 'account', account];
  // secret-tool missing (ENOENT) never gets better within a process; stop spawning it.
  let missing = false;
  const run = (args: string[], input?: string): string => {
    if (missing) throw Object.assign(new Error('secret-tool not installed'), { code: 'ENOENT' });
    try {
      return exec('secret-tool', args, { input });
    } catch (err) {
      if ((err as ExecError)?.code === 'ENOENT') missing = true;
      throw err;
    }
  };
  const read = (account: string): SecretRead => {
    try {
      // lookup only appends a newline when stdout is a TTY, so a piped result is the exact
      // secret — don't trim (PEM keys end in \n).
      const out = run(['lookup', ...attrs(account)]);
      return out === '' ? { status: 'not-found' } : { status: 'found', value: out };
    } catch (err) {
      const e = err as ExecError;
      // Not installed: nothing can be stored there.
      if (e.code === 'ENOENT') return { status: 'not-found' };
      // lookup exits 1 silently when nothing matches; a D-Bus / locked-keyring failure
      // also exits non-zero but says why on stderr.
      const stderr = String(e.stderr ?? '').trim();
      if (exitStatus(err) === 1 && stderr === '') return { status: 'not-found' };
      return { status: 'error', reason: `secret-tool lookup: ${describeExecError(err)}` };
    }
  };
  const store = (account: string, secret: string) =>
    run(['store', '--label', `Open Accountant (${account})`, ...attrs(account)], secret);
  return {
    name: 'secret-tool',
    secure: true,
    set(account, secret) {
      try {
        store(account, secret);
        return true;
      } catch (err) {
        logger.info('keychain:secret-tool:set:error', { account, error: describeExecError(err) });
        return false;
      }
    },
    read,
    create(account, secret) {
      const existing = read(account);
      if (existing.status === 'found') return { status: 'exists' };
      if (existing.status === 'error') return { status: 'failed', reason: existing.reason };
      try {
        store(account, secret);
        return { status: 'created' };
      } catch (err) {
        return { status: 'failed', reason: `secret-tool store: ${describeExecError(err)}` };
      }
    },
    delete(account) {
      try {
        run(['clear', ...attrs(account)]);
        return true;
      } catch {
        return false;
      }
    },
  };
}

// ── Plaintext file fallback ─────────────────────────────────────────────────

function ensurePrivateDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
}

export function fileBackend(secretsDir: string): SecretBackend {
  const pathFor = (account: string) => join(secretsDir, `${accountFileStem(account)}.secret`);
  const write = (account: string, secret: string, flag: 'w' | 'wx') => {
    ensurePrivateDir(secretsDir);
    const p = pathFor(account);
    writeFileSync(p, secret, { mode: 0o600, flag });
    // writeFileSync's mode only applies on create; tighten a pre-existing file too.
    chmodSync(p, 0o600);
  };
  return {
    name: 'file',
    secure: false,
    set(account, secret) {
      try {
        write(account, secret, 'w');
        return true;
      } catch (err) {
        logger.info('keychain:file:set:error', { account, error: describeExecError(err) });
        return false;
      }
    },
    read(account) {
      const p = pathFor(account);
      if (!existsSync(p)) return { status: 'not-found' };
      try {
        return { status: 'found', value: readFileSync(p, 'utf-8') };
      } catch (err) {
        return { status: 'error', reason: `read ${p}: ${describeExecError(err)}` };
      }
    },
    create(account, secret) {
      try {
        write(account, secret, 'wx');
        return { status: 'created' };
      } catch (err) {
        if ((err as ExecError).code === 'EEXIST') return { status: 'exists' };
        return { status: 'failed', reason: `write: ${describeExecError(err)}` };
      }
    },
    delete(account) {
      const p = pathFor(account);
      if (!existsSync(p)) return false;
      rmSync(p, { force: true });
      return true;
    },
  };
}

const noneBackend: SecretBackend = {
  name: 'none',
  secure: false,
  set: () => false,
  read: () => ({ status: 'not-found' }),
  create: () => ({ status: 'failed', reason: 'secret storage disabled (OA_SECRET_BACKEND=none)' }),
  delete: () => false,
};

// ── Store ───────────────────────────────────────────────────────────────────

function primaryFor(
  platform: NodeJS.Platform,
  forced: string | undefined,
  secretsDir: string,
  exec: ExecFn,
): SecretBackend {
  switch (forced) {
    case 'keychain': return macKeychainBackend(exec);
    case 'dpapi': return windowsDpapiBackend(secretsDir, exec);
    case 'secret-tool': return secretToolBackend(exec);
    case 'file': return fileBackend(secretsDir);
    case 'none': return noneBackend;
  }
  if (platform === 'darwin') return macKeychainBackend(exec);
  if (platform === 'win32') return windowsDpapiBackend(secretsDir, exec);
  if (platform === 'linux' || platform === 'freebsd' || platform === 'openbsd') return secretToolBackend(exec);
  return fileBackend(secretsDir);
}

const defaultWarn = (message: string) => {
  process.stderr.write(`\n[wilson] WARNING: ${message}\n`);
};

export function createSecretStore(opts: SecretStoreOptions = {}): SecretStore {
  const platform = opts.platform ?? osPlatform();
  const env = opts.env ?? process.env;
  const exec: ExecFn =
    opts.exec ?? ((file, args, o) => defaultExec(file, args, { ...o, timeoutMs: o.timeoutMs ?? opts.execTimeoutMs }));
  const secretsDir = join(opts.oaRoot ?? join(homedir(), '.openaccountant'), 'secrets');
  const forced = env.OA_SECRET_BACKEND && env.OA_SECRET_BACKEND !== 'auto' ? env.OA_SECRET_BACKEND : undefined;
  const primary = primaryFor(platform, forced, secretsDir, exec);
  const warn = opts.warn ?? defaultWarn;

  // macOS: Keychain or nothing. Forced backends and the insecure backends themselves get no
  // second tier either.
  const fallback: SecretBackend | null =
    platform !== 'darwin' && !forced && primary.secure ? fileBackend(secretsDir) : null;

  let warned = false;
  const warnOnce = (backend: SecretBackend) => {
    if (warned) return;
    warned = true;
    const why =
      primary === backend
        ? `OA_SECRET_BACKEND=${backend.name}`
        : `the OS secret store (${primary.name}) is unavailable`;
    const msg =
      `Secrets are being stored in plaintext files under ${secretsDir} (permissions 0600) because ` +
      `${why}. Anyone with access to your user account can read them.` +
      (platform === 'linux' ? ' Install libsecret-tools (secret-tool) and a keyring to fix this.' : '');
    logger.warn('keychain:insecure-fallback', { dir: secretsDir, primary: primary.name });
    warn(msg);
  };

  const read = (account: string): SecretRead => {
    const r = primary.read(account);
    if (r.status === 'found' || !fallback) return r;
    const f = fallback.read(account);
    if (f.status === 'found') return f;
    // An error in the OS store wins over "not in the fallback file": it is not proof of absence.
    return r.status === 'error' ? r : f;
  };

  return {
    primary,
    set(account, secret, setOpts = {}) {
      if (primary.secure || !setOpts.requireSecure) {
        if (primary.set(account, secret)) {
          if (!primary.secure) warnOnce(primary);
          // A stale plaintext copy from an earlier fallback must not outlive the secure one.
          fallback?.delete(account);
          return true;
        }
      }
      if (!fallback || setOpts.requireSecure) {
        if (platform !== 'darwin') logger.info('keychain:unavailable', { platform, account, backend: primary.name });
        return false;
      }
      if (!fallback.set(account, secret)) return false;
      warnOnce(fallback);
      return true;
    },
    read,
    create(account, secret, setOpts = {}) {
      if (setOpts.requireSecure && !primary.secure) {
        return { status: 'failed', reason: `${primary.name} is not a secure store` };
      }
      const c = primary.create(account, secret);
      if (c.status !== 'failed' || !fallback || setOpts.requireSecure) return c;
      const f = fallback.create(account, secret);
      if (f.status === 'created') warnOnce(fallback);
      return f;
    },
    get(account) {
      const r = read(account);
      return r.status === 'found' ? r.value : null;
    },
    delete(account) {
      const a = primary.delete(account);
      const b = fallback?.delete(account) ?? false;
      return a || b;
    },
  };
}

let defaultStore: SecretStore | null = null;

function store(): SecretStore {
  if (!defaultStore) defaultStore = createSecretStore();
  return defaultStore;
}

/** Test hook: swap the process-wide store (null resets to a fresh default on next use). */
export function _setSecretStoreForTesting(s: SecretStore | null): void {
  defaultStore = s;
}

/** Name of the backend secrets are written to first on this machine. */
export function secretBackendName(): SecretBackendName {
  return store().primary.name;
}

/**
 * Store (create or replace) a secret in the OS secret store.
 * Returns false when it could not be stored anywhere acceptable.
 */
export function setSecret(account: string, secret: string, opts?: SetSecretOptions): boolean {
  return store().set(account, secret, opts);
}

/**
 * Retrieve a secret, or null when it is absent OR unreadable. Callers that would act on
 * absence (create a replacement) must use `readSecret` instead.
 */
export function getSecret(account: string): string | null {
  return store().get(account);
}

/** Three-valued read: found / not-found / error (locked keychain, denied prompt, timeout…). */
export function readSecret(account: string): SecretRead {
  return store().read(account);
}

/** Create a secret only if none exists. Never overwrites. */
export function createSecret(account: string, secret: string, opts?: SetSecretOptions): SecretCreate {
  return store().create(account, secret, opts);
}

/**
 * Delete a secret from the OS secret store.
 */
export function deleteSecret(account: string): boolean {
  return store().delete(account);
}
