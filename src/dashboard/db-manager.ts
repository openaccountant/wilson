import type { Database } from '../db/compat-sqlite.js';
import { initDatabase } from '../db/database.js';
import {
  listProfiles,
  profileExists,
  resolveProfile,
  setActiveProfile,
} from '../profile/index.js';
import { initChatSession } from './chat.js';

const connections = new Map<string, Database>();
let currentProfile: string = 'default';

/**
 * Open (or reuse) a DB connection for the given profile.
 */
function openDb(profileName: string): Database {
  const existing = connections.get(profileName);
  if (existing) return existing;

  const paths = resolveProfile(profileName);
  const db = initDatabase(paths.database);
  connections.set(profileName, db);
  return db;
}

/**
 * Every profile DB currently open, with its profile name (the active one included).
 * Housekeeping that must reach all profiles, not only the one in use, iterates this.
 */
export function getOpenDbs(): Array<{ profile: string; db: Database }> {
  return [...connections].map(([profile, db]) => ({ profile, db }));
}

/**
 * A profile's DB connection WITHOUT making it the active profile, or null when
 * that profile does not exist. The LAN-mode switch gate uses it to check a
 * target's dashboard auth before switching to it.
 */
export function peekProfileDb(name: string): Database | null {
  const existing = connections.get(name);
  if (existing) return existing;
  if (!profileExists(name)) return null;
  return openDb(name);
}

/**
 * Get the active profile's DB connection.
 */
export function getActiveDb(): Database {
  return openDb(currentProfile);
}

/**
 * Switch to a different profile. Returns the new DB connection.
 * Also re-initializes the chat session for the new profile.
 */
export function switchProfile(name: string): Database {
  currentProfile = name;
  // Ensure profile dir exists
  setActiveProfile(name);
  const db = openDb(name);
  // Re-init chat for the new DB
  initChatSession(db);
  return db;
}

/**
 * Get all available profile names.
 */
export function getAvailableProfiles(): string[] {
  return listProfiles();
}

/**
 * Get the current profile name.
 */
export function getCurrentProfileName(): string {
  return currentProfile;
}

/**
 * Set initial profile (called during startup).
 * If a db is provided, register it in the connection cache.
 */
export function setInitialProfile(name: string, db?: Database): void {
  currentProfile = name;
  if (db) connections.set(name, db);
}

/**
 * Close all open DB connections. Call on shutdown.
 */
export function closeAll(): void {
  for (const [, db] of connections) {
    try { db.close(); } catch { /* ignore */ }
  }
  connections.clear();
}
