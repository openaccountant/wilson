import { randomBytes } from 'crypto';
import { closeSync, existsSync, openSync, readSync, statSync } from 'fs';
import { createSecret, getSecret, readSecret } from '../utils/keychain.js';

/**
 * Keychain account name for a profile's database encryption key.
 * Namespaced so it never collides with other secrets under the service.
 */
export function keyAccount(profileName: string): string {
  return `db-encryption-${profileName}`;
}

/**
 * The encryption key could not be obtained safely. Thrown instead of minting a new key in any
 * situation where a new key could orphan an existing encrypted database.
 */
export class EncryptionKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EncryptionKeyError';
  }
}

const SQLITE_HEADER = Buffer.from('SQLite format 3\0', 'latin1');

/**
 * Whether `dbPath` holds data that is not a plaintext SQLite database — i.e. an encrypted one.
 * Missing or empty files are not. Anything else without the plaintext header is treated as
 * encrypted (fail safe: a false positive only stops key creation, a false negative loses data).
 */
export function isEncryptedDbFile(dbPath: string): boolean {
  if (!existsSync(dbPath)) return false;
  if (statSync(dbPath).size === 0) return false;
  const fd = openSync(dbPath, 'r');
  try {
    const buf = Buffer.alloc(16);
    const n = readSync(fd, buf, 0, 16, 0);
    return n < 16 || !buf.equals(SQLITE_HEADER);
  } finally {
    closeSync(fd);
  }
}

/**
 * Whether an encryption key already exists for the given profile.
 */
export function hasEncryptionKey(profileName: string): boolean {
  return getSecret(keyAccount(profileName)) !== null;
}

/**
 * Retrieve the encryption key for the given profile.
 * Returns the 64-hex-char key, or null if none is stored (or the keychain is unavailable).
 */
export function getEncryptionKey(profileName: string): string | null {
  return getSecret(keyAccount(profileName));
}

/**
 * Generate a new random 256-bit encryption key for the given profile and store it in the OS
 * keychain as 64 lowercase hex characters. Never replaces an existing key.
 * Returns the key, or null if it could not be stored (or one already exists).
 */
export function initEncryptionKey(profileName: string): string | null {
  const key = randomBytes(32).toString('hex');
  // Never in the plaintext-file fallback: a key stored next to the database it encrypts
  // protects nothing.
  return createSecret(keyAccount(profileName), key, { requireSecure: true }).status === 'created' ? key : null;
}

/**
 * Get the encryption key for the given profile, generating and storing one only when it is
 * provably safe to do so.
 *
 * - key found                         → return it
 * - keychain read failed (locked, denied, timed out, anything but "not found") → THROW
 * - not found, but `dbPath` is already an encrypted file → THROW (a new key can't open it)
 * - not found, no encrypted data      → create a key (create-only, never overwrite)
 *     · created                       → return it
 *     · an entry appeared meanwhile   → THROW (it exists but we couldn't read it)
 *     · no secure store available     → null: the caller runs unencrypted, as before
 */
export function getOrInitEncryptionKey(profileName: string, dbPath?: string): string | null {
  const account = keyAccount(profileName);
  const where = `the OS keychain (service "openaccountant", account "${account}")`;

  const read = readSecret(account);
  if (read.status === 'found') return read.value;

  if (read.status === 'error') {
    throw new EncryptionKeyError(
      `Could not read the database encryption key from ${where}: ${read.reason}. ` +
        `Wilson will not create a new key while the keychain can't be read, because a new key ` +
        `would make an existing encrypted database unreadable. Unlock your keychain (or approve ` +
        `the access prompt) and run wilson again.`,
    );
  }

  if (dbPath && isEncryptedDbFile(dbPath)) {
    throw new EncryptionKeyError(
      `The database at ${dbPath} is encrypted, but ${where} has no key for it. Wilson will not ` +
        `create a new key: it could never decrypt this file. Restore the keychain entry (Keychain ` +
        `Access, or a Time Machine backup of ~/Library/Keychains), or move this file aside and use ` +
        `the plaintext backup at ${dbPath}.unencrypted-backup if one exists.`,
    );
  }

  const key = randomBytes(32).toString('hex');
  const created = createSecret(account, key, { requireSecure: true });
  if (created.status === 'created') return key;
  if (created.status === 'exists') {
    throw new EncryptionKeyError(
      `A database encryption key already exists in ${where} but could not be read a moment ago. ` +
        `Wilson will not replace it. Check keychain access for wilson and run it again.`,
    );
  }
  // No secure store at all (non-macOS without a keyring, OA_SECRET_BACKEND=none, keychain
  // write refused): run unencrypted rather than lock the user out.
  return null;
}
