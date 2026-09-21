import { describe, expect, test, beforeEach, afterEach, spyOn } from 'bun:test';
import type { Database } from '../db/compat-sqlite.js';
import { initEntityClassifyTool, entityClassifyTool } from '../tools/entity/entity-classify.js';
import { insertTransactions, getTransactions } from '../db/queries.js';
import { createEntity } from '../db/entity-queries.js';
import { createTestDb, ensureTestProfile } from './helpers.js';
import * as llmModule from '../model/llm.js';
import { LlmValidationError } from '../model/structured-output.js';
import { setTaskOverride } from '../model/task-models.js';
import { setSetting, saveConfig, getConfiguredModel } from '../utils/config.js';

describe('entity_classify tool', () => {
  let db: Database;
  let llmSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    db = createTestDb();
    initEntityClassifyTool(db);
    // Mock callLlm to prevent actual LLM calls
    llmSpy = spyOn(llmModule, 'callLlm');
  });

  afterEach(() => {
    llmSpy.mockRestore();
  });

  test('requires at least two entities', async () => {
    // Migrations seed exactly one default 'Personal' entity
    const raw = await entityClassifyTool.func({});
    const result = JSON.parse(raw as string);
    expect(result.data.error).toContain('At least 2 entities');
    expect(llmSpy).not.toHaveBeenCalled();
  });

  test('valid structured output assigns the entity to the transaction', async () => {
    const business = createEntity(db, { name: 'Consulting LLC' }); // second entity besides seeded 'Personal'
    insertTransactions(db, [
      { date: '2026-02-15', description: 'Office supplies', amount: -40 },
    ]);
    initEntityClassifyTool(db);

    const txn = getTransactions(db)[0];
    llmSpy.mockResolvedValue({
      response: {
        content: '',
        structured: {
          transactions: [{ id: txn.id, entityId: business, confidence: 0.95, reasoning: 'office supplies' }],
        },
      },
      metadata: {},
    });

    const raw = await entityClassifyTool.func({});
    const result = JSON.parse(raw as string);
    expect(result.data.success).toBe(true);
    expect(result.data.classified).toBe(1);
    expect(getTransactions(db)[0].entity_id).toBe(business);
    // The call is tagged with its own call type so the Training per-task view
    // groups it under 'entity-classification' instead of the generic 'standalone'.
    expect(llmSpy.mock.calls.some((call: unknown[]) => (call[1] as { callType?: string })?.callType === 'entity-classification')).toBe(true);
  });

  test('low-confidence classifications land in reviewItems, not the database', async () => {
    const business = createEntity(db, { name: 'Consulting LLC' });
    insertTransactions(db, [
      { date: '2026-02-15', description: 'Ambiguous expense', amount: -20 },
    ]);
    initEntityClassifyTool(db);

    const txn = getTransactions(db)[0];
    llmSpy.mockResolvedValue({
      response: {
        content: '',
        structured: {
          transactions: [{ id: txn.id, entityId: business, confidence: 0.4, reasoning: 'unclear' }],
        },
      },
      metadata: {},
    });

    const raw = await entityClassifyTool.func({});
    const result = JSON.parse(raw as string);
    expect(result.data.classified).toBe(0);
    expect(result.data.reviewItems).toHaveLength(1);
    expect(getTransactions(db)[0].entity_id).toBeNull();
  });

  test('schema-rejected structured output reports the batch in errors and assigns nothing', async () => {
    createEntity(db, { name: 'Consulting LLC' }); // second entity besides seeded 'Personal'
    insertTransactions(db, [
      { date: '2026-02-15', description: 'Mystery expense', amount: -20 },
    ]);
    initEntityClassifyTool(db);

    llmSpy.mockRejectedValue(
      new LlmValidationError(
        'LLM structured output failed schema validation after one repair attempt: transactions.0.confidence: Invalid input: expected number, received string',
        ['transactions.0.confidence: Invalid input: expected number, received string'],
        { content: '{"transactions":[{"id":1,"entityId":2,"confidence":"high"}]}', toolCalls: [] },
      ),
    );

    const raw = await entityClassifyTool.func({});
    const result = JSON.parse(raw as string);

    // The rejected batch is reported through the existing errors channel…
    expect(result.data.errors).toBeDefined();
    expect(result.data.errors[0]).toContain('failed schema validation');
    expect(result.data.classified).toBe(0);

    // …and nothing is assigned: no entity_id, no review item derived from the invalid batch.
    expect(result.data.reviewItems).toBeUndefined();
    const txns = getTransactions(db);
    expect(txns).toHaveLength(1);
    expect(txns[0].entity_id).toBeNull();
  });

  test('LLM model resolves the per-task pin at call time; reset restores the chat model', async () => {
    ensureTestProfile();
    saveConfig({});
    setSetting('modelId', 'gpt-5.2');
    setSetting('provider', 'openai');
    try {
      const business = createEntity(db, { name: 'Consulting LLC' }); // second entity besides seeded 'Personal'
      insertTransactions(db, [
        { date: '2026-02-15', description: 'Office supplies', amount: -40 },
      ]);
      initEntityClassifyTool(db);
      const txn = getTransactions(db)[0];
      llmSpy.mockResolvedValue({
        response: {
          content: '',
          structured: {
            transactions: [{ id: txn.id, entityId: business, confidence: 0.95, reasoning: 'office supplies' }],
          },
        },
        metadata: {},
      });

      // Pin a different model to the task, run it: the very next call uses the pin.
      setTaskOverride('entity-classification', 'ollama:qwen3:0.6b');
      await entityClassifyTool.func({});
      let calls = llmSpy.mock.calls.filter(
        (call: unknown[]) => (call[1] as { callType?: string })?.callType === 'entity-classification',
      );
      expect(calls).toHaveLength(1);
      expect((calls[0][1] as { model?: string }).model).toBe('ollama:qwen3:0.6b');

      // Reset: the next run follows the chat model again (fresh unassigned txn
      // so the LLM path actually runs).
      setTaskOverride('entity-classification', null);
      insertTransactions(db, [
        { date: '2026-02-16', description: 'Second office expense', amount: -25 },
      ]);
      initEntityClassifyTool(db);
      const txns2 = getTransactions(db).filter((t) => t.entity_id === null);
      llmSpy.mockResolvedValue({
        response: {
          content: '',
          structured: {
            transactions: [{ id: txns2[0].id, entityId: business, confidence: 0.95, reasoning: 'office supplies' }],
          },
        },
        metadata: {},
      });
      await entityClassifyTool.func({});
      calls = llmSpy.mock.calls.filter(
        (call: unknown[]) => (call[1] as { callType?: string })?.callType === 'entity-classification',
      );
      expect(calls).toHaveLength(2);
      expect((calls[1][1] as { model?: string }).model).toBe(getConfiguredModel().model);
      expect((calls[1][1] as { model?: string }).model).toBe('gpt-5.2');
    } finally {
      saveConfig({});
    }
  });
});