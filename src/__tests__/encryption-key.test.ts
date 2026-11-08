import { describe, expect, test, beforeEach, afterEach, mock } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Mock the keychain with an in-memory store so tests never touch the real
// macOS keychain (no residue) and can simulate an unavailable, locked or flaky keychain.
let store: Map<string, string>;
/** 'ok' | 'unavailable' (no secure store: create fails) | 'locked' (reads error) */
let mode: 'ok' | 'unavailable' | 'locked';
/** When true, reads report not-found even though an entry exists (a misreporting keychain). */
let readLies = false;

const mockGetSecret = mock((account: string) => (mode === 'ok' ? store.get(account) ?? null : null));
const mockReadSecret = mock((account: string) => {
  if (mode === 'locked') return { status: 'error', reason: 'security find-generic-password: exit 36' };
  if (readLies || !store.has(account)) return { status: 'not-found' };
  return { status: 'found', value: store.get(account)! };
});
const mockCreateSecret = mock((account: string, secret: string, _opts?: { requireSecure?: boolean }) => {
  if (mode !== 'ok') return { status: 'failed', reason: 'no secure store' };
  if (store.has(account)) return { status: 'exists' };
  store.set(account, secret);
  return { status: 'created' };
});
const mockSetSecret = mock(() => {
  throw new Error('encryption-key must never call setSecret (it can overwrite an existing key)');
});

mock.module('../utils/keychain.js', () => ({
  setSecret: mockSetSecret,
  getSecret: mockGetSecret,
  readSecret: mockReadSecret,
  createSecret: mockCreateSecret,
  deleteSecret: (account: string) => store.delete(account),
}));

// Import after the mock is set up.
const {
  hasEncryptionKey,
  getEncryptionKey,
  initEncryptionKey,
  getOrInitEncryptionKey,
  isEncryptedDbFile,
  EncryptionKeyError,
} = await import('../db/encryption-key.js');

const PROFILE = 'test-profile';
const ACCOUNT = `db-encryption-${PROFILE}`;
const PLAINTEXT_HEADER = Buffer.from('SQLite format 3\0', 'latin1');

describe('encryption-key', () => {
  let dir: string;
  beforeEach(() => {
    store = new Map();
    mode = 'ok';
    readLies = false;
    mockReadSecret.mockClear();
    mockCreateSecret.mockClear();
    mockSetSecret.mockClear();
    dir = mkdtempSync(join(tmpdir(), 'oa-enckey-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test('init then get round-trips the same key', () => {
    const key = initEncryptionKey(PROFILE);
    expect(key).not.toBeNull();
    expect(getEncryptionKey(PROFILE)).toBe(key);
  });

  test('hasEncryptionKey is false before init and true after', () => {
    expect(hasEncryptionKey(PROFILE)).toBe(false);
    initEncryptionKey(PROFILE);
    expect(hasEncryptionKey(PROFILE)).toBe(true);
  });

  test('generated key is 64 lowercase hex chars', () => {
    expect(initEncryptionKey(PROFILE)).toMatch(/^[0-9a-f]{64}$/);
  });

  test('init never replaces an existing key', () => {
    store.set(ACCOUNT, 'a'.repeat(64));
    expect(initEncryptionKey(PROFILE)).toBeNull();
    expect(store.get(ACCOUNT)).toBe('a'.repeat(64));
  });

  test('keys are created create-only, secure-only, under a profile-namespaced account', () => {
    getOrInitEncryptionKey(PROFILE);
    expect(mockCreateSecret).toHaveBeenCalledWith(ACCOUNT, expect.stringMatching(/^[0-9a-f]{64}$/), {
      requireSecure: true,
    });
    expect(mockSetSecret).not.toHaveBeenCalled();
  });

  test('getOrInit generates a key when none exists, then reuses it', () => {
    const key = getOrInitEncryptionKey(PROFILE);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(getOrInitEncryptionKey(PROFILE)).toBe(key);
    expect(mockCreateSecret).toHaveBeenCalledTimes(1);
  });

  test('getOrInit returns null (plaintext) when there is no secure store and nothing is encrypted', () => {
    mode = 'unavailable';
    expect(getOrInitEncryptionKey(PROFILE, join(dir, 'missing.db'))).toBeNull();
  });

  test('keys are isolated per profile', () => {
    const a = initEncryptionKey('profile-a');
    const b = initEncryptionKey('profile-b');
    expect(a).not.toBe(b);
    expect(getEncryptionKey('profile-a')).toBe(a);
    expect(getEncryptionKey('profile-b')).toBe(b);
  });

  describe('data-loss guards', () => {
    test('a keychain read error throws and never creates a key', () => {
      mode = 'locked';
      expect(() => getOrInitEncryptionKey(PROFILE)).toThrow(EncryptionKeyError);
      expect(() => getOrInitEncryptionKey(PROFILE)).toThrow(/will not create a new key/);
      expect(mockCreateSecret).not.toHaveBeenCalled();
      expect(mockSetSecret).not.toHaveBeenCalled();
    });

    test('not-found but the DB file is already encrypted: throws with recovery steps, no key minted', () => {
      const db = join(dir, 'data.db');
      writeFileSync(db, Buffer.alloc(4096, 0x5a)); // ciphertext: no plaintext SQLite header
      let err: Error | undefined;
      try { getOrInitEncryptionKey(PROFILE, db); } catch (e) { err = e as Error; }
      expect(err).toBeInstanceOf(EncryptionKeyError);
      expect(err!.message).toContain(db);
      expect(err!.message).toContain('unencrypted-backup');
      expect(err!.message).toContain(ACCOUNT);
      expect(mockCreateSecret).not.toHaveBeenCalled();
      expect(store.size).toBe(0);
    });

    test('not-found with a plaintext DB is safe: a key is created (for the migration)', () => {
      const db = join(dir, 'data.db');
      writeFileSync(db, Buffer.concat([PLAINTEXT_HEADER, Buffer.alloc(4080)]));
      expect(getOrInitEncryptionKey(PROFILE, db)).toMatch(/^[0-9a-f]{64}$/);
    });

    test('not-found with an empty DB file is safe: a key is created', () => {
      const db = join(dir, 'data.db');
      writeFileSync(db, '');
      expect(getOrInitEncryptionKey(PROFILE, db)).toMatch(/^[0-9a-f]{64}$/);
    });

    test('a read that wrongly says not-found cannot overwrite the real key', () => {
      store.set(ACCOUNT, 'r'.repeat(64)); // the user's real key
      readLies = true;
      expect(() => getOrInitEncryptionKey(PROFILE)).toThrow(/will not replace it/);
      expect(store.get(ACCOUNT)).toBe('r'.repeat(64));
      expect(mockSetSecret).not.toHaveBeenCalled();
    });
  });

  describe('isEncryptedDbFile', () => {
    test('missing, empty and plaintext files are not encrypted; anything else is', () => {
      const p = join(dir, 'x.db');
      expect(isEncryptedDbFile(p)).toBe(false);
      writeFileSync(p, '');
      expect(isEncryptedDbFile(p)).toBe(false);
      writeFileSync(p, Buffer.concat([PLAINTEXT_HEADER, Buffer.alloc(100)]));
      expect(isEncryptedDbFile(p)).toBe(false);
      writeFileSync(p, Buffer.alloc(4096, 0x01));
      expect(isEncryptedDbFile(p)).toBe(true);
      writeFileSync(p, 'short');
      expect(isEncryptedDbFile(p)).toBe(true); // unrecognisable: fail safe
    });
  });
});
