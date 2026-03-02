import { join } from 'path';
import { homedir } from 'os';
import { existsSync, mkdirSync, readdirSync } from 'fs';

export const OA_ROOT = join(homedir(), '.openaccountant');
export const PROFILES_DIR = join(OA_ROOT, 'profiles');
export const DEFAULT_PROFILE = 'default';

export interface ProfilePaths {
  name: string;
  root: string;       // ~/.openaccountant/profiles/{name}/
  database: string;    // .../data.db
  settings: string;    // .../settings.json
  scratchpad: string;  // .../scratchpad/
  cache: string;       // .../cache/
}

/**
 * Resolve all paths for a named profile.
 */
export function resolveProfile(name: string): ProfilePaths {
  const root = join(PROFILES_DIR, name);
  return {
    name,
    root,
    database: join(root, 'data.db'),
    settings: join(root, 'settings.json'),
    scratchpad: join(root, 'scratchpad'),
    cache: join(root, 'cache'),
  };
}

/**
 * Ensure the profile directory tree exists.
 */
export function ensureProfileDir(paths: ProfilePaths): void {
  mkdirSync(paths.root, { recursive: true });
  mkdirSync(paths.scratchpad, { recursive: true });
  mkdirSync(paths.cache, { recursive: true });
}

/**
 * List all existing profile names, sorted alphabetically.
 */
export function listProfiles(): string[] {
  if (!existsSync(PROFILES_DIR)) {
    return [];
  }
  return readdirSync(PROFILES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

/**
 * Check whether a profile directory exists.
 */
export function profileExists(name: string): boolean {
  return existsSync(join(PROFILES_DIR, name));
}
