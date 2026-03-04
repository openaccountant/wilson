import { describe, test, expect, beforeEach } from 'bun:test';
import type { Database } from '../db/compat-sqlite.js';
import { createTestDb, seedTestData } from './helpers.js';
import { initEditTransactionTool, editTransactionTool } from '../tools/query/edit-transaction.js';

describe('edit-transaction tool', () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDb();
    seedTestData(db);
    initEditTransactionTool(db);
  });

  test('edit date updates the transaction', async () => {
    const rows = db.prepare('SELECT id FROM transactions LIMIT 1').all() as { id: number }[];
    const id = rows[0].id;
    const result = JSON.parse(await editTransactionTool.func({ id, date: '2026-06-15' })).data;
    expect(result.success).toBe(true);
    expect(result.transaction.date).toBe('2026-06-15');
  });

  test('edit category updates the transaction', async () => {
    const rows = db.prepare('SELECT id FROM transactions LIMIT 1').all() as { id: number }[];
    const id = rows[0].id;
    const result = JSON.parse(await editTransactionTool.func({ id, category: 'Entertainment' })).data;
    expect(result.success).toBe(true);
    expect(result.transaction.category).toBe('Entertainment');
  });

  test('edit non-existent ID returns not found', async () => {
    const result = JSON.parse(await editTransactionTool.func({ id: 99999, category: 'Nope' })).data;
    expect(result.success).toBe(false);
    expect(result.message).toContain('not found');
  });

  test('no fields provided returns no fields to update', async () => {
    const rows = db.prepare('SELECT id FROM transactions LIMIT 1').all() as { id: number }[];
    const id = rows[0].id;
    const result = JSON.parse(await editTransactionTool.func({ id })).data;
    expect(result.success).toBe(false);
    expect(result.message).toContain('No fields to update');
  });

  test('tool has correct name and description', () => {
    expect(editTransactionTool.name).toBe('edit_transaction');
    expect(editTransactionTool.description).toContain('Edit a transaction');
  });
});
