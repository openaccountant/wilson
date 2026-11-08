import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  encryptionAvailable,
  encryptionUnavailableHint,
  initSqlcipher,
  resolveSqlcipherDylibPath,
} from '../db/sqlcipher-dylib.js';

describe('sqlcipher-dylib', () => {
  // Latch initialization FIRST, with a clean (unmodified) env, so setCustomSQLite
  // only ever sees the real resolved dylib — never a bogus override path (which
  // would segfault Bun). initSqlcipher is idempotent, so this fixes the outcome
  // for every later call regardless of env manipulation below.
  test('initSqlcipher is idempotent and agrees with encryptionAvailable', () => {
    const first = initSqlcipher();
    const second = initSqlcipher();
    expect(typeof first).toBe('boolean');
    expect(second).toBe(first);
    expect(encryptionAvailable()).toBe(first);
  });

  test('encryptionAvailable implies a dylib resolved', () => {
    // Sound directions only: activation requires BOTH a resolvable dylib AND
    // initSqlcipher running before any Database is constructed (setCustomSQLite
    // throws "SQLite already loaded" otherwise). So:
    //   - active  ⟹ a dylib resolved
    //   - no dylib ⟹ not active
    // The converse (resolvable ⟹ active) does NOT hold: in a process where a
    // Database already exists (e.g. the full test suite), init fails gracefully
    // and availability is false even though the dylib path resolves.
    if (encryptionAvailable()) {
      expect(resolveSqlcipherDylibPath()).not.toBeNull();
    }
    if (resolveSqlcipherDylibPath() === null) {
      expect(encryptionAvailable()).toBe(false);
    }
  });

  test('resolveSqlcipherDylibPath returns null or an existing file', () => {
    const resolved = resolveSqlcipherDylibPath();
    expect(resolved === null || existsSync(resolved)).toBe(true);
  });

  describe('WILSON_SQLCIPHER_DYLIB override (resolution only)', () => {
    const original = process.env.WILSON_SQLCIPHER_DYLIB;
    let workDir: string;

    afterEach(() => {
      if (original === undefined) delete process.env.WILSON_SQLCIPHER_DYLIB;
      else process.env.WILSON_SQLCIPHER_DYLIB = original;
      if (workDir) rmSync(workDir, { recursive: true, force: true });
    });

    test('env override takes precedence when the path exists (darwin)', () => {
      if (process.platform !== 'darwin') return;
      workDir = mkdtempSync(join(tmpdir(), 'dylib-override-'));
      const fake = join(workDir, 'libsqlcipher.dylib');
      writeFileSync(fake, ''); // existsSync only — never handed to setCustomSQLite
      process.env.WILSON_SQLCIPHER_DYLIB = fake;
      expect(resolveSqlcipherDylibPath()).toBe(fake);
    });

    test('non-existent env override is skipped, falling through to brew paths', () => {
      workDir = mkdtempSync(join(tmpdir(), 'dylib-override-'));
      const missing = join(workDir, 'does-not-exist.dylib');
      process.env.WILSON_SQLCIPHER_DYLIB = missing;
      const resolved = resolveSqlcipherDylibPath();
      expect(resolved).not.toBe(missing);
      // Whatever resolves (a brew path or null) must never be the missing path.
      if (resolved !== null) expect(existsSync(resolved)).toBe(true);
    });
  });

  test('non-darwin platforms never report encryption without an explicit library', () => {
    // Bun links SQLite statically off macOS, so a distro libsqlcipher is not enough.
    if (process.platform === 'darwin' || process.env.OA_SQLCIPHER_LIB) return;
    expect(encryptionAvailable()).toBe(false);
  });

  describe('per-platform resolution (injected, no filesystem)', () => {
    const only = (path: string) => (p: string) => p === path;

    test('OA_SQLCIPHER_LIB wins on every platform', () => {
      for (const platform of ['darwin', 'linux', 'win32'] as const) {
        expect(
          resolveSqlcipherDylibPath({ platform, env: { OA_SQLCIPHER_LIB: '/x/lib.so' }, exists: only('/x/lib.so') }),
        ).toBe('/x/lib.so');
      }
    });

    test('OA_SQLCIPHER_LIB beats the legacy WILSON_SQLCIPHER_DYLIB', () => {
      expect(
        resolveSqlcipherDylibPath({
          platform: 'darwin',
          env: { OA_SQLCIPHER_LIB: '/new', WILSON_SQLCIPHER_DYLIB: '/old' },
          exists: () => true,
        }),
      ).toBe('/new');
    });

    test('linux finds distro packages', () => {
      const deb = '/usr/lib/x86_64-linux-gnu/libsqlcipher.so.0';
      expect(resolveSqlcipherDylibPath({ platform: 'linux', env: {}, exists: only(deb) })).toBe(deb);
      expect(resolveSqlcipherDylibPath({ platform: 'linux', env: {}, exists: () => false })).toBeNull();
    });

    test('windows looks in ~/.openaccountant/lib, LOCALAPPDATA and Program Files', () => {
      const home = join('C:', 'Users', 'pat');
      const inHome = join(home, '.openaccountant', 'lib', 'sqlcipher.dll');
      expect(resolveSqlcipherDylibPath({ platform: 'win32', env: {}, home, exists: only(inHome) })).toBe(inHome);

      const local = join('C:', 'Users', 'pat', 'AppData', 'Local');
      const inLocal = join(local, 'openaccountant', 'sqlcipher.dll');
      expect(
        resolveSqlcipherDylibPath({ platform: 'win32', env: { LOCALAPPDATA: local }, home, exists: only(inLocal) }),
      ).toBe(inLocal);

      // Homebrew paths are never considered off macOS.
      expect(resolveSqlcipherDylibPath({ platform: 'win32', env: {}, home, exists: (p) => p.includes('homebrew') })).toBeNull();
    });
  });

  test('hint is platform-appropriate', () => {
    expect(encryptionUnavailableHint('darwin')).toContain('brew install sqlcipher');
    expect(encryptionUnavailableHint('win32')).toContain('BitLocker');
    expect(encryptionUnavailableHint('win32')).not.toContain('brew');
    expect(encryptionUnavailableHint('linux')).toContain('unencrypted');
  });
});
