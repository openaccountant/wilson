import { execFileSync } from 'child_process';
import { platform } from 'os';
import { logger } from './logger.js';

const SERVICE = 'openaccountant';

/**
 * Store a secret in the OS keychain.
 * Uses macOS Keychain (security CLI), with a logged warning on unsupported platforms.
 */
export function setSecret(account: string, secret: string): boolean {
  if (platform() !== 'darwin') {
    logger.info('keychain:unsupported', { platform: platform(), account });
    return false;
  }

  try {
    // Delete existing entry if it exists (ignore errors)
    try {
      execFileSync('security', [
        'delete-generic-password', '-s', SERVICE, '-a', account,
      ], { stdio: 'pipe' });
    } catch { /* entry may not exist */ }

    execFileSync('security', [
      'add-generic-password', '-s', SERVICE, '-a', account, '-w', secret, '-U',
    ], { stdio: 'pipe' });
    return true;
  } catch (err) {
    logger.info('keychain:set:error', { account, error: String(err) });
    return false;
  }
}

/**
 * Retrieve a secret from the OS keychain.
 */
export function getSecret(account: string): string | null {
  if (platform() !== 'darwin') return null;

  try {
    const result = execFileSync('security', [
      'find-generic-password', '-s', SERVICE, '-a', account, '-w',
    ], { stdio: 'pipe', encoding: 'utf-8' });
    return result.trim();
  } catch {
    return null;
  }
}

/**
 * Delete a secret from the OS keychain.
 */
export function deleteSecret(account: string): boolean {
  if (platform() !== 'darwin') return false;

  try {
    execFileSync('security', [
      'delete-generic-password', '-s', SERVICE, '-a', account,
    ], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}
