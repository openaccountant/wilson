import type { Database } from './compat-sqlite.js';

// ── Interfaces ────────────────────────────────────────────────────────────────

export interface CategorizationReviewRow {
  id: number;
  transaction_id: number;
  suggested_category: string;
  confidence: number;
  status: string;
  created_at: string;
}

// ── Queries ───────────────────────────────────────────────────────────────────

/**
 * Insert a pending review row for a below-threshold categorization suggestion.
 * Returns true if inserted, false if a pending row already existed for the
 * transaction (dedup is enforced by the partial unique index
 * idx_categorization_reviews_pending_txn + INSERT OR IGNORE).
 */
export function addPendingCategorizationReview(
  db: Database,
  transactionId: number,
  suggestedCategory: string,
  confidence: number
): boolean {
  const result = db.prepare(`
    INSERT OR IGNORE INTO categorization_reviews (transaction_id, suggested_category, confidence, status)
    VALUES (@transactionId, @suggestedCategory, @confidence, 'pending')
  `).run({ transactionId, suggestedCategory, confidence }) as { changes: number };

  return result.changes > 0;
}

/**
 * The pending review queue, newest first.
 */
export function getPendingCategorizationReviews(db: Database, limit?: number): CategorizationReviewRow[] {
  const sql = `
    SELECT * FROM categorization_reviews
    WHERE status = 'pending'
    ORDER BY created_at DESC, id DESC
    ${limit !== undefined ? 'LIMIT @limit' : ''}
  `;
  return db.prepare(sql).all(limit !== undefined ? { limit } : undefined) as CategorizationReviewRow[];
}

/**
 * Number of transactions awaiting human review.
 */
export function countPendingCategorizationReviews(db: Database): number {
  const row = db.prepare(`
    SELECT COUNT(*) AS count FROM categorization_reviews WHERE status = 'pending'
  `).get() as { count: number };
  return row.count;
}

/**
 * Remove the pending review row for a transaction. Called whenever the
 * transaction becomes categorized (rules or an above-threshold suggestion)
 * so the queue never lists rows that no longer need a human.
 */
export function deletePendingCategorizationReview(db: Database, transactionId: number): void {
  db.prepare(`
    DELETE FROM categorization_reviews WHERE transaction_id = @transactionId AND status = 'pending'
  `).run({ transactionId });
}