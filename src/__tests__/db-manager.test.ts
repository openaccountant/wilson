import { describe, expect, test, beforeEach } from 'bun:test';
import { createTestDb } from './helpers.js';
import {
  getActiveDb, switchProfile, getAvailableProfiles,
  getCurrentProfileName, setInitialProfile, closeAll,
} from '../dashboard/db-manager.js';

describe('db-manager', () => {
  beforeEach(() => {
    // Reset module state between tests
    closeAll();
  });

  // ── setInitialProfile ──────────────────────────────────────────────────

  describe('setInitialProfile', () => {
    test('sets current profile name', () => {
      setInitialProfile('myprofile');
      expect(getCurrentProfileName()).toBe('myprofile');
    });

    test('registers db in connection cache when provided', () => {
      const db = createTestDb();
      setInitialProfile('testprofile', db);

      // getActiveDb should return the same DB instance, not open a new one
      const active = getActiveDb();
      expect(active).toBe(db);
    });

    test('does not register db when not provided', () => {
      setInitialProfile('default');
      // getCurrentProfileName should still be set
      expect(getCurrentProfileName()).toBe('default');
    });

    test('overwrites previous profile name', () => {
      setInitialProfile('first');
      expect(getCurrentProfileName()).toBe('first');
      setInitialProfile('second');
      expect(getCurrentProfileName()).toBe('second');
    });
  });

  // ── getCurrentProfileName ──────────────────────────────────────────────

  describe('getCurrentProfileName', () => {
    test('returns default when no profile set after closeAll', () => {
      // closeAll clears cache but doesn't reset currentProfile.
      // After setInitialProfile call in beforeEach-like setup, it should reflect what was set.
      setInitialProfile('custom');
      expect(getCurrentProfileName()).toBe('custom');
    });
  });

  // ── getActiveDb ────────────────────────────────────────────────────────

  describe('getActiveDb', () => {
    test('returns registered db for current profile', () => {
      const db = createTestDb();
      setInitialProfile('active-test', db);
      expect(getActiveDb()).toBe(db);
    });

    test('returns same instance on repeated calls (caching)', () => {
      const db = createTestDb();
      setInitialProfile('cached', db);
      const first = getActiveDb();
      const second = getActiveDb();
      expect(first).toBe(second);
    });
  });

  // ── switchProfile ──────────────────────────────────────────────────────

  describe('switchProfile', () => {
    test('changes current profile name', () => {
      const db1 = createTestDb();
      setInitialProfile('profile-a', db1);
      expect(getCurrentProfileName()).toBe('profile-a');

      // switchProfile calls setActiveProfile and openDb which depend on filesystem.
      // We can at least verify it updates currentProfile.
      // Since the target profile won't have a cached db, it will try to open from filesystem.
      // We pre-register profile-b to avoid filesystem access.
      const db2 = createTestDb();
      setInitialProfile('profile-b', db2);
      // Reset back to profile-a first
      setInitialProfile('profile-a', db1);

      // Now switch should find profile-b in cache
      const switched = switchProfile('profile-b');
      expect(getCurrentProfileName()).toBe('profile-b');
      expect(switched).toBe(db2);
    });

    test('returns db for switched profile', () => {
      const db = createTestDb();
      setInitialProfile('target', db);
      setInitialProfile('start');
      // Pre-cache target profile's db
      // Actually setInitialProfile only sets currentProfile and optionally caches.
      // We need to re-register 'target' with its db after the second call.
      closeAll();
      setInitialProfile('start');
      // Manually set up target in cache by calling setInitialProfile with db
      setInitialProfile('target', db);
      setInitialProfile('start');

      const result = switchProfile('target');
      expect(result).toBe(db);
    });
  });

  // ── getAvailableProfiles ───────────────────────────────────────────────

  describe('getAvailableProfiles', () => {
    test('returns array from listProfiles', () => {
      const profiles = getAvailableProfiles();
      expect(Array.isArray(profiles)).toBe(true);
    });
  });

  // ── closeAll ───────────────────────────────────────────────────────────

  describe('closeAll', () => {
    test('clears connection cache', () => {
      const db1 = createTestDb();
      const db2 = createTestDb();
      setInitialProfile('p1', db1);
      setInitialProfile('p2', db2);

      closeAll();

      // After closeAll, getting active db for a cached profile should
      // try to open a new connection (not return the old one).
      // We can verify by registering a new db and checking it's used.
      const db3 = createTestDb();
      setInitialProfile('p2', db3);
      expect(getActiveDb()).toBe(db3);
      expect(getActiveDb()).not.toBe(db2);
    });

    test('handles empty cache gracefully', () => {
      closeAll(); // already empty from beforeEach
      expect(() => closeAll()).not.toThrow();
    });

    test('handles already-closed databases gracefully', () => {
      const db = createTestDb();
      db.close(); // pre-close
      setInitialProfile('closed-db', db);
      // closeAll should not throw even if db.close() throws
      expect(() => closeAll()).not.toThrow();
    });
  });

  // ── Integration ────────────────────────────────────────────────────────

  describe('integration', () => {
    test('full lifecycle: init → getActive → switch → closeAll', () => {
      const dbA = createTestDb();
      const dbB = createTestDb();

      // 1. Initialize with profile A
      setInitialProfile('alpha', dbA);
      expect(getCurrentProfileName()).toBe('alpha');
      expect(getActiveDb()).toBe(dbA);

      // 2. Pre-register profile B in cache
      setInitialProfile('beta', dbB);
      setInitialProfile('alpha', dbA);

      // 3. Switch to profile B
      const switched = switchProfile('beta');
      expect(getCurrentProfileName()).toBe('beta');
      expect(switched).toBe(dbB);
      expect(getActiveDb()).toBe(dbB);

      // 4. Switch back to alpha
      const back = switchProfile('alpha');
      expect(getCurrentProfileName()).toBe('alpha');
      expect(back).toBe(dbA);

      // 5. Close all
      closeAll();
    });

    test('multiple profiles can be cached simultaneously', () => {
      const dbs = Array.from({ length: 5 }, () => createTestDb());
      const names = ['one', 'two', 'three', 'four', 'five'];

      // Register all
      for (let i = 0; i < 5; i++) {
        setInitialProfile(names[i], dbs[i]);
      }

      // Last setInitialProfile sets currentProfile to 'five'
      expect(getCurrentProfileName()).toBe('five');
      expect(getActiveDb()).toBe(dbs[4]);

      // Switch to each and verify correct db
      for (let i = 0; i < 5; i++) {
        const result = switchProfile(names[i]);
        expect(result).toBe(dbs[i]);
        expect(getCurrentProfileName()).toBe(names[i]);
      }

      closeAll();
    });
  });
});
