import { describe, test, expect, beforeEach } from 'bun:test';
import type { Database } from '../db/compat-sqlite.js';
import { createTestDb, seedTestData } from './helpers.js';
import { initDeleteTransactionTool, deleteTransactionTool } from '../tools/query/delete-transaction.js';

describe('delete-transaction tool', () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDb();
    seedTestData(db);
    initDeleteTransactionTool(db);
  });

  test('initDeleteTransactionTool sets db so func works', async () => {
    const rows = db.prepare('SELECT id FROM transactions LIMIT 1').all() as { id: number }[];
    const id = rows[0].id;
    const result = JSON.parse(await deleteTransactionTool.func({ id })).data;
    expect(result.success).toBe(true);
  });

  test('delete existing transaction returns success message', async () => {
    const rows = db.prepare('SELECT id, description, date, amount FROM transactions LIMIT 1').all() as {
      id: number; description: string; date: string; amount: number;
    }[];
    const txn = rows[0];
    const result = JSON.parse(await deleteTransactionTool.func({ id: txn.id })).data;
    expect(result.success).toBe(true);
    expect(result.message).toContain(`Deleted transaction #${txn.id}`);
    expect(result.message).toContain(txn.description);

    // Verify actually deleted
    const check = db.prepare('SELECT id FROM transactions WHERE id = @id').get({ id: txn.id });
    expect(check).toBeFalsy();
  });

  test('delete non-existent ID returns not found', async () => {
    const result = JSON.parse(await deleteTransactionTool.func({ id: 99999 })).data;
    expect(result.success).toBe(false);
    expect(result.message).toContain('not found');
  });

  test('tool has correct name and description', () => {
    expect(deleteTransactionTool.name).toBe('delete_transaction');
    expect(deleteTransactionTool.description).toContain('Delete a transaction');
  });
});
