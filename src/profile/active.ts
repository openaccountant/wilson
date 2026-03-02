import { existsSync } from 'fs';
import {
  DEFAULT_PROFILE,
  ensureProfileDir,
  resolveProfile,
  type ProfilePaths,
} from './context.js';
import { hasLegacyData, migrateLegacyData } from './migrate.js';

let _active: ProfilePaths | null = null;

/**
 * Set the active profile for this process.
 * Creates the profile directory if it doesn't exist.
 * For the default profile, auto-migrates legacy CWD-relative data on first run.
 * Returns the resolved paths.
 */
export function setActiveProfile(name: string = DEFAULT_PROFILE): ProfilePaths {
  const paths = resolveProfile(name);
  ensureProfileDir(paths);

  // Auto-migrate legacy data for the default profile
  if (name === DEFAULT_PROFILE && !existsSync(paths.database) && hasLegacyData()) {
    const result = migrateLegacyData(paths);
    if (result.migrated) {
      console.log(`Migrated ${result.filesCopied.length} file(s) to profile "${name}" at ${paths.root}`);
      console.log('You can safely delete the old .openaccountant/ directory after verifying.');
    }
  }

  _active = paths;
  return paths;
}

/**
 * Get the active profile paths.
 * Throws if no profile has been set (call setActiveProfile first).
 */
export function getActiveProfile(): ProfilePaths {
  if (!_active) {
    throw new Error('No active profile. Call setActiveProfile() before accessing profile paths.');
  }
  return _active;
}

/**
 * Get the active profile name (convenience).
 */
export function getActiveProfileName(): string {
  return getActiveProfile().name;
}

/**
 * Reset the active profile (for testing).
 */
export function resetActiveProfile(): void {
  _active = null;
}

/**
 * Set active profile from pre-built paths (for testing).
 * Bypasses directory resolution and migration logic.
 */
export function setActiveProfilePaths(paths: ProfilePaths): void {
  _active = paths;
}
