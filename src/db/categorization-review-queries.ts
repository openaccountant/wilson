import type { Database } from './compat-sqlite.js';
import { categoryFilterSql } from './spend-rules.js';

// ── Interfaces ────────────────────────────────────────────────────────────────

export interface CategorizationReviewRow {
  id: number;
  transaction_id: number;
  suggested_category: string;
  confidence: number;
  status: string;
  created_at: string;
}

// ── What counts as "needs a decision" ────────────────────────────────────────

/**
 * SQL condition, over `categorization_reviews r JOIN transactions t`, for a
 * pending review that still needs a human decision (#191). A pending row is
 * moot, and left out of every queue read, when its transaction already has a
 * category and either:
 *  - a human set it (`user_verified = 1`, e.g. the inline picker on
 *    Transactions, #184), or
 *  - it already equals the suggestion (backfilled rows: "Suggested: Dining,
 *    currently Dining" changes nothing).
 * This is a pure read-side filter: nothing is written, so no agent path
 * resolves anything (NN-03). The row stays 'pending' in storage and comes back
 * if the category is cleared or changed to something else without a human
 * verifying it. Every reader of the queue (Review tab, counts, WebMCP/MCP
 * list_review_items, review actions) uses this one definition.
 */
export const REVIEW_NEEDS_DECISION_SQL = `r.status = 'pending'
      AND NOT (t.category IS NOT NULL
               AND (COALESCE(t.user_verified, 0) = 1 OR t.category = r.suggested_category COLLATE NOCASE))`;

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
 * The pending review queue (rows that still need a decision), newest first.
 */
export function getPendingCategorizationReviews(db: Database, limit?: number): CategorizationReviewRow[] {
  const sql = `
    SELECT r.* FROM categorization_reviews r
    JOIN transactions t ON t.id = r.transaction_id
    WHERE ${REVIEW_NEEDS_DECISION_SQL}
    ORDER BY r.created_at DESC, r.id DESC
    ${limit !== undefined ? 'LIMIT @limit' : ''}
  `;
  return db.prepare(sql).all(limit !== undefined ? { limit } : undefined) as CategorizationReviewRow[];
}

/**
 * Number of transactions awaiting human review (same definition as the queue).
 */
export function countPendingCategorizationReviews(db: Database): number {
  const row = db.prepare(`
    SELECT COUNT(*) AS count FROM categorization_reviews r
    JOIN transactions t ON t.id = r.transaction_id
    WHERE ${REVIEW_NEEDS_DECISION_SQL}
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
    WHERE ${REVIEW_NEEDS_DECISION_SQL}
    ORDER BY r.created_at DESC, r.id DESC
    ${limit !== undefined ? 'LIMIT @limit' : ''}
  `;
  return db.prepare(sql).all(limit !== undefined ? { limit } : undefined) as PendingReviewRow[];
}

/**
 * One review by id, only if it is in the queue (pending and still needs a
 * decision). A review the queue leaves out reads as undefined, so an agent's
 * open/resolve of a moot review id fails like an unknown one.
 */
export function getQueuedReview(
  db: Database,
  reviewId: number
): { id: number; transaction_id: number; suggested_category: string; confidence: number; status: string } | undefined {
  const row = db.prepare(`
    SELECT r.id, r.transaction_id, r.suggested_category, r.confidence, r.status
    FROM categorization_reviews r
    JOIN transactions t ON t.id = r.transaction_id
    WHERE r.id = @id AND ${REVIEW_NEEDS_DECISION_SQL}
  `).get({ id: reviewId }) as
    | { id: number; transaction_id: number; suggested_category: string; confidence: number; status: string }
    | null;
  return row ?? undefined;
}

export interface ReviewQueueStatus {
  /** Reviews in the queue (same definition as getPendingReviewQueue). */
  pending: number;
  /** Transactions the Transactions tab's 'Uncategorized' filter shows (NULL or blank category). */
  uncategorized: number;
  /** All transactions in the profile. */
  transactions: number;
  /** Earliest / latest date among the uncategorized rows (null when none), so a link can show exactly them. */
  uncategorizedFrom: string | null;
  uncategorizedTo: string | null;
}

/**
 * What the Review tab's empty state needs to tell the truth (#185): "all
 * suggestions resolved" only when nothing is uncategorized; otherwise how many
 * rows still have no category and no suggestion.
 */
export function getReviewQueueStatus(db: Database): ReviewQueueStatus {
  const uncat = categoryFilterSql('Uncategorized');
  const counts = db.prepare(`
    SELECT COUNT(*) AS transactions,
           COALESCE(SUM(CASE WHEN ${uncat.sql} THEN 1 ELSE 0 END), 0) AS uncategorized,
           MIN(CASE WHEN ${uncat.sql} THEN date END) AS uncategorizedFrom,
           MAX(CASE WHEN ${uncat.sql} THEN date END) AS uncategorizedTo
    FROM transactions
  `).get(uncat.params) as Omit<ReviewQueueStatus, 'pending'>;
  return { pending: countPendingCategorizationReviews(db), ...counts };
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
 * rows). The revision is bumped like every other write to a transaction, so an agent's card prepared against
 * the old revision (categorize, edit, review action) goes stale instead of overwriting this decision (threat T30).
 * Doing all three effects inside one db.transaction makes "applied
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
    // Moot since queued (a human categorized the transaction, or it already has the suggested category): the queue
    // no longer shows it, so acting on it would overwrite a later human pick with a stale suggestion.
    if (!getQueuedReview(db, rid)) return { ok: false, error: 'review no longer needs a decision' };

    const category = dec.action === 'confirm' ? review.suggested_category : dec.category;
    const confidence = dec.action === 'confirm' ? review.confidence : null;

    db.prepare(`
      UPDATE transactions
      SET category = @category, category_confidence = @confidence,
          user_verified = 1, updated_at = datetime('now'),
          revision = revision + 1
      WHERE id = @id
    `).run({ id: review.transaction_id, category, confidence });
    db.prepare("UPDATE categorization_reviews SET status = 'resolved' WHERE id = @id").run({ id: rid });

    return { ok: true, transactionId: review.transaction_id, category, confidence };
  });
  return apply(reviewId, outcome);
}