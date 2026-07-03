import { randomBytes } from 'crypto';
import { getSecret, setSecret } from '../utils/keychain.js';

/**
 * Keychain account name for a profile's database encryption key.
 * Namespaced so it never collides with other secrets under the service.
 */
function keyAccount(profileName: string): string {
  return `db-encryption-${profileName}`;
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
 * Generate a new random 256-bit encryption key for the given profile and
 * store it in the OS keychain as 64 lowercase hex characters.
 * Returns the key, or null if the keychain store fails (e.g. on non-darwin platforms).
 */
export function initEncryptionKey(profileName: string): string | null {
  const key = randomBytes(32).toString('hex');
  if (!setSecret(keyAccount(profileName), key)) {
    return null;
  }
  return key;
}

/**
 * Get the encryption key for the given profile, generating and storing one if
 * it does not yet exist. Returns null when encryption is unavailable — macOS-first
 * per design decision D2, with no passphrase fallback in v1.
 */
export function getOrInitEncryptionKey(profileName: string): string | null {
  return getEncryptionKey(profileName) ?? initEncryptionKey(profileName);
}
