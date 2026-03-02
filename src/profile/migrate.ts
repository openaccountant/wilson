import { existsSync, copyFileSync, mkdirSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import type { ProfilePaths } from './context.js';

export interface MigrationResult {
  migrated: boolean;
  filesCopied: string[];
}

/**
 * Check whether legacy CWD-relative .openaccountant/data.db exists.
 */
export function hasLegacyData(): boolean {
  return existsSync(join('.openaccountant', 'data.db'));
}

/**
 * Copy legacy .openaccountant/ data into a profile directory.
 * Copies data.db, settings.json, scratchpad/, and cache/.
 * Does NOT delete the source — user verifies and removes manually.
 * Skips files that already exist in the target.
 */
export function migrateLegacyData(profile: ProfilePaths): MigrationResult {
  const legacyDir = '.openaccountant';
  const filesCopied: string[] = [];

  // Copy data.db
  const legacyDb = join(legacyDir, 'data.db');
  if (existsSync(legacyDb) && !existsSync(profile.database)) {
    copyFileSync(legacyDb, profile.database);
    filesCopied.push('data.db');
  }

  // Copy settings.json
  const legacySettings = join(legacyDir, 'settings.json');
  if (existsSync(legacySettings) && !existsSync(profile.settings)) {
    copyFileSync(legacySettings, profile.settings);
    filesCopied.push('settings.json');
  }

  // Copy scratchpad directory contents
  const legacyScratchpad = join(legacyDir, 'scratchpad');
  if (existsSync(legacyScratchpad)) {
    copyDirContents(legacyScratchpad, profile.scratchpad, filesCopied, 'scratchpad/');
  }

  // Copy cache directory contents
  const legacyCache = join(legacyDir, 'cache');
  if (existsSync(legacyCache)) {
    copyDirContents(legacyCache, profile.cache, filesCopied, 'cache/');
  }

  return {
    migrated: filesCopied.length > 0,
    filesCopied,
  };
}

/**
 * Recursively copy directory contents, skipping files that already exist.
 */
function copyDirContents(
  src: string,
  dest: string,
  filesCopied: string[],
  prefix: string,
): void {
  if (!existsSync(dest)) {
    mkdirSync(dest, { recursive: true });
  }

  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDirContents(srcPath, destPath, filesCopied, `${prefix}${entry.name}/`);
    } else if (!existsSync(destPath)) {
      copyFileSync(srcPath, destPath);
      filesCopied.push(`${prefix}${entry.name}`);
    }
  }
}
