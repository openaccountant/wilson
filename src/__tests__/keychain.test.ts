import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  accountFileStem,
  createSecretStore,
  type ExecFn,
} from '../utils/keychain.js';

interface Call { file: string; args: string[]; input?: string }

/** Fake process runner: records every call and answers through `handler`. */
function fakeExec(handler: (c: Call) => string): { exec: ExecFn; calls: Call[] } {
  const calls: Call[] = [];
  const exec: ExecFn = (file, args, opts) => {
    const c = { file, args, input: opts.input };
    calls.push(c);
    return handler(c);
  };
  return { exec, calls };
}

function enoent(): never {
  const err = new Error('spawn ENOENT') as NodeJS.ErrnoException;
  err.code = 'ENOENT';
  throw err;
}

function exitCode(n: number): never {
  throw Object.assign(new Error(`exit ${n}`), { status: n });
}

let oaRoot: string;
let warnings: string[];

beforeEach(() => {
  oaRoot = mkdtempSync(join(tmpdir(), 'oa-keychain-'));
  warnings = [];
});

afterEach(() => {
  rmSync(oaRoot, { recursive: true, force: true });
});

const baseOpts = () => ({ oaRoot, env: {}, warn: (m: string) => warnings.push(m) });
const secretsDir = () => join(oaRoot, 'secrets');

describe('macOS keychain backend', () => {
  test('issues the same security(1) calls as 0.9', () => {
    const kc = new Map<string, string>();
    const { exec, calls } = fakeExec(({ args }) => {
      const account = args[args.indexOf('-a') + 1]!;
      if (args[0] === 'delete-generic-password') {
        if (!kc.delete(account)) exitCode(44);
        return '';
      }
      if (args[0] === 'add-generic-password') {
        kc.set(account, args[args.indexOf('-w') + 1]!);
        return '';
      }
      const v = kc.get(account);
      if (v === undefined) exitCode(44);
      return `${v}\n`;
    });
    const store = createSecretStore({ ...baseOpts(), platform: 'darwin', exec });

    expect(store.set('plaid-abc', 's3cret')).toBe(true);
    expect(store.get('plaid-abc')).toBe('s3cret');
    expect(store.delete('plaid-abc')).toBe(true);
    expect(store.get('plaid-abc')).toBeNull();

    expect(calls.map((c) => [c.file, ...c.args])).toEqual([
      ['security', 'delete-generic-password', '-s', 'openaccountant', '-a', 'plaid-abc'],
      ['security', 'add-generic-password', '-s', 'openaccountant', '-a', 'plaid-abc', '-w', 's3cret', '-U'],
      ['security', 'find-generic-password', '-s', 'openaccountant', '-a', 'plaid-abc', '-w'],
      ['security', 'delete-generic-password', '-s', 'openaccountant', '-a', 'plaid-abc'],
      ['security', 'find-generic-password', '-s', 'openaccountant', '-a', 'plaid-abc', '-w'],
    ]);
  });

  test('a keychain failure returns false and never falls back to a file', () => {
    const { exec } = fakeExec(() => exitCode(1));
    const store = createSecretStore({ ...baseOpts(), platform: 'darwin', exec });
    expect(store.set('plaid-abc', 's3cret')).toBe(false);
    expect(store.get('plaid-abc')).toBeNull();
    expect(existsSync(secretsDir())).toBe(false);
    expect(warnings).toEqual([]);
  });
});

describe('Linux secret-tool backend', () => {
  test('stores via stdin and looks up by service/account attributes', () => {
    const ring = new Map<string, string>();
    const { exec, calls } = fakeExec(({ args, input }) => {
      const account = args[args.length - 1]!;
      if (args[0] === 'store') { ring.set(account, input!); return ''; }
      if (args[0] === 'lookup') {
        const v = ring.get(account);
        if (v === undefined) exitCode(1);
        return v;
      }
      ring.delete(account);
      return '';
    });
    const store = createSecretStore({ ...baseOpts(), platform: 'linux', exec });

    expect(store.primary.name).toBe('secret-tool');
    expect(store.set('coinbase-key', '-----BEGIN EC PRIVATE KEY-----\nabc\n')).toBe(true);
    expect(store.get('coinbase-key')).toBe('-----BEGIN EC PRIVATE KEY-----\nabc\n');

    const storeCall = calls.find((c) => c.args[0] === 'store')!;
    expect(storeCall.file).toBe('secret-tool');
    expect(storeCall.args).toEqual([
      'store', '--label', 'Open Accountant (coinbase-key)', 'service', 'openaccountant', 'account', 'coinbase-key',
    ]);
    // The secret is never on the command line.
    expect(storeCall.args.join(' ')).not.toContain('PRIVATE KEY');

    expect(store.delete('coinbase-key')).toBe(true);
    expect(store.get('coinbase-key')).toBeNull();
    expect(warnings).toEqual([]);
    expect(existsSync(secretsDir())).toBe(false);
  });

  test('without secret-tool, falls back to a 0600 file and warns exactly once', () => {
    const { exec, calls } = fakeExec(() => enoent());
    const store = createSecretStore({ ...baseOpts(), platform: 'linux', exec });

    expect(store.set('plaid-1', 'tok-1')).toBe(true);
    expect(store.set('plaid-2', 'tok-2')).toBe(true);
    expect(store.get('plaid-1')).toBe('tok-1');
    expect(store.get('plaid-2')).toBe('tok-2');

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('plaintext');
    expect(warnings[0]).toContain('secret-tool');

    // ENOENT is remembered: secret-tool is spawned once, not on every call.
    expect(calls).toHaveLength(1);

    const file = join(secretsDir(), 'plaid-1.secret');
    expect(readFileSync(file, 'utf-8')).toBe('tok-1');
    if (process.platform !== 'win32') {
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(statSync(secretsDir()).mode & 0o777).toBe(0o700);
    }

    expect(store.delete('plaid-1')).toBe(true);
    expect(store.get('plaid-1')).toBeNull();
  });

  test('keyring unreachable (secret-tool exits non-zero) also falls back', () => {
    const { exec } = fakeExec(() => exitCode(1));
    const store = createSecretStore({ ...baseOpts(), platform: 'linux', exec });
    expect(store.set('plaid-1', 'tok-1')).toBe(true);
    expect(store.get('plaid-1')).toBe('tok-1');
    expect(warnings).toHaveLength(1);
  });

  test('a later secure write removes the stale plaintext copy', () => {
    let keyringUp = false;
    const ring = new Map<string, string>();
    const { exec } = fakeExec(({ args, input }) => {
      if (!keyringUp) exitCode(1);
      const account = args[args.length - 1]!;
      if (args[0] === 'store') { ring.set(account, input!); return ''; }
      if (args[0] === 'lookup') return ring.get(account) ?? exitCode(1);
      ring.delete(account);
      return '';
    });
    const store = createSecretStore({ ...baseOpts(), platform: 'linux', exec });
    expect(store.set('plaid-1', 'old')).toBe(true);
    expect(existsSync(join(secretsDir(), 'plaid-1.secret'))).toBe(true);

    keyringUp = true;
    expect(store.set('plaid-1', 'new')).toBe(true);
    expect(existsSync(join(secretsDir(), 'plaid-1.secret'))).toBe(false);
    expect(store.get('plaid-1')).toBe('new');
  });

  test('requireSecure refuses the plaintext fallback', () => {
    const { exec } = fakeExec(() => enoent());
    const store = createSecretStore({ ...baseOpts(), platform: 'linux', exec });
    expect(store.set('db-encryption-default', 'ab'.repeat(32), { requireSecure: true })).toBe(false);
    expect(existsSync(secretsDir())).toBe(false);
    expect(warnings).toEqual([]);
  });
});

describe('Windows DPAPI backend', () => {
  // Stand-in for PowerShell's ProtectedData: "encrypts" by reversing the bytes, so the
  // test can check the plumbing (base64 over stdin, ciphertext file) without Windows.
  const fakeDpapi = () =>
    fakeExec(({ file, args, input }) => {
      expect(file).toBe('powershell.exe');
      const script = Buffer.from(args[args.indexOf('-EncodedCommand') + 1]!, 'base64').toString('utf16le');
      const bytes = Buffer.from(input!.trim(), 'base64');
      expect(script).toContain('ProtectedData');
      expect(script).toContain('CurrentUser');
      return Buffer.from(bytes.reverse()).toString('base64');
    });

  test('round-trips through PowerShell with the secret only on stdin', () => {
    const { exec, calls } = fakeDpapi();
    const store = createSecretStore({ ...baseOpts(), platform: 'win32', exec });
    expect(store.primary.name).toBe('dpapi');

    const secret = 'access-sandbox-ünïcödé-&|"%';
    expect(store.set('plaid-item', secret)).toBe(true);
    expect(store.get('plaid-item')).toBe(secret);

    for (const c of calls) {
      expect(c.args.slice(0, 6)).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand']);
      expect(c.args.join(' ')).not.toContain('sandbox');
    }

    // Only ciphertext on disk, never the plaintext.
    const files = readdirSync(secretsDir());
    expect(files).toEqual(['plaid-item.dpapi']);
    expect(readFileSync(join(secretsDir(), files[0]!), 'utf-8')).not.toContain('sandbox');
    expect(warnings).toEqual([]);

    expect(store.delete('plaid-item')).toBe(true);
    expect(store.get('plaid-item')).toBeNull();
  });

  test('missing PowerShell falls back to the plaintext file, loudly', () => {
    const { exec } = fakeExec(() => enoent());
    const store = createSecretStore({ ...baseOpts(), platform: 'win32', exec });
    expect(store.set('plaid-item', 'tok')).toBe(true);
    expect(store.get('plaid-item')).toBe('tok');
    expect(warnings).toHaveLength(1);
  });
});

describe('OA_SECRET_BACKEND', () => {
  test('file forces the plaintext store and warns', () => {
    const { exec, calls } = fakeExec(() => exitCode(1));
    const store = createSecretStore({ ...baseOpts(), env: { OA_SECRET_BACKEND: 'file' }, platform: 'darwin', exec });
    expect(store.primary.name).toBe('file');
    expect(store.set('a', 'b')).toBe(true);
    expect(store.get('a')).toBe('b');
    expect(calls).toHaveLength(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('OA_SECRET_BACKEND=file');
    // Forced file is still refused for secrets that must not be plaintext.
    expect(store.set('db-encryption-x', 'k', { requireSecure: true })).toBe(false);
  });

  test('none stores nothing anywhere', () => {
    const { exec, calls } = fakeExec(() => '');
    const store = createSecretStore({ ...baseOpts(), env: { OA_SECRET_BACKEND: 'none' }, platform: 'linux', exec });
    expect(store.set('a', 'b')).toBe(false);
    expect(store.get('a')).toBeNull();
    expect(calls).toHaveLength(0);
    expect(existsSync(secretsDir())).toBe(false);
  });

  test('auto picks the platform default', () => {
    const { exec } = fakeExec(() => '');
    expect(createSecretStore({ ...baseOpts(), env: { OA_SECRET_BACKEND: 'auto' }, platform: 'win32', exec }).primary.name).toBe('dpapi');
  });
});

describe('accountFileStem', () => {
  test('keeps safe names readable and escapes everything else', () => {
    expect(accountFileStem('db-encryption-default')).toBe('db-encryption-default');
    expect(accountFileStem('coinbase-organizations/abc/apiKeys/def')).toBe('coinbase-organizations%2Fabc%2FapiKeys%2Fdef');
    expect(accountFileStem('a:b\\c')).toBe('a%3Ab%5Cc');
  });
});

// The real thing, on the Windows CI runner: Windows PowerShell + DPAPI, no fakes.
describe.skipIf(process.platform !== 'win32')('Windows DPAPI (real PowerShell)', () => {
  test('set / get / delete round-trip', () => {
    const store = createSecretStore({ ...baseOpts(), platform: 'win32' });
    const secret = `wilson-ci-${Date.now()}-ünïcödé`;
    expect(store.set('ci-roundtrip', secret)).toBe(true);
    expect(warnings).toEqual([]);
    const blob = readFileSync(join(secretsDir(), 'ci-roundtrip.dpapi'), 'utf-8');
    expect(blob).not.toContain('wilson-ci');
    expect(store.get('ci-roundtrip')).toBe(secret);
    expect(store.delete('ci-roundtrip')).toBe(true);
    expect(store.get('ci-roundtrip')).toBeNull();
  }, 60_000);
});
