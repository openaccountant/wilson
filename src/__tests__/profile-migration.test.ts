import { describe, expect, test, beforeEach, afterAll } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import * as os from 'os';
import { hasLegacyData, migrateLegacyData, resolveProfile, type ProfilePaths } from '../profile/index.js';

describe('profile/migrate', () => {
  const tmpDir = join(os.tmpdir(), `migrate-test-${Date.now()}`);
  let origCwd: string;

  beforeEach(() => {
    origCwd = process.cwd();
    rmSync(tmpDir, { recursive: true, force: true });
    mkdirSync(tmpDir, { recursive: true });
    process.chdir(tmpDir);
  });

  afterAll(() => {
    process.chdir(origCwd);
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  function makeProfilePaths(name: string): ProfilePaths {
    const root = join(tmpDir, 'target-profiles', name);
    return {
      name,
      root,
      database: join(root, 'data.db'),
      settings: join(root, 'settings.json'),
      scratchpad: join(root, 'scratchpad'),
      cache: join(root, 'cache'),
    };
  }

  test('hasLegacyData returns false when no legacy dir', () => {
    expect(hasLegacyData()).toBe(false);
  });

  test('hasLegacyData returns true when legacy data.db exists', () => {
    mkdirSync(join(tmpDir, '.openaccountant'), { recursive: true });
    writeFileSync(join(tmpDir, '.openaccountant', 'data.db'), 'fake-db');
    expect(hasLegacyData()).toBe(true);
  });

  test('migrateLegacyData copies files to profile dir', () => {
    // Set up legacy data
    const legacyDir = join(tmpDir, '.openaccountant');
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, 'data.db'), 'test-db-content');
    writeFileSync(join(legacyDir, 'settings.json'), '{"provider":"openai"}');
    mkdirSync(join(legacyDir, 'scratchpad'), { recursive: true });
    writeFileSync(join(legacyDir, 'scratchpad', 'note.jsonl'), 'test-note');

    // Set up target profile
    const paths = makeProfilePaths('default');
    mkdirSync(paths.root, { recursive: true });
    mkdirSync(paths.scratchpad, { recursive: true });
    mkdirSync(paths.cache, { recursive: true });

    const result = migrateLegacyData(paths);

    expect(result.migrated).toBe(true);
    expect(result.filesCopied).toContain('data.db');
    expect(result.filesCopied).toContain('settings.json');
    expect(result.filesCopied).toContain('scratchpad/note.jsonl');

    // Verify content was copied
    expect(readFileSync(paths.database, 'utf-8')).toBe('test-db-content');
    expect(readFileSync(paths.settings, 'utf-8')).toBe('{"provider":"openai"}');

    // Verify source still exists (not moved)
    expect(existsSync(join(legacyDir, 'data.db'))).toBe(true);
  });

  test('migrateLegacyData skips files that already exist in target', () => {
    // Set up legacy data
    const legacyDir = join(tmpDir, '.openaccountant');
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, 'data.db'), 'old-content');
    writeFileSync(join(legacyDir, 'settings.json'), '{}');

    // Set up target with existing data.db
    const paths = makeProfilePaths('default');
    mkdirSync(paths.root, { recursive: true });
    mkdirSync(paths.scratchpad, { recursive: true });
    mkdirSync(paths.cache, { recursive: true });
    writeFileSync(paths.database, 'existing-content');

    const result = migrateLegacyData(paths);

    // data.db should not be overwritten
    expect(readFileSync(paths.database, 'utf-8')).toBe('existing-content');
    expect(result.filesCopied).not.toContain('data.db');
    // settings.json should still be copied
    expect(result.filesCopied).toContain('settings.json');
  });

  test('migrateLegacyData returns not migrated when nothing to copy', () => {
    // Legacy dir exists but is empty (no data.db)
    const legacyDir = join(tmpDir, '.openaccountant');
    mkdirSync(legacyDir, { recursive: true });

    const paths = makeProfilePaths('default');
    mkdirSync(paths.root, { recursive: true });
    mkdirSync(paths.scratchpad, { recursive: true });
    mkdirSync(paths.cache, { recursive: true });

    const result = migrateLegacyData(paths);
    expect(result.migrated).toBe(false);
    expect(result.filesCopied).toEqual([]);
  });
});
