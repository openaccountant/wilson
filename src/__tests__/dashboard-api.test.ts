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
  apiSummary,
  apiPnl,
  apiBudgets,
  apiSavings,
  apiAccounts,
  apiNetWorth,
  apiNetWorthTrend,
  apiAccountTransactions,
  apiExportPnlCsv,
  apiExportNetWorthCsv,
  apiAlerts,
  apiLogs,
  apiChatHistory,
  apiInteractions,
  apiInteractionDetail,
  apiRunInteractions,
  apiAnnotateInteraction,
  apiAnnotationStats,
  apiExportXlsx,
} from '../dashboard/api.js';
import { createChatSession, insertChatMessage, insertTransactions } from '../db/queries.js';
import { insertAccount } from '../db/net-worth-queries.js';
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

// ── accountId filtering on existing API functions ────────────────────────

describe('accountId filtering', () => {
  test('apiTransactions filters by accountId', () => {
    const db = createTestDb();
    const accountId = insertAccount(db, {
      name: 'Test', account_type: 'asset', account_subtype: 'checking',
    });
    insertTransactions(db, [
      { date: '2026-01-01', description: 'Linked', amount: -50 },
      { date: '2026-01-02', description: 'Unlinked', amount: -30 },
    ]);
    db.prepare('UPDATE transactions SET account_id = @accountId WHERE description = @desc')
      .run({ accountId, desc: 'Linked' });

    const filtered = apiTransactions(db, new URLSearchParams({ accountId: String(accountId) }));
    expect(filtered).toHaveLength(1);
    expect(filtered[0].description).toBe('Linked');
  });

  test('apiSummary filters by accountId', () => {
    const db = createTestDb();
    const accountId = insertAccount(db, {
      name: 'Test', account_type: 'asset', account_subtype: 'checking',
    });
    insertTransactions(db, [
      { date: '2026-02-15', description: 'Scoped', amount: -100, category: 'Food' },
      { date: '2026-02-16', description: 'Unscoped', amount: -200, category: 'Food' },
    ]);
    db.prepare('UPDATE transactions SET account_id = @accountId WHERE description = @desc')
      .run({ accountId, desc: 'Scoped' });

    const all = apiSummary(db, new URLSearchParams({ month: '2026-02' }));
    const scoped = apiSummary(db, new URLSearchParams({ month: '2026-02', accountId: String(accountId) }));

    const allTotal = (all as any[]).reduce((s: number, r: any) => s + r.total, 0);
    const scopedTotal = (scoped as any[]).reduce((s: number, r: any) => s + r.total, 0);
    expect(allTotal).toBe(-300);
    expect(scopedTotal).toBe(-100);
  });

  test('apiPnl filters by accountId', () => {
    const db = createTestDb();
    const accountId = insertAccount(db, {
      name: 'Test', account_type: 'asset', account_subtype: 'checking',
    });
    insertTransactions(db, [
      { date: '2026-02-15', description: 'Scoped Income', amount: 1000, category: 'Salary' },
      { date: '2026-02-16', description: 'Unscoped Income', amount: 2000, category: 'Salary' },
    ]);
    db.prepare('UPDATE transactions SET account_id = @accountId WHERE description = @desc')
      .run({ accountId, desc: 'Scoped Income' });

    const scoped = apiPnl(db, new URLSearchParams({ month: '2026-02', accountId: String(accountId) }));
    expect((scoped as any).totalIncome).toBe(1000);
  });
});

// ── Accounts / Net Worth API ─────────────────────────────────────────────

describe('apiAccounts', () => {
  test('returns active accounts only', () => {
    const db = createTestDb();
    insertAccount(db, { name: 'Active', account_type: 'asset', account_subtype: 'checking' });
    const inactiveId = insertAccount(db, { name: 'Inactive', account_type: 'asset', account_subtype: 'savings' });
    db.prepare('UPDATE accounts SET is_active = 0 WHERE id = @id').run({ id: inactiveId });

    const result = apiAccounts(db);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Active');
  });
});

describe('apiNetWorth', () => {
  test('returns assets, liabilities, and net worth', () => {
    const db = createTestDb();
    insertAccount(db, { name: 'Checking', account_type: 'asset', account_subtype: 'checking', current_balance: 10000 });
    insertAccount(db, { name: 'Loan', account_type: 'liability', account_subtype: 'personal_loan', current_balance: 3000 });

    const nw = apiNetWorth(db);
    expect(nw.totalAssets).toBe(10000);
    expect(nw.totalLiabilities).toBe(3000);
    expect(nw.netWorth).toBe(7000);
  });
});

describe('apiNetWorthTrend', () => {
  test('returns array with months parameter', () => {
    const db = createTestDb();
    const trend = apiNetWorthTrend(db, new URLSearchParams({ months: '3' }));
    expect(Array.isArray(trend)).toBe(true);
  });
});

describe('apiAccountTransactions', () => {
  test('returns transactions for a specific account', () => {
    const db = createTestDb();
    const accountId = insertAccount(db, { name: 'Card', account_type: 'liability', account_subtype: 'credit_card' });
    insertTransactions(db, [
      { date: '2026-01-01', description: 'Mine', amount: -50 },
      { date: '2026-01-02', description: 'Not Mine', amount: -30 },
    ]);
    db.prepare('UPDATE transactions SET account_id = @accountId WHERE description = @desc')
      .run({ accountId, desc: 'Mine' });

    const result = apiAccountTransactions(db, accountId, new URLSearchParams());
    expect(result).toHaveLength(1);
    expect(result[0].description).toBe('Mine');
  });

  test('respects date filters', () => {
    const db = createTestDb();
    const accountId = insertAccount(db, { name: 'Card', account_type: 'liability', account_subtype: 'credit_card' });
    insertTransactions(db, [
      { date: '2026-01-15', description: 'Jan', amount: -50 },
      { date: '2026-02-15', description: 'Feb', amount: -30 },
    ]);
    db.prepare('UPDATE transactions SET account_id = @accountId').run({ accountId });

    const result = apiAccountTransactions(db, accountId, new URLSearchParams({ start: '2026-02-01', end: '2026-02-28' }));
    expect(result).toHaveLength(1);
    expect(result[0].description).toBe('Feb');
  });
});

// ── Export APIs ──────────────────────────────────────────────────────────

describe('apiExportPnlCsv', () => {
  test('returns CSV with P&L data', () => {
    const db = createTestDb();
    insertTransactions(db, [
      { date: '2026-02-15', description: 'Salary', amount: 5000, category: 'Income' },
      { date: '2026-02-16', description: 'Groceries', amount: -200, category: 'Food' },
    ]);

    const csv = apiExportPnlCsv(db, new URLSearchParams({ month: '2026-02' }));
    expect(csv).toContain('Type,Category,Amount,Count');
    expect(csv).toContain('Income');
    expect(csv).toContain('Expense');
    expect(csv).toContain('Total Income');
    expect(csv).toContain('Total Expenses');
    expect(csv).toContain('Net P&L');
  });

  test('filters by accountId', () => {
    const db = createTestDb();
    const accountId = insertAccount(db, { name: 'Test', account_type: 'asset', account_subtype: 'checking' });
    insertTransactions(db, [
      { date: '2026-02-15', description: 'Scoped', amount: -100, category: 'Food' },
      { date: '2026-02-16', description: 'Unscoped', amount: -200, category: 'Food' },
    ]);
    db.prepare('UPDATE transactions SET account_id = @accountId WHERE description = @desc')
      .run({ accountId, desc: 'Scoped' });

    const all = apiExportPnlCsv(db, new URLSearchParams({ month: '2026-02' }));
    const scoped = apiExportPnlCsv(db, new URLSearchParams({ month: '2026-02', accountId: String(accountId) }));

    // Scoped should have less expenses
    expect(all).toContain('-300');
    expect(scoped).toContain('-100');
    expect(scoped).not.toContain('-300');
  });
});

describe('apiExportNetWorthCsv', () => {
  test('returns CSV with account data', () => {
    const db = createTestDb();
    insertAccount(db, { name: 'Savings', account_type: 'asset', account_subtype: 'savings', current_balance: 25000 });

    const csv = apiExportNetWorthCsv(db);
    expect(csv).toContain('Name,Type,Subtype,Institution,Balance');
    expect(csv).toContain('Savings');
    expect(csv).toContain('25000');
    expect(csv).toContain('Total Assets');
    expect(csv).toContain('Net Worth');
  });
});

describe('apiExportCsv with accountId', () => {
  test('filters exported CSV by accountId', () => {
    const db = createTestDb();
    const accountId = insertAccount(db, { name: 'Filter', account_type: 'asset', account_subtype: 'checking' });
    insertTransactions(db, [
      { date: '2026-01-01', description: 'Included', amount: -50, category: 'A' },
      { date: '2026-01-02', description: 'Excluded', amount: -30, category: 'B' },
    ]);
    db.prepare('UPDATE transactions SET account_id = @accountId WHERE description = @desc')
      .run({ accountId, desc: 'Included' });

    const csv = apiExportCsv(db, new URLSearchParams({ accountId: String(accountId) }));
    expect(csv).toContain('Included');
    expect(csv).not.toContain('Excluded');
  });
});

// ── Additional API coverage (Wave 2) ─────────────────────────────────────────

describe('apiAlerts', () => {
  test('returns empty array when no budgets', () => {
    const db = createTestDb();
    const alerts = apiAlerts(db);
    expect(Array.isArray(alerts)).toBe(true);
    expect(alerts).toHaveLength(0);
  });

  test('returns alerts when budget exceeded', () => {
    const db = createTestDb();
    seedTestData(db);
    // Set Groceries budget very low to trigger exceeded
    db.prepare("UPDATE budgets SET monthly_limit = 10 WHERE category = 'Groceries'").run();
    const alerts = apiAlerts(db);
    const exceeded = alerts.find((a: { type: string }) => a.type === 'budget_exceeded');
    expect(exceeded).toBeDefined();
  });
});

describe('apiBudgets', () => {
  test('returns budget vs actual data', () => {
    const db = createTestDb();
    seedTestData(db);
    const result = apiBudgets(db, new URLSearchParams({ month: '2026-02' }));
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);
  });

  test('returns empty for no budgets', () => {
    const db = createTestDb();
    const result = apiBudgets(db, new URLSearchParams({ month: '2026-02' }));
    expect(result).toHaveLength(0);
  });
});

describe('apiSavings', () => {
  test('returns monthly savings data', () => {
    const db = createTestDb();
    seedTestData(db);
    const result = apiSavings(db, new URLSearchParams({ months: '6' }));
    expect(Array.isArray(result)).toBe(true);
  });
});

describe('apiLogs', () => {
  test('returns empty array from fresh db', () => {
    const db = createTestDb();
    const logs = apiLogs(db, new URLSearchParams());
    expect(Array.isArray(logs)).toBe(true);
  });

  test('returns logs from db when present', () => {
    const db = createTestDb();
    db.prepare("INSERT INTO logs (level, message, data) VALUES ('info', 'test log', '{\"key\":\"val\"}')").run();
    db.prepare("INSERT INTO logs (level, message, data) VALUES ('error', 'bad thing', null)").run();
    const logs = apiLogs(db, new URLSearchParams());
    expect(logs).toHaveLength(2);
  });

  test('filters by level', () => {
    const db = createTestDb();
    db.prepare("INSERT INTO logs (level, message) VALUES ('info', 'info msg')").run();
    db.prepare("INSERT INTO logs (level, message) VALUES ('error', 'error msg')").run();
    const logs = apiLogs(db, new URLSearchParams({ level: 'error' }));
    expect(logs).toHaveLength(1);
    expect((logs[0] as { level: string }).level).toBe('error');
  });

  test('respects limit', () => {
    const db = createTestDb();
    for (let i = 0; i < 10; i++) {
      db.prepare("INSERT INTO logs (level, message) VALUES (@level, @message)").run({ level: 'info', message: `msg-${i}` });
    }
    const logs = apiLogs(db, new URLSearchParams({ limit: '3' }));
    expect(logs).toHaveLength(3);
  });
});

describe('apiChatHistory', () => {
  test('returns empty array from fresh db', () => {
    const db = createTestDb();
    const history = apiChatHistory(db);
    expect(Array.isArray(history)).toBe(true);
    expect(history).toHaveLength(0);
  });
});

describe('apiInteractions', () => {
  test('returns empty array from fresh db', () => {
    const db = createTestDb();
    const result = apiInteractions(db, new URLSearchParams());
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(0);
  });

  test('returns interactions with filters', () => {
    const db = createTestDb();
    db.prepare(`
      INSERT INTO llm_interactions (run_id, sequence_num, call_type, model, provider, user_prompt, status)
      VALUES ('r1', 1, 'agent', 'gpt-4', 'openai', 'Q1', 'ok')
    `).run();
    db.prepare(`
      INSERT INTO llm_interactions (run_id, sequence_num, call_type, model, provider, user_prompt, status)
      VALUES ('r2', 1, 'classify', 'claude-3', 'anthropic', 'Q2', 'ok')
    `).run();

    const agentOnly = apiInteractions(db, new URLSearchParams({ callType: 'agent' }));
    expect(agentOnly).toHaveLength(1);

    const claudeOnly = apiInteractions(db, new URLSearchParams({ model: 'claude-3' }));
    expect(claudeOnly).toHaveLength(1);
  });
});

describe('apiInteractionDetail', () => {
  test('returns null for non-existent ID', () => {
    const db = createTestDb();
    const result = apiInteractionDetail(db, 99999);
    expect(result).toBeNull();
  });

  test('returns full detail for existing interaction', () => {
    const db = createTestDb();
    const res = db.prepare(`
      INSERT INTO llm_interactions (run_id, sequence_num, call_type, model, provider, user_prompt, response_content, status)
      VALUES ('r1', 1, 'agent', 'gpt-4', 'openai', 'Hello', 'World', 'ok')
    `).run();
    const id = (res as { lastInsertRowid: number }).lastInsertRowid as number;

    const detail = apiInteractionDetail(db, id);
    expect(detail).not.toBeNull();
    expect((detail as any).user_prompt).toBe('Hello');
    expect((detail as any).toolResults).toHaveLength(0);
    expect((detail as any).annotations).toHaveLength(0);
  });
});

describe('apiAnnotateInteraction', () => {
  test('annotates an interaction successfully', () => {
    const db = createTestDb();
    const res = db.prepare(`
      INSERT INTO llm_interactions (run_id, sequence_num, call_type, model, provider, user_prompt, status)
      VALUES ('r1', 1, 'agent', 'gpt-4', 'openai', 'Q', 'ok')
    `).run();
    const id = (res as { lastInsertRowid: number }).lastInsertRowid as number;

    const result = apiAnnotateInteraction(db, id, { rating: 5, notes: 'Great answer' });
    expect(result.success).toBe(true);

    // Verify annotation persisted
    const ann = db.prepare('SELECT rating, notes FROM interaction_annotations WHERE interaction_id = @id').get({ id }) as any;
    expect(ann.rating).toBe(5);
    expect(ann.notes).toBe('Great answer');
  });

  test('upserts annotation (replaces existing)', () => {
    const db = createTestDb();
    const res = db.prepare(`
      INSERT INTO llm_interactions (run_id, sequence_num, call_type, model, provider, user_prompt, status)
      VALUES ('r1', 1, 'agent', 'gpt-4', 'openai', 'Q', 'ok')
    `).run();
    const id = (res as { lastInsertRowid: number }).lastInsertRowid as number;

    apiAnnotateInteraction(db, id, { rating: 3 });
    apiAnnotateInteraction(db, id, { rating: 5 });

    const count = (db.prepare('SELECT COUNT(*) AS c FROM interaction_annotations WHERE interaction_id = @id').get({ id }) as { c: number }).c;
    expect(count).toBe(1);
    const ann = db.prepare('SELECT rating FROM interaction_annotations WHERE interaction_id = @id').get({ id }) as { rating: number };
    expect(ann.rating).toBe(5);
  });
});

describe('apiAnnotationStats', () => {
  test('returns all zeros from fresh db', () => {
    const db = createTestDb();
    const stats = apiAnnotationStats(db);
    expect(stats.total).toBe(0);
    expect(stats.annotated).toBe(0);
    expect(stats.sftReady).toBe(0);
    expect(stats.dpoPairs).toBe(0);
  });
});

describe('apiRunInteractions', () => {
  test('returns interactions for a specific run', () => {
    const db = createTestDb();
    db.prepare(`
      INSERT INTO llm_interactions (run_id, sequence_num, call_type, model, provider, user_prompt, status)
      VALUES ('target-run', 1, 'agent', 'gpt-4', 'openai', 'Q1', 'ok')
    `).run();
    db.prepare(`
      INSERT INTO llm_interactions (run_id, sequence_num, call_type, model, provider, user_prompt, status)
      VALUES ('other-run', 1, 'agent', 'gpt-4', 'openai', 'Q2', 'ok')
    `).run();

    const result = apiRunInteractions(db, 'target-run');
    expect(result).toHaveLength(1);
  });

  test('returns empty for non-existent run', () => {
    const db = createTestDb();
    const result = apiRunInteractions(db, 'no-such-run');
    expect(result).toHaveLength(0);
  });
});

describe('apiExportXlsx', () => {
  test('returns buffer with data', () => {
    const db = createTestDb();
    seedTestData(db);
    const buf = apiExportXlsx(db, new URLSearchParams());
    expect(buf).toBeDefined();
    expect(buf.length).toBeGreaterThan(0);
  });
});
