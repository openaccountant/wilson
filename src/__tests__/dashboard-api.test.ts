import { describe, expect, test, beforeEach } from 'bun:test';
import { createTestDb, seedTestData } from './helpers.js';
import {
  apiTransactions,
  apiExportCsv,
  apiChatSessions,
  apiChatSessionHistory,
  apiUpdateTransaction,
  apiDeleteTransaction,
  apiTraces,
  apiTraceStats,
} from '../dashboard/api.js';
import { createChatSession, insertChatMessage } from '../db/queries.js';
import { traceStore } from '../utils/trace-store.js';

describe('apiTransactions', () => {
  test('returns transactions with filters', () => {
    const db = createTestDb();
    seedTestData(db);
    const params = new URLSearchParams({ category: 'Groceries' });
    const txns = apiTransactions(db, params);
    expect(txns.length).toBeGreaterThan(0);
    for (const t of txns) {
      expect(t.category).toBe('Groceries');
    }
  });

  test('respects limit parameter', () => {
    const db = createTestDb();
    seedTestData(db);
    const params = new URLSearchParams({ limit: '2' });
    const txns = apiTransactions(db, params);
    expect(txns.length).toBeLessThanOrEqual(2);
  });
});

describe('apiExportCsv', () => {
  test('returns CSV string with header row', () => {
    const db = createTestDb();
    seedTestData(db);
    const csv = apiExportCsv(db, new URLSearchParams());
    const lines = csv.split('\n');
    expect(lines[0]).toBe('Date,Description,Amount,Category');
    expect(lines.length).toBeGreaterThan(1);
  });

  test('escapes commas and quotes in descriptions', () => {
    const db = createTestDb();
    // Insert a transaction with commas and quotes
    db.prepare(`
      INSERT INTO transactions (date, description, amount, category)
      VALUES ('2026-03-01', 'Foo, "Bar" & Baz', -10.00, 'Other')
    `).run();
    const csv = apiExportCsv(db, new URLSearchParams());
    // The description should be quoted and internal quotes doubled
    expect(csv).toContain('"Foo, ""Bar"" & Baz"');
  });

  test('filters by date range', () => {
    const db = createTestDb();
    seedTestData(db);
    const params = new URLSearchParams({ start: '2026-02-01', end: '2026-02-28' });
    const csv = apiExportCsv(db, params);
    const lines = csv.split('\n').slice(1); // skip header
    for (const line of lines) {
      const date = line.split(',')[0];
      expect(date >= '2026-02-01').toBe(true);
      expect(date <= '2026-02-28').toBe(true);
    }
  });

  test('returns header-only for empty DB', () => {
    const db = createTestDb();
    const csv = apiExportCsv(db, new URLSearchParams());
    expect(csv).toBe('Date,Description,Amount,Category');
  });
});

describe('apiChatSessions', () => {
  test('returns sessions array', () => {
    const db = createTestDb();
    createChatSession(db);
    createChatSession(db);
    const sessions = apiChatSessions(db);
    expect(Array.isArray(sessions)).toBe(true);
    expect(sessions.length).toBe(2);
  });

  test('returns empty array on error', () => {
    // Pass a broken DB-like object to trigger the catch
    const sessions = apiChatSessions({ prepare: () => { throw new Error('broken'); } } as any);
    expect(sessions).toEqual([]);
  });
});

describe('apiChatSessionHistory', () => {
  test('returns messages for given session', () => {
    const db = createTestDb();
    const sessionId = createChatSession(db);
    insertChatMessage(db, 'q1', 'a1', null, sessionId);
    insertChatMessage(db, 'q2', 'a2', null, sessionId);
    const history = apiChatSessionHistory(db, sessionId);
    expect(history).toHaveLength(2);
    expect(history[0].query).toBe('q1');
    expect(history[1].query).toBe('q2');
  });
});

describe('apiUpdateTransaction', () => {
  test('updates fields and returns success', () => {
    const db = createTestDb();
    seedTestData(db);
    // Get first transaction ID
    const rows = db.prepare('SELECT id FROM transactions LIMIT 1').all() as { id: number }[];
    const id = rows[0].id;
    const result = apiUpdateTransaction(db, id, { category: 'Updated Category' });
    expect(result.success).toBe(true);
    expect(result.id).toBe(id);
    // Verify the update persisted
    const row = db.prepare('SELECT category FROM transactions WHERE id = @id').get({ id }) as { category: string };
    expect(row.category).toBe('Updated Category');
  });
});

describe('apiDeleteTransaction', () => {
  test('deletes transaction and returns success', () => {
    const db = createTestDb();
    seedTestData(db);
    const rows = db.prepare('SELECT id FROM transactions LIMIT 1').all() as { id: number }[];
    const id = rows[0].id;
    const result = apiDeleteTransaction(db, id);
    expect(result.success).toBe(true);
    expect(result.id).toBe(id);
    // Verify deletion
    const row = db.prepare('SELECT id FROM transactions WHERE id = @id').get({ id });
    expect(row).toBeFalsy();
  });
});

describe('apiTraces', () => {
  beforeEach(() => {
    traceStore.clear();
  });

  test('returns empty array with no traces', () => {
    const db = createTestDb();
    const traces = apiTraces(db, new URLSearchParams());
    expect(traces).toEqual([]);
  });

  test('returns recorded traces', () => {
    const db = createTestDb();
    traceStore.record({
      id: 'test-1', timestamp: new Date().toISOString(),
      model: 'gpt-5.2', provider: 'openai',
      promptLength: 100, responseLength: 50,
      inputTokens: 50, outputTokens: 25, totalTokens: 75,
      durationMs: 800, status: 'ok',
    });
    const traces = apiTraces(db, new URLSearchParams());
    expect(traces).toHaveLength(1);
    expect(traces[0].model).toBe('gpt-5.2');
  });

  test('respects limit parameter', () => {
    const db = createTestDb();
    for (let i = 0; i < 5; i++) {
      traceStore.record({
        id: `test-${i}`, timestamp: new Date().toISOString(),
        model: 'gpt-5.2', provider: 'openai',
        promptLength: 100, responseLength: 50,
        inputTokens: 50, outputTokens: 25, totalTokens: 75,
        durationMs: 800, status: 'ok',
      });
    }
    const traces = apiTraces(db, new URLSearchParams({ limit: '2' }));
    expect(traces).toHaveLength(2);
  });
});

describe('apiTraceStats', () => {
  beforeEach(() => {
    traceStore.clear();
  });

  test('returns stats object', () => {
    const db = createTestDb();
    traceStore.record({
      id: 'test-1', timestamp: new Date().toISOString(),
      model: 'gpt-5.2', provider: 'openai',
      promptLength: 100, responseLength: 50,
      inputTokens: 50, outputTokens: 25, totalTokens: 75,
      durationMs: 800, status: 'ok',
    });
    const stats = apiTraceStats(db);
    expect(stats.totalCalls).toBe(1);
    expect(stats.successfulCalls).toBe(1);
    expect(stats.totalTokens).toBe(75);
  });
});
