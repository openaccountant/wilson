import { Database } from './compat-sqlite.js';
import { existsSync, mkdirSync } from 'fs';
import { ALL_SCHEMA } from './schema.js';

const DB_DIR = '.openspend';
const DB_FILE = 'data.db';

export function initDatabase(): Database {
  if (!existsSync(DB_DIR)) {
    mkdirSync(DB_DIR, { recursive: true });
  }

  const db = new Database(`${DB_DIR}/${DB_FILE}`);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  for (const sql of ALL_SCHEMA) {
    db.exec(sql);
  }

  return db;
}
