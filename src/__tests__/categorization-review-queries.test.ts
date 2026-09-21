import { describe, expect, test } from 'bun:test';
import { insertTransactions } from '../db/queries.js';
import {
  addPendingCategorizationReview,
  countPendingCategorizationReviews,
  getPendingCategorizationReviews,
  deletePendingCategorizationReview,
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
});