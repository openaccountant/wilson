import { describe, expect, test, beforeEach, afterEach, spyOn } from 'bun:test';
import type { Database } from '../db/compat-sqlite.js';
import { initCategorizeTool } from '../tools/categorize/categorize.js';
import { insertTransactions } from '../db/queries.js';
import { getCategorizeProgress, handleChatMessage } from '../dashboard/chat.js';
import { startDashboardServer, stopDashboardServer } from '../dashboard/server.js';
import { setInitialProfile, closeAll } from '../dashboard/db-manager.js';
import * as llmModule from '../model/llm.js';
import { createTestDb } from './helpers.js';
import {
  categorizeProgressLabel,
  isCategorizeQuery,
} from '../dashboard/ui/src/lib/categorizeProgress';

describe('dashboard /categorize progress', () => {
  let db: Database;
  let llmSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    db = createTestDb();
    initCategorizeTool(db);
    llmSpy = spyOn(llmModule, 'callLlm');
  });
  afterEach(() => llmSpy.mockRestore());

  test('is null outside a run, live during it, and cleared when it settles', async () => {
    insertTransactions(db, [{ date: '2026-02-16', description: 'MYSTERY ONE', amount: -5 }]);
    expect(getCategorizeProgress()).toBeNull();
    let during = null as ReturnType<typeof getCategorizeProgress>;
    llmSpy.mockImplementation(async () => {
      during = getCategorizeProgress();
      return { response: { structured: { transactions: [] } } } as never;
    });
    await handleChatMessage('/categorize');
    expect(during).toEqual({ done: 0, total: 1, batch: 0, batches: 1 });
    expect(getCategorizeProgress()).toBeNull();
  });

  test('cleared when the run fails', async () => {
    insertTransactions(db, [{ date: '2026-02-16', description: 'MYSTERY ONE', amount: -5 }]);
    llmSpy.mockImplementation(async () => { throw new Error('boom'); });
    await handleChatMessage('/categorize');
    expect(getCategorizeProgress()).toBeNull();
  });
});

describe('GET /api/chat/progress', () => {
  let server: Awaited<ReturnType<typeof startDashboardServer>>['server'] | null = null;
  afterEach(() => {
    if (server) stopDashboardServer(server);
    server = null;
    closeAll();
  });

  test('answers { progress: null } when no /categorize run is active', async () => {
    const db = createTestDb();
    setInitialProfile('test', db);
    server = (await startDashboardServer(db, 0)).server;
    const res = await fetch(`http://localhost:${server.port}/api/chat/progress`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ progress: null });
  });
});

describe('categorize progress UI helpers', () => {
  test('label shows rows and batches', () => {
    expect(categorizeProgressLabel({ done: 20, total: 50, batch: 2, batches: 5 }))
      .toBe('Categorizing… 20 of 50 (2 of 5 batches)');
    expect(categorizeProgressLabel({ done: 0, total: 5, batch: 0, batches: 1 }))
      .toBe('Categorizing… 0 of 5 (0 of 1 batch)');
  });
  test('label is generic before the first report or on junk', () => {
    expect(categorizeProgressLabel(null)).toBe('Categorizing…');
    expect(categorizeProgressLabel(undefined)).toBe('Categorizing…');
    expect(categorizeProgressLabel({ done: 1, total: 0, batch: 0, batches: 0 })).toBe('Categorizing…');
  });
  test('only /categorize commands qualify', () => {
    expect(isCategorizeQuery('/categorize')).toBe(true);
    expect(isCategorizeQuery('  /Categorize 50 ')).toBe(true);
    expect(isCategorizeQuery('/categorizer')).toBe(false);
    expect(isCategorizeQuery('categorize my stuff')).toBe(false);
  });
});
