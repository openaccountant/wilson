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

// ── Review workflow (dashboard Review tab) ───────────────────────────────────

export interface PendingReviewRow {
  review_id: number;
  transaction_id: number;
  suggested_category: string;
  confidence: number;
  suggested_at: string;
  date: string;
  description: string;
  merchant_name: string | null;
  amount: number;
  /** Category currently applied to the transaction — non-null only for backfilled historical rows. */
  current_category: string | null;
}

/**
 * The pending review queue joined with the transaction under review, newest
 * first. This is the dashboard Review tab's read model: the human sees the
 * transaction's date, amount, and description next to the suggested category
 * and confidence, plus whatever category is already applied (backfilled
 * historical rows keep theirs until acted on).
 */
export function getPendingReviewQueue(db: Database, limit?: number): PendingReviewRow[] {
  const sql = `
    SELECT r.id AS review_id, r.transaction_id, r.suggested_category, r.confidence,
           r.created_at AS suggested_at,
           t.date, t.description, t.merchant_name, t.amount,
           t.category AS current_category
    FROM categorization_reviews r
    JOIN transactions t ON t.id = r.transaction_id
    WHERE r.status = 'pending'
    ORDER BY r.created_at DESC, r.id DESC
    ${limit !== undefined ? 'LIMIT @limit' : ''}
  `;
  return db.prepare(sql).all(limit !== undefined ? { limit } : undefined) as PendingReviewRow[];
}

export type ReviewResolution =
  | { ok: true; transactionId: number; category: string; confidence: number | null }
  | { ok: false; error: string };

/**
 * Atomically apply a human decision and resolve the queue entry: one
 * transaction writes the transaction row (category, confidence,
 * user_verified=1) and flips the review row to 'resolved'. Confirm uses the
 * review's own suggested category + stored confidence; correct uses the
 * caller-validated category and NULLs the machine confidence (a human-assigned
 * category carries no score — this also clears stale low scores on backfilled
 * rows). Doing all three effects inside one db.transaction makes "applied
 * category with still-pending review" and "resolved review with unapplied
 * category" impossible. The review row is kept with status='resolved' (the
 * partial unique index only constrains pending rows, so resolved rows never
 * block re-suggestion).
 */
export function resolveCategorizationReview(
  db: Database,
  reviewId: number,
  outcome: { action: 'confirm' } | { action: 'correct'; category: string }
): ReviewResolution {
  const apply = db.transaction((rid: number, dec: typeof outcome): ReviewResolution => {
    const review = db.prepare(
      'SELECT id, transaction_id, suggested_category, confidence, status FROM categorization_reviews WHERE id = @id'
    ).get({ id: rid }) as { id: number; transaction_id: number; suggested_category: string; confidence: number; status: string } | undefined;
    if (!review) return { ok: false, error: 'review not found' };
    if (review.status !== 'pending') return { ok: false, error: 'review already resolved' };

    const category = dec.action === 'confirm' ? review.suggested_category : dec.category;
    const confidence = dec.action === 'confirm' ? review.confidence : null;

    db.prepare(`
      UPDATE transactions
      SET category = @category, category_confidence = @confidence,
          user_verified = 1, updated_at = datetime('now')
      WHERE id = @id
    `).run({ id: review.transaction_id, category, confidence });
    db.prepare("UPDATE categorization_reviews SET status = 'resolved' WHERE id = @id").run({ id: rid });

    return { ok: true, transactionId: review.transaction_id, category, confidence };
  });
  return apply(reviewId, outcome);
}