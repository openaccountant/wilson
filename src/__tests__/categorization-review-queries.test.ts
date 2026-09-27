import { describe, expect, test } from 'bun:test';
import { insertTransactions } from '../db/queries.js';
import {
  addPendingCategorizationReview,
  countPendingCategorizationReviews,
  getPendingCategorizationReviews,
  deletePendingCategorizationReview,
  resolveCategorizationReview,
  type CategorizationReviewRow,
} from '../db/categorization-review-queries.js';
import { createTestDb } from './helpers.js';

describe('categorization-review-queries', () => {
  test('add/get/count/delete pending reviews with dedup', () => {
    const db = createTestDb();
    insertTransactions(db, [{ date: '2026-02-15', description: 'Mystery Store', amount: -50 }]);
    const txn = db.prepare('SELECT id FROM transactions').get() as { id: number };

    const first = addPendingCategorizationReview(db, txn.id, 'Other', 0.6);
    expect(first).toBe(true);

    // Same transaction again → deduped by the partial unique index
    const second = addPendingCategorizationReview(db, txn.id, 'Shopping', 0.55);
    expect(second).toBe(false);

    expect(countPendingCategorizationReviews(db)).toBe(1);

    const rows = getPendingCategorizationReviews(db) as CategorizationReviewRow[];
    expect(rows.length).toBe(1);
    expect(rows[0].transaction_id).toBe(txn.id);
    expect(rows[0].suggested_category).toBe('Other'); // first insert wins
    expect(rows[0].confidence).toBe(0.6);
    expect(rows[0].status).toBe('pending');

    // limit parameter is honored
    expect(getPendingCategorizationReviews(db, 1).length).toBe(1);
    expect(getPendingCategorizationReviews(db, 0).length).toBe(0);

    deletePendingCategorizationReview(db, txn.id);
    expect(countPendingCategorizationReviews(db)).toBe(0);
    expect(getPendingCategorizationReviews(db)).toEqual([]);

    // Deleting a non-pending transaction is a no-op
    expect(() => deletePendingCategorizationReview(db, 999999)).not.toThrow();

    db.close();
  });

  test('pending rows cascade when the parent transaction is deleted', () => {
    const db = createTestDb();
    insertTransactions(db, [{ date: '2026-02-15', description: 'Doomed Store', amount: -50 }]);
    const txn = db.prepare('SELECT id FROM transactions').get() as { id: number };

    expect(addPendingCategorizationReview(db, txn.id, 'Other', 0.6)).toBe(true);
    expect(countPendingCategorizationReviews(db)).toBe(1);

    db.prepare('DELETE FROM transactions WHERE id = @id').run({ id: txn.id });
    expect(countPendingCategorizationReviews(db)).toBe(0);

    db.close();
  });

  test('resolve confirm applies the suggested category, marks verified, and resolves; second resolve fails', () => {
    const db = createTestDb();
    insertTransactions(db, [{ date: '2026-02-15', description: 'Mystery Store', amount: -50 }]);
    const txn = db.prepare('SELECT id FROM transactions').get() as { id: number };
    addPendingCategorizationReview(db, txn.id, 'Transport', 0.55);
    const review = getPendingCategorizationReviews(db)[0] as CategorizationReviewRow;

    const result = resolveCategorizationReview(db, review.id, { action: 'confirm' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.transactionId).toBe(txn.id);
      expect(result.category).toBe('Transport');
      expect(result.confidence).toBe(0.55);
    }

    // Transaction row: category applied with the review's confidence, verified flag set
    const txnRow = db.prepare('SELECT category, category_confidence, user_verified FROM transactions WHERE id = @id')
      .get({ id: txn.id }) as { category: string; category_confidence: number; user_verified: number };
    expect(txnRow.category).toBe('Transport');
    expect(txnRow.category_confidence).toBe(0.55);
    expect(txnRow.user_verified).toBe(1);

    // Review row is resolved (kept, not deleted) and leaves the pending queue
    const reviewRow = db.prepare('SELECT status FROM categorization_reviews WHERE id = @id')
      .get({ id: review.id }) as { status: string };
    expect(reviewRow.status).toBe('resolved');
    expect(getPendingCategorizationReviews(db)).toEqual([]);

    // Re-resolving the same row hits the status guard
    const again = resolveCategorizationReview(db, review.id, { action: 'confirm' });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error).toContain('already resolved');

    db.close();
  });

  test('resolve correct applies the chosen category, NULLs confidence, and resolves; unknown id fails', () => {
    const db = createTestDb();
    insertTransactions(db, [{ date: '2026-02-15', description: 'Mystery Store', amount: -50 }]);
    const txn = db.prepare('SELECT id FROM transactions').get() as { id: number };
    addPendingCategorizationReview(db, txn.id, 'Transport', 0.55);
    const review = getPendingCategorizationReviews(db)[0] as CategorizationReviewRow;

    const result = resolveCategorizationReview(db, review.id, { action: 'correct', category: 'Health' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.category).toBe('Health');
      expect(result.confidence).toBeNull();
    }

    const txnRow = db.prepare('SELECT category, category_confidence, user_verified FROM transactions WHERE id = @id')
      .get({ id: txn.id }) as { category: string; category_confidence: number | null; user_verified: number };
    expect(txnRow.category).toBe('Health');
    expect(txnRow.category_confidence).toBeNull();
    expect(txnRow.user_verified).toBe(1);

    // Unknown review id
    const missing = resolveCategorizationReview(db, 999999, { action: 'confirm' });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toContain('not found');

    db.close();
  });
});