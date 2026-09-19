import { describe, expect, test, beforeEach, mock } from 'bun:test';

// Mock the keychain with an in-memory store so tests never touch the real
// macOS keychain (no residue) and can simulate an unavailable keychain.
let store: Map<string, string>;
let keychainAvailable = true;

const mockSetSecret = mock((account: string, secret: string) => {
  if (!keychainAvailable) return false;
  store.set(account, secret);
  return true;
});
const mockGetSecret = mock((account: string) => {
  if (!keychainAvailable) return null;
  return store.get(account) ?? null;
});
const mockDeleteSecret = mock((account: string) => store.delete(account));

mock.module('../utils/keychain.js', () => ({
  setSecret: mockSetSecret,
  getSecret: mockGetSecret,
  deleteSecret: mockDeleteSecret,
}));

// Import after the mock is set up.
const {
  hasEncryptionKey,
  getEncryptionKey,
  initEncryptionKey,
  getOrInitEncryptionKey,
} = await import('../db/encryption-key.js');

const PROFILE = 'test-profile';

describe('encryption-key', () => {
  beforeEach(() => {
    store = new Map();
    keychainAvailable = true;
    mockSetSecret.mockClear();
    mockGetSecret.mockClear();
    mockDeleteSecret.mockClear();
  });

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

  test('get without init returns null', () => {
    expect(getEncryptionKey(PROFILE)).toBeNull();
  });

  test('generated key is 64 lowercase hex chars', () => {
    const key = initEncryptionKey(PROFILE);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  test('init returns null when the keychain is unavailable', () => {
    keychainAvailable = false;
    expect(initEncryptionKey(PROFILE)).toBeNull();
    expect(hasEncryptionKey(PROFILE)).toBe(false);
  });

  test('key is stored under a profile-namespaced account', () => {
    initEncryptionKey(PROFILE);
    expect(mockSetSecret).toHaveBeenCalledWith(
      `db-encryption-${PROFILE}`,
      expect.stringMatching(/^[0-9a-f]{64}$/),
    );
  });

  test('getOrInit generates a key when none exists, then reuses it', () => {
    expect(hasEncryptionKey(PROFILE)).toBe(false);
    const key = getOrInitEncryptionKey(PROFILE);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    // Second call returns the existing key without generating a new one.
    expect(getOrInitEncryptionKey(PROFILE)).toBe(key);
    expect(mockSetSecret).toHaveBeenCalledTimes(1);
  });

  test('getOrInit returns null when encryption is unavailable', () => {
    keychainAvailable = false;
    expect(getOrInitEncryptionKey(PROFILE)).toBeNull();
  });

  test('keys are isolated per profile', () => {
    const a = initEncryptionKey('profile-a');
    const b = initEncryptionKey('profile-b');
    expect(a).not.toBe(b);
    expect(getEncryptionKey('profile-a')).toBe(a);
    expect(getEncryptionKey('profile-b')).toBe(b);
  });
});
