import { describe, expect, test } from 'bun:test';
import { insertTransactions, updateTransaction } from '../db/queries.js';
import {
  addPendingCategorizationReview,
  countPendingCategorizationReviews,
  getPendingCategorizationReviews,
  getPendingReviewQueue,
  getQueuedReview,
  getReviewQueueStatus,
  deletePendingCategorizationReview,
  resolveCategorizationReview,
  type CategorizationReviewRow,
} from '../db/categorization-review-queries.js';
import { apiReviewQueueStatus, apiUpdateTransaction } from '../dashboard/api.js';
import type { Database } from '../db/compat-sqlite.js';
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

  // ── What counts as "needs a decision" (#191, #185) ────────────────────────
  function txnByDesc(db: Database, description: string): number {
    return (db.prepare('SELECT id FROM transactions WHERE description = @description').get({ description }) as { id: number }).id;
  }

  /** Every queue reader, so one assertion proves they agree. */
  function queueIds(db: Database): { queue: number[]; flat: number[]; count: number } {
    return {
      queue: getPendingReviewQueue(db).map((r) => r.transaction_id).sort(),
      flat: getPendingCategorizationReviews(db).map((r) => r.transaction_id).sort(),
      count: countPendingCategorizationReviews(db),
    };
  }

  test('a suggestion equal to the current category is not a decision: left out of every queue read, and resolve refuses it', () => {
    const db = createTestDb();
    insertTransactions(db, [
      { date: '2026-02-15', description: 'Same Cafe', amount: -12, category: 'Dining', category_confidence: 0.55 },
      { date: '2026-02-16', description: 'Same Cafe Lowercase', amount: -12, category: 'Dining', category_confidence: 0.55 },
      { date: '2026-02-17', description: 'Different Shop', amount: -40, category: 'Dining', category_confidence: 0.5 },
      { date: '2026-02-18', description: 'Uncategorized Store', amount: -9 },
    ]);
    const same = txnByDesc(db, 'Same Cafe');
    const sameLower = txnByDesc(db, 'Same Cafe Lowercase');
    const different = txnByDesc(db, 'Different Shop');
    const uncat = txnByDesc(db, 'Uncategorized Store');
    addPendingCategorizationReview(db, same, 'Dining', 0.55);
    addPendingCategorizationReview(db, sameLower, 'dining', 0.55); // same category, other case
    addPendingCategorizationReview(db, different, 'Shopping', 0.5);
    addPendingCategorizationReview(db, uncat, 'Other', 0.4);

    const ids = queueIds(db);
    expect(ids.queue).toEqual([different, uncat].sort());
    expect(ids.flat).toEqual(ids.queue);
    expect(ids.count).toBe(2);
    // The "currently X" row that is a real decision keeps its context
    expect(getPendingReviewQueue(db).find((r) => r.transaction_id === different)?.current_category).toBe('Dining');

    // Nothing was written: the moot row is still 'pending' in storage (a pure read-side filter, NN-03)
    const sameReview = db.prepare('SELECT id, status FROM categorization_reviews WHERE transaction_id = @id').get({ id: same }) as { id: number; status: string };
    expect(sameReview.status).toBe('pending');
    expect(getQueuedReview(db, sameReview.id)).toBeUndefined();

    const refused = resolveCategorizationReview(db, sameReview.id, { action: 'correct', category: 'Health' });
    expect(refused).toEqual({ ok: false, error: 'review no longer needs a decision' });
    const row = db.prepare('SELECT category, user_verified FROM transactions WHERE id = @id').get({ id: same }) as { category: string; user_verified: number };
    expect(row).toEqual({ category: 'Dining', user_verified: 0 });

    db.close();
  });

  test('a human pick on Transactions (PATCH {category, user_verified: 1}, #184) drops that transaction\'s pending suggestion', async () => {
    const db = createTestDb();
    insertTransactions(db, [
      { date: '2026-02-15', description: 'Picked By Hand', amount: -30 },
      { date: '2026-02-16', description: 'Still Waiting', amount: -20 },
    ]);
    const picked = txnByDesc(db, 'Picked By Hand');
    const waiting = txnByDesc(db, 'Still Waiting');
    addPendingCategorizationReview(db, picked, 'Shopping', 0.5);
    addPendingCategorizationReview(db, waiting, 'Shopping', 0.5);
    const pickedReview = getPendingReviewQueue(db).find((r) => r.transaction_id === picked)!.review_id;

    // The exact body the inline picker sends (lib/transactionEditing categoryPatchBody), a category other than the suggestion.
    const res = await apiUpdateTransaction(db, picked, { category: 'Dining', user_verified: 1 });
    expect(res.success).toBe(true);

    expect(queueIds(db)).toEqual({ queue: [waiting], flat: [waiting], count: 1 });
    expect(getQueuedReview(db, pickedReview)).toBeUndefined();
    // A stale confirm (e.g. an agent card prepared earlier) cannot overwrite the human's pick
    expect(resolveCategorizationReview(db, pickedReview, { action: 'confirm' }).ok).toBe(false);
    expect((db.prepare('SELECT category FROM transactions WHERE id = @id').get({ id: picked }) as { category: string }).category).toBe('Dining');

    db.close();
  });

  test('a moot suggestion comes back when the category is cleared or changed without a human verifying it', () => {
    const db = createTestDb();
    insertTransactions(db, [{ date: '2026-02-15', description: 'Flip Flop', amount: -30, category: 'Dining', category_confidence: 0.5 }]);
    const id = txnByDesc(db, 'Flip Flop');
    addPendingCategorizationReview(db, id, 'Dining', 0.5);
    expect(countPendingCategorizationReviews(db)).toBe(0);

    // Changed to something else, unverified (not a human decision): the suggestion is a real choice again
    updateTransaction(db, id, { category: 'Shopping' });
    expect(getPendingReviewQueue(db).map((r) => [r.transaction_id, r.current_category])).toEqual([[id, 'Shopping']]);

    // Even a verified row with no category needs a decision
    db.prepare('UPDATE transactions SET category = NULL, user_verified = 1 WHERE id = @id').run({ id });
    expect(countPendingCategorizationReviews(db)).toBe(1);

    db.close();
  });

  test('getReviewQueueStatus: queue count matches the queue, uncategorized matches the Transactions "Uncategorized" filter (NULL or blank)', () => {
    const db = createTestDb();
    expect(getReviewQueueStatus(db)).toEqual({ pending: 0, uncategorized: 0, transactions: 0, uncategorizedFrom: null, uncategorizedTo: null });

    insertTransactions(db, [
      { date: '2026-01-05', description: 'No Category A', amount: -10 },
      { date: '2026-03-09', description: 'No Category B', amount: -11 },
      { date: '2026-02-01', description: 'Blank Category', amount: -12, category: '  ' },
      { date: '2026-02-02', description: 'Has Category', amount: -13, category: 'Dining', category_confidence: 0.5 },
    ]);
    // No suggestions at all: the queue is empty but three rows still have no category (#185)
    expect(getReviewQueueStatus(db)).toEqual({ pending: 0, uncategorized: 3, transactions: 4, uncategorizedFrom: '2026-01-05', uncategorizedTo: '2026-03-09' });

    addPendingCategorizationReview(db, txnByDesc(db, 'No Category A'), 'Other', 0.4);
    addPendingCategorizationReview(db, txnByDesc(db, 'Has Category'), 'Dining', 0.5); // moot: not counted
    const status = apiReviewQueueStatus(db);
    expect(status.pending).toBe(1);
    expect(status.pending).toBe(getPendingReviewQueue(db).length);
    expect(status.uncategorized).toBe(3);

    db.close();
  });
});
