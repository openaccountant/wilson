import type { Database } from './compat-sqlite.js';

// ── Interfaces ────────────────────────────────────────────────────────────────

export interface MemoryRow {
  id: number;
  memory_type: 'context' | 'insight' | 'advice';
  content: string;
  category: string | null;
  source_query: string | null;
  expires_at: string | null;
  is_active: number;
  created_at: string;
}

export interface MemoryInsert {
  memoryType: 'context' | 'insight' | 'advice';
  content: string;
  category?: string;
  sourceQuery?: string;
  expiresAt?: string;
}

// ── Queries ───────────────────────────────────────────────────────────────────

export function getActiveMemories(
  db: Database,
  type?: MemoryRow['memory_type'],
  limit: number = 50
): MemoryRow[] {
  if (type) {
    return db.prepare(`
      SELECT * FROM memories
      WHERE is_active = 1 AND memory_type = @type
      ORDER BY created_at DESC LIMIT @limit
    `).all({ type, limit }) as MemoryRow[];
  }
  return db.prepare(`
    SELECT * FROM memories
    WHERE is_active = 1
    ORDER BY created_at DESC LIMIT @limit
  `).all({ limit }) as MemoryRow[];
}

export function addMemory(db: Database, memory: MemoryInsert): number {
  const result = db.prepare(`
    INSERT INTO memories (memory_type, content, category, source_query, expires_at)
    VALUES (@memoryType, @content, @category, @sourceQuery, @expiresAt)
  `).run({
    memoryType: memory.memoryType,
    content: memory.content,
    category: memory.category ?? null,
    sourceQuery: memory.sourceQuery ?? null,
    expiresAt: memory.expiresAt ?? null,
  });
  return (result as { lastInsertRowid: number }).lastInsertRowid;
}

export function deactivateMemory(db: Database, id: number): boolean {
  const result = db.prepare(`
    UPDATE memories SET is_active = 0 WHERE id = @id
  `).run({ id });
  return (result as { changes: number }).changes > 0;
}

export function pruneExpiredMemories(db: Database): number {
  const result = db.prepare(`
    UPDATE memories SET is_active = 0
    WHERE is_active = 1 AND expires_at IS NOT NULL AND expires_at < datetime('now')
  `).run();
  return (result as { changes: number }).changes;
}

export function searchMemories(db: Database, query: string): MemoryRow[] {
  return db.prepare(`
    SELECT * FROM memories
    WHERE is_active = 1 AND content LIKE @query
    ORDER BY created_at DESC LIMIT 20
  `).all({ query: `%${query}%` }) as MemoryRow[];
}
