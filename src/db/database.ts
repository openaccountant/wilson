import { Database } from './compat-sqlite.js';
import { existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { runMigrations } from './migrations.js';
import { getActiveProfile } from '../profile/active.js';

export function initDatabase(dbPath?: string): Database {
  const resolvedPath = dbPath ?? getActiveProfile().database;
  const dir = dirname(resolvedPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const db = new Database(resolvedPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}
