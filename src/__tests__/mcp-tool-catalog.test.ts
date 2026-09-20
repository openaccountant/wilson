import { describe, expect, test } from 'bun:test';
import { createTestDb, seedTestData } from './helpers.js';
import type { Database } from '../db/compat-sqlite.js';
import {
  MCP_TOOL_CATALOG, isMutatingCall, jsonSchemaFor, schemaDigest, toolAnnotations,
  prepareMutation, commitMutation, executeRead, PrepareError,
} from '../mcp/tool-catalog.js';

function firstTxnId(db: Database): number {
  return (db.prepare('SELECT id FROM transactions LIMIT 1').get() as { id: number }).id;
}

describe('tool catalog definition', () => {
  test('v1 catalog is exactly the 8 agreed tools, no delete_transaction', () => {
    const names = MCP_TOOL_CATALOG.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        'categorize_transaction', 'edit_transaction', 'forecast', 'net_worth',
        'profit_loss', 'spending_summary', 'tax_flag', 'transaction_search',
      ].sort()
    );
    expect(names).not.toContain('delete_transaction');
  });

  test('jsonSchemaFor produces a real JSON Schema object per tool', () => {
    const schema = jsonSchemaFor('edit_transaction') as any;
    expect(schema.type).toBe('object');
    expect(schema.properties.id).toBeDefined();
  });

  test('schemaDigest changes are stable for the same tool and differ across tools', () => {
    expect(schemaDigest('edit_transaction')).toBe(schemaDigest('edit_transaction'));
    expect(schemaDigest('edit_transaction')).not.toBe(schemaDigest('categorize_transaction'));
  });

  test('tax_flag is mutating only for flag/unflag, not summary/list', () => {
    expect(isMutatingCall('tax_flag', { action: 'flag' })).toBe(true);
    expect(isMutatingCall('tax_flag', { action: 'unflag' })).toBe(true);
    expect(isMutatingCall('tax_flag', { action: 'summary' })).toBe(false);
    expect(isMutatingCall('tax_flag', { action: 'list' })).toBe(false);
  });

  test('read tools are never mutating', () => {
    expect(isMutatingCall('transaction_search', { query: 'x' })).toBe(false);
    expect(isMutatingCall('forecast', {})).toBe(false);
  });

  test('toolAnnotations maps our classification onto WebMCP\'s spec-native ToolAnnotations', () => {
    // consequentialHint is the spec's own signal to a browser-integrated
    // agent that a tool call needs care — every mutating tool must set it.
    for (const name of ['categorize_transaction', 'edit_transaction', 'tax_flag']) {
      const a = toolAnnotations(name);
      expect(a.consequentialHint).toBe(true);
      expect(a.readOnlyHint).toBe(false);
    }
    for (const name of ['transaction_search', 'spending_summary', 'profit_loss', 'net_worth', 'forecast']) {
      const a = toolAnnotations(name);
      expect(a.consequentialHint).toBe(false);
      expect(a.readOnlyHint).toBe(true);
    }
  });
});

describe('prepareMutation / commitMutation', () => {
  test('categorize_transaction: prepare computes a real before/after delta', () => {
    const db = createTestDb();
    seedTestData(db);
    const id = firstTxnId(db);
    const delta = prepareMutation(db, 'categorize_transaction', { id, category: 'Entertainment' });
    expect(delta.before).toMatchObject({ category: 'Groceries' });
    expect(delta.after).toMatchObject({ category: 'Entertainment' });
    expect(delta.revision).toBe(1);
  });

  test('categorize_transaction: prepare on a missing row reports not-found without throwing', () => {
    const db = createTestDb();
    seedTestData(db);
    const delta = prepareMutation(db, 'categorize_transaction', { id: 999999, category: 'X' });
    expect(delta.before).toBeNull();
    expect(delta.summary).toContain('not found');
  });

  test('categorize_transaction: commit applies the write and bumps revision', () => {
    const db = createTestDb();
    seedTestData(db);
    const id = firstTxnId(db);
    const result = commitMutation(db, 'categorize_transaction', { id, category: 'Shopping' }, 1);
    expect(result.outcome).toBe('committed');
    const row = db.prepare('SELECT category, revision FROM transactions WHERE id = @id').get({ id }) as any;
    expect(row.category).toBe('Shopping');
    expect(row.revision).toBe(2);
  });

  test('categorize_transaction: commit with a stale revision does not write', () => {
    const db = createTestDb();
    seedTestData(db);
    const id = firstTxnId(db);
    const result = commitMutation(db, 'categorize_transaction', { id, category: 'Shopping' }, 999);
    expect(result.outcome).toBe('stale');
    const row = db.prepare('SELECT category FROM transactions WHERE id = @id').get({ id }) as any;
    expect(row.category).not.toBe('Shopping');
  });

  test('edit_transaction: prepare throws PrepareError when no fields are given', () => {
    const db = createTestDb();
    seedTestData(db);
    const id = firstTxnId(db);
    expect(() => prepareMutation(db, 'edit_transaction', { id })).toThrow(PrepareError);
  });

  test('edit_transaction: prepare/commit round trip on notes', () => {
    const db = createTestDb();
    seedTestData(db);
    const id = firstTxnId(db);
    const prepared = prepareMutation(db, 'edit_transaction', { id, notes: 'reviewed' });
    expect(prepared.before).toEqual({ notes: null });
    const result = commitMutation(db, 'edit_transaction', { id, notes: 'reviewed' }, prepared.revision);
    expect(result.outcome).toBe('committed');
  });

  test('tax_flag: flag prepares and commits a new deduction', () => {
    const db = createTestDb();
    seedTestData(db);
    const id = firstTxnId(db);
    const prepared = prepareMutation(db, 'tax_flag', { action: 'flag', transactionId: id, irsCategory: 'Office Supplies', taxYear: 2026 });
    expect(prepared.before).toBeNull();
    expect(prepared.after).toMatchObject({ irs_category: 'Office Supplies' });

    const result = commitMutation(db, 'tax_flag', { action: 'flag', transactionId: id, irsCategory: 'Office Supplies', taxYear: 2026 }, prepared.revision);
    expect(result.outcome).toBe('committed');

    const row = db.prepare('SELECT irs_category FROM tax_deductions WHERE transaction_id = @id').get({ id }) as any;
    expect(row.irs_category).toBe('Office Supplies');
  });

  test('tax_flag: unflag removes an existing deduction', () => {
    const db = createTestDb();
    seedTestData(db);
    const id = firstTxnId(db);
    commitMutation(db, 'tax_flag', { action: 'flag', transactionId: id, irsCategory: 'Office Supplies', taxYear: 2026 }, 1);

    const prepared = prepareMutation(db, 'tax_flag', { action: 'unflag', transactionId: id });
    expect(prepared.before).toMatchObject({ irs_category: 'Office Supplies' });

    const result = commitMutation(db, 'tax_flag', { action: 'unflag', transactionId: id }, prepared.revision);
    expect(result.outcome).toBe('committed');
    const row = db.prepare('SELECT * FROM tax_deductions WHERE transaction_id = @id').get({ id });
    expect(row).toBeFalsy();
  });

  test('tax_flag: summary/list are not prepared — they execute as reads', async () => {
    const db = createTestDb();
    seedTestData(db);
    expect(() => prepareMutation(db, 'tax_flag', { action: 'summary' })).toThrow(PrepareError);
    const data = (await executeRead(db, 'tax_flag', { action: 'summary' })) as any;
    expect(data.taxYear).toBeGreaterThan(2000);
  });
});
