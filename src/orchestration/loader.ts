import { readdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import yaml from 'js-yaml';
import type { ChainDef, TeamDef } from './types.js';

/**
 * Directories to search for chain/team YAML definitions (in priority order).
 */
function getSearchDirs(kind: 'chains' | 'teams'): string[] {
  return [
    // Built-in
    join(import.meta.dir ?? '.', kind),
    // User-level
    join(homedir(), '.openspend', kind),
    // Project-level
    join(process.cwd(), '.openspend', kind),
  ];
}

/**
 * Load all YAML files from a directory, returning parsed objects keyed by filename (no extension).
 */
function loadYamlDir<T>(dir: string): Map<string, T> {
  const results = new Map<string, T>();
  if (!existsSync(dir)) return results;

  try {
    const files = readdirSync(dir).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'));
    for (const file of files) {
      try {
        const content = readFileSync(join(dir, file), 'utf-8');
        const parsed = yaml.load(content) as T;
        const name = file.replace(/\.ya?ml$/, '');
        results.set(name, parsed);
      } catch {
        // Skip malformed YAML files
      }
    }
  } catch {
    // Directory not readable
  }

  return results;
}

/**
 * Discover all chain definitions from built-in, user, and project directories.
 * Later directories override earlier ones (project > user > built-in).
 */
export function discoverChains(): ChainDef[] {
  const chains = new Map<string, ChainDef>();

  for (const dir of getSearchDirs('chains')) {
    for (const [name, chain] of loadYamlDir<ChainDef>(dir)) {
      chains.set(name, chain);
    }
  }

  return Array.from(chains.values());
}

/**
 * Discover all team definitions from built-in, user, and project directories.
 */
export function discoverTeams(): TeamDef[] {
  const teams = new Map<string, TeamDef>();

  for (const dir of getSearchDirs('teams')) {
    for (const [name, team] of loadYamlDir<TeamDef>(dir)) {
      teams.set(name, team);
    }
  }

  return Array.from(teams.values());
}
