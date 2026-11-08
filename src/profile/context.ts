import { join, resolve } from 'path';
import { homedir } from 'os';
import { existsSync, mkdirSync, readdirSync } from 'fs';

/**
 * The value of a path override from the environment, or null when it is unset. A host that substitutes
 * settings into env vars (Claude Desktop's .mcpb `${user_config.*}`) can hand over an empty string or the
 * unexpanded placeholder when the user left a setting blank; both mean "use the default".
 */
export function envPathOverride(value: string | undefined): string | null {
  const v = value?.trim();
  if (!v || v.startsWith('${')) return null;
  return resolve(v);
}

/** Wilson's data folder: `WILSON_HOME` when set (e.g. the Claude Desktop extension's "data folder"), else ~/.openaccountant. */
export const OA_ROOT = envPathOverride(process.env.WILSON_HOME) ?? join(homedir(), '.openaccountant');
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
