import type { Database } from './compat-sqlite.js';
import type { TransactionRow } from './queries.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface EntityRow {
  id: number;
  name: string;
  slug: string;
  description: string | null;
  color: string;
  is_default: number;
  created_at: string;
  updated_at: string;
}

export interface EntityInsert {
  name: string;
  description?: string;
  color?: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function toSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, '-')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// ── Query Functions ──────────────────────────────────────────────────────────

/**
 * Get all entities sorted by is_default DESC, name ASC.
 */
export function getEntities(db: Database): EntityRow[] {
  return db.prepare('SELECT * FROM entities ORDER BY is_default DESC, name ASC').all() as EntityRow[];
}

/**
 * Get a single entity by slug.
 */
export function getEntityBySlug(db: Database, slug: string): EntityRow | undefined {
  return db.prepare('SELECT * FROM entities WHERE slug = @slug').get({ slug }) as EntityRow | undefined;
}

/**
 * Get a single entity by id.
 */
export function getEntityById(db: Database, id: number): EntityRow | undefined {
  return db.prepare('SELECT * FROM entities WHERE id = @id').get({ id }) as EntityRow | undefined;
}

/**
 * Create a new entity. Returns the new row ID.
 */
export function createEntity(db: Database, insert: EntityInsert): number {
  const slug = toSlug(insert.name);
  const result = db.prepare(`
    INSERT INTO entities (name, slug, description, color)
    VALUES (@name, @slug, @description, @color)
  `).run({
    name: insert.name,
    slug,
    description: insert.description ?? null,
    color: insert.color ?? '#22c55e',
  });
  return (result as { lastInsertRowid: number }).lastInsertRowid;
}

/**
 * Update an existing entity.
 */
export function updateEntity(
  db: Database,
  id: number,
  updates: { name?: string; description?: string; color?: string }
): boolean {
  const sets: string[] = [];
  const params: Record<string, unknown> = { id };

  if (updates.name !== undefined) {
    sets.push('name = @name');
    params.name = updates.name;
    sets.push('slug = @slug');
    params.slug = toSlug(updates.name);
  }
  if (updates.description !== undefined) {
    sets.push('description = @description');
    params.description = updates.description;
  }
  if (updates.color !== undefined) {
    sets.push('color = @color');
    params.color = updates.color;
  }

  if (sets.length === 0) return false;

  sets.push("updated_at = datetime('now')");
  const result = db.prepare(`UPDATE entities SET ${sets.join(', ')} WHERE id = @id`).run(params);
  return (result as { changes: number }).changes > 0;
}

/**
 * Delete an entity. Rejects if is_default=1 or if transactions reference it.
 */
export function deleteEntity(db: Database, id: number): { ok: boolean; error?: string } {
  const entity = getEntityById(db, id);
  if (!entity) return { ok: false, error: 'Entity not found' };
  if (entity.is_default) return { ok: false, error: 'Cannot delete the default entity' };

  const txnCount = (db.prepare(
    'SELECT COUNT(*) AS cnt FROM transactions WHERE entity_id = @id'
  ).get({ id }) as { cnt: number }).cnt;
  if (txnCount > 0) {
    return { ok: false, error: `Cannot delete entity with ${txnCount} linked transactions. Reassign them first.` };
  }

  db.prepare('DELETE FROM entities WHERE id = @id').run({ id });
  return { ok: true };
}

/**
 * Bulk-assign an entity to multiple transactions.
 */
export function assignEntityToTransactions(db: Database, entityId: number, transactionIds: number[]): number {
  const stmt = db.prepare(`
    UPDATE transactions SET entity_id = @entityId, updated_at = datetime('now')
    WHERE id = @txnId
  `);
  const assign = db.transaction((ids: number[]) => {
    let count = 0;
    for (const txnId of ids) {
      const result = stmt.run({ entityId, txnId });
      count += (result as { changes: number }).changes;
    }
    return count;
  });
  return assign(transactionIds);
}

/**
 * Get transactions that have not been assigned to any entity.
 */
export function getUnassignedTransactions(db: Database, limit?: number): TransactionRow[] {
  const sql = limit
    ? 'SELECT * FROM transactions WHERE entity_id IS NULL ORDER BY date DESC LIMIT @limit'
    : 'SELECT * FROM transactions WHERE entity_id IS NULL ORDER BY date DESC';
  return (limit ? db.prepare(sql).all({ limit }) : db.prepare(sql).all()) as TransactionRow[];
}

/**
 * Assign an entity to an account.
 */
export function assignEntityToAccount(db: Database, entityId: number, accountId: number): boolean {
  const result = db.prepare(`
    UPDATE accounts SET entity_id = @entityId, updated_at = datetime('now')
    WHERE id = @accountId
  `).run({ entityId, accountId });
  return (result as { changes: number }).changes > 0;
}
