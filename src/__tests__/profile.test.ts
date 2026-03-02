import { describe, expect, test, beforeEach, afterAll } from 'bun:test';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import * as os from 'os';
import {
  resolveProfile,
  ensureProfileDir,
  listProfiles,
  profileExists,
  setActiveProfile,
  getActiveProfile,
  getActiveProfileName,
  resetActiveProfile,
  setActiveProfilePaths,
  PROFILES_DIR,
} from '../profile/index.js';

describe('profile/context', () => {
  test('resolveProfile returns correct paths for default', () => {
    const paths = resolveProfile('default');
    expect(paths.name).toBe('default');
    expect(paths.root).toEndWith('/profiles/default');
    expect(paths.database).toEndWith('/profiles/default/data.db');
    expect(paths.settings).toEndWith('/profiles/default/settings.json');
    expect(paths.scratchpad).toEndWith('/profiles/default/scratchpad');
    expect(paths.cache).toEndWith('/profiles/default/cache');
  });

  test('resolveProfile returns correct paths for named profile', () => {
    const paths = resolveProfile('business');
    expect(paths.name).toBe('business');
    expect(paths.root).toEndWith('/profiles/business');
    expect(paths.database).toEndWith('/profiles/business/data.db');
  });

  test('ensureProfileDir creates directory tree', () => {
    const tmpDir = join(os.tmpdir(), `profile-ensure-${Date.now()}`);
    const paths = {
      name: 'test',
      root: join(tmpDir, 'test'),
      database: join(tmpDir, 'test', 'data.db'),
      settings: join(tmpDir, 'test', 'settings.json'),
      scratchpad: join(tmpDir, 'test', 'scratchpad'),
      cache: join(tmpDir, 'test', 'cache'),
    };

    ensureProfileDir(paths);

    expect(existsSync(paths.root)).toBe(true);
    expect(existsSync(paths.scratchpad)).toBe(true);
    expect(existsSync(paths.cache)).toBe(true);

    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('listProfiles returns sorted names from real profiles dir', () => {
    // This tests the real PROFILES_DIR — may return [] or existing profiles
    const profiles = listProfiles();
    expect(Array.isArray(profiles)).toBe(true);
    // If profiles exist, they should be sorted
    if (profiles.length > 1) {
      for (let i = 1; i < profiles.length; i++) {
        expect(profiles[i] >= profiles[i - 1]).toBe(true);
      }
    }
  });

  test('profileExists returns false for nonexistent profile', () => {
    expect(profileExists(`nonexistent-${Date.now()}`)).toBe(false);
  });
});

describe('profile/active', () => {
  beforeEach(() => {
    resetActiveProfile();
  });

  afterAll(() => {
    resetActiveProfile();
  });

  test('getActiveProfile throws when no profile set', () => {
    expect(() => getActiveProfile()).toThrow('No active profile');
  });

  test('setActiveProfilePaths / getActiveProfile roundtrip', () => {
    const tmpDir = join(os.tmpdir(), `active-test-${Date.now()}`);
    const paths = {
      name: 'roundtrip-test',
      root: tmpDir,
      database: join(tmpDir, 'data.db'),
      settings: join(tmpDir, 'settings.json'),
      scratchpad: join(tmpDir, 'scratchpad'),
      cache: join(tmpDir, 'cache'),
    };
    setActiveProfilePaths(paths);

    const active = getActiveProfile();
    expect(active.name).toBe('roundtrip-test');
    expect(active).toEqual(paths);
  });

  test('getActiveProfileName returns name', () => {
    setActiveProfilePaths({
      name: 'named-test',
      root: '/tmp/test',
      database: '/tmp/test/data.db',
      settings: '/tmp/test/settings.json',
      scratchpad: '/tmp/test/scratchpad',
      cache: '/tmp/test/cache',
    });
    expect(getActiveProfileName()).toBe('named-test');
  });

  test('resetActiveProfile clears state', () => {
    setActiveProfilePaths({
      name: 'to-reset',
      root: '/tmp/test',
      database: '/tmp/test/data.db',
      settings: '/tmp/test/settings.json',
      scratchpad: '/tmp/test/scratchpad',
      cache: '/tmp/test/cache',
    });
    resetActiveProfile();
    expect(() => getActiveProfile()).toThrow('No active profile');
  });

  test('setActiveProfile creates dirs and sets default', () => {
    // This test uses the real setActiveProfile which creates dirs under ~/.openaccountant/profiles/
    const paths = setActiveProfile();
    expect(paths.name).toBe('default');
    expect(existsSync(paths.root)).toBe(true);
  });
});
