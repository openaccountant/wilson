import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  encryptionAvailable,
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
    if (process.platform !== 'darwin') {
      expect(resolved).toBeNull();
    } else {
      expect(resolved === null || existsSync(resolved)).toBe(true);
    }
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

  test('non-darwin platforms never resolve a dylib', () => {
    if (process.platform === 'darwin') return; // covered by the darwin cases above
    expect(resolveSqlcipherDylibPath()).toBeNull();
    expect(encryptionAvailable()).toBe(false);
  });
});
