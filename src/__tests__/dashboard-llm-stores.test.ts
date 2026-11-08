import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { attachLlmStores } from '../dashboard/llm-stores.js';
import { interactionStore } from '../utils/interaction-store.js';
import { traceStore } from '../utils/trace-store.js';
import { createTestDb } from './helpers.js';
import type { Database } from '../db/compat-sqlite.js';

/**
 * `wilson --dashboard` attached only the trace store, so Chat answered but never wrote `llm_interactions`: the LLM
 * tab's Traces, Training and the judge stayed empty.
 */

const count = (db: Database, table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

function recordOneCall(tag: string) {
  traceStore.record({
    id: `t-${tag}`, timestamp: new Date().toISOString(), model: 'granite4.1:3b', provider: 'ollama',
    promptLength: 10, responseLength: 5, inputTokens: 10, outputTokens: 5, totalTokens: 15, durationMs: 100, status: 'ok',
  });
  return interactionStore.recordInteraction({
    runId: `run-${tag}`, sequenceNum: 1, callType: 'agent', model: 'granite4.1:3b', provider: 'ollama',
    systemPrompt: 'sys', userPrompt: 'How much did I spend on dining?', responseContent: 'About $217.',
    toolCalls: [], toolDefs: [], usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, durationMs: 100, status: 'ok',
  });
}

describe('dashboard LLM stores', () => {
  test('attachLlmStores records both the trace and the full interaction', () => {
    const db = createTestDb();
    attachLlmStores(db);
    expect(recordOneCall('one')).toBeGreaterThan(0);
    expect(count(db, 'llm_traces')).toBe(1);
    expect(count(db, 'llm_interactions')).toBe(1);
  });

  test('re-attaching moves both stores to the new DB', () => {
    const first = createTestDb();
    const second = createTestDb();
    attachLlmStores(first);
    recordOneCall('first');
    attachLlmStores(second);
    recordOneCall('second');
    expect(count(first, 'llm_interactions')).toBe(1);
    expect(count(second, 'llm_interactions')).toBe(1);
    expect(count(second, 'llm_traces')).toBe(1);
  });

  // The standalone server must go through the helper (the wiring that was missing). A profile switch must NOT re-point
  // the process-wide stores: an in-flight run or an embedded TUI would then record into the other profile.
  test('the standalone dashboard attaches both stores; a profile switch does not re-point them', () => {
    const dir = join(import.meta.dir, '..', 'dashboard');
    const standalone = readFileSync(join(dir, 'standalone.ts'), 'utf8');
    const dbManager = readFileSync(join(dir, 'db-manager.ts'), 'utf8');
    expect(standalone).toContain('attachLlmStores(db)');
    expect(standalone).not.toContain('traceStore.setDatabase');
    expect(dbManager).not.toContain('attachLlmStores');
    expect(dbManager).not.toMatch(/(traceStore|interactionStore)\.setDatabase/);
  });

  test('training data routes are listed for the admin-only gate', async () => {
    const { isTrainingDataPath } = await import('../dashboard/server.js');
    for (const p of ['/api/interactions', '/api/interactions/7', '/api/interactions/7/annotate', '/api/judgements', '/api/judgements/3/accept', '/api/annotations/stats', '/api/export/training/sft', '/api/export/training/dpo', '/api/export/training/stats']) {
      expect(isTrainingDataPath(p)).toBe(true);
    }
    for (const p of ['/api/transactions', '/api/chat', '/api/interactionsx']) expect(isTrainingDataPath(p)).toBe(false);
  });
});
