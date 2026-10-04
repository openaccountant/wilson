import { describe, expect, test, beforeEach, afterEach, spyOn } from 'bun:test';
import type { Database } from '../db/compat-sqlite.js';
import { initCategorizeTool, categorizeTool } from '../tools/categorize/categorize.js';
import { insertTransactions, addRule } from '../db/queries.js';
import { createTestDb } from './helpers.js';
import * as llmModule from '../model/llm.js';

describe('categorize tool progress', () => {
  let db: Database;
  let llmSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    db = createTestDb();
    initCategorizeTool(db);
    llmSpy = spyOn(llmModule, 'callLlm');
  });

  afterEach(() => {
    llmSpy.mockRestore();
  });

  test('reports rule matches, then each LLM batch, via onProgress', async () => {
    insertTransactions(db, [
      { date: '2026-02-15', description: 'AMAZON PURCHASE', amount: -50 },
      { date: '2026-02-16', description: 'MYSTERY ONE', amount: -5 },
      { date: '2026-02-17', description: 'MYSTERY TWO', amount: -6 },
    ]);
    addRule(db, '*AMAZON*', 'Shopping');
    llmSpy.mockImplementation(async () => ({ response: { structured: { transactions: [] } } }) as never);

    const seen: unknown[] = [];
    await categorizeTool.func({}, { onProgress: (p) => seen.push({ ...p }) });
    // One batch (50 on cloud models): after rules, then after the batch.
    expect(seen).toEqual([
      { done: 1, total: 3, batch: 0, batches: 1 },
      { done: 3, total: 3, batch: 1, batches: 1 },
    ]);
  });

  test('a failed batch still advances progress; no callback is fine', async () => {
    insertTransactions(db, [{ date: '2026-02-16', description: 'MYSTERY ONE', amount: -5 }]);
    llmSpy.mockImplementation(async () => { throw new Error('boom'); });
    const seen: unknown[] = [];
    await categorizeTool.func({}, { onProgress: (p) => seen.push({ ...p }) });
    expect(seen.at(-1)).toEqual({ done: 1, total: 1, batch: 1, batches: 1 });
    await categorizeTool.func({});
  });
});
