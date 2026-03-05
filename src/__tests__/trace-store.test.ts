import { describe, expect, test, beforeEach } from 'bun:test';
import { traceStore, type LlmTrace } from '../utils/trace-store.js';
import { createTestDb } from './helpers.js';

function makeTrace(overrides: Partial<LlmTrace> = {}): LlmTrace {
  return {
    id: `test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    timestamp: new Date().toISOString(),
    model: 'gpt-5.2',
    provider: 'openai',
    promptLength: 500,
    responseLength: 200,
    inputTokens: 100,
    outputTokens: 50,
    totalTokens: 150,
    durationMs: 1200,
    status: 'ok',
    ...overrides,
  };
}

describe('TraceStore', () => {
  beforeEach(() => {
    traceStore.clear();
  });

  test('record adds a trace', () => {
    traceStore.record(makeTrace());
    expect(traceStore.getTraces()).toHaveLength(1);
  });

  test('getTraces returns a copy', () => {
    traceStore.record(makeTrace());
    const a = traceStore.getTraces();
    const b = traceStore.getTraces();
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
  });

  test('getRecentTraces respects limit', () => {
    for (let i = 0; i < 10; i++) {
      traceStore.record(makeTrace({ model: `model-${i}` }));
    }
    const recent = traceStore.getRecentTraces(3);
    expect(recent).toHaveLength(3);
    expect(recent[0].model).toBe('model-7');
    expect(recent[2].model).toBe('model-9');
  });

  test('buffer caps at 200 entries', () => {
    for (let i = 0; i < 220; i++) {
      traceStore.record(makeTrace({ model: `m-${i}` }));
    }
    const all = traceStore.getTraces();
    expect(all).toHaveLength(200);
    expect(all[0].model).toBe('m-20');
    expect(all[199].model).toBe('m-219');
  });

  test('clear empties all traces', () => {
    traceStore.record(makeTrace());
    traceStore.record(makeTrace());
    expect(traceStore.getTraces()).toHaveLength(2);
    traceStore.clear();
    expect(traceStore.getTraces()).toHaveLength(0);
  });

  test('subscribe receives current traces immediately', () => {
    traceStore.record(makeTrace());
    let received: LlmTrace[] = [];
    const unsub = traceStore.subscribe((traces) => { received = traces; });
    expect(received).toHaveLength(1);
    unsub();
  });

  test('subscribe notified on new trace', () => {
    let received: LlmTrace[] = [];
    const unsub = traceStore.subscribe((traces) => { received = traces; });
    expect(received).toHaveLength(0);
    traceStore.record(makeTrace());
    expect(received).toHaveLength(1);
    unsub();
  });

  test('unsubscribe stops notifications', () => {
    let callCount = 0;
    const unsub = traceStore.subscribe(() => { callCount++; });
    expect(callCount).toBe(1); // initial
    traceStore.record(makeTrace());
    expect(callCount).toBe(2);
    unsub();
    traceStore.record(makeTrace());
    expect(callCount).toBe(2); // no change
  });
});

describe('TraceStore.getStats', () => {
  beforeEach(() => {
    traceStore.clear();
  });

  test('empty stats', () => {
    const stats = traceStore.getStats();
    expect(stats.totalCalls).toBe(0);
    expect(stats.successfulCalls).toBe(0);
    expect(stats.errorCalls).toBe(0);
    expect(stats.totalTokens).toBe(0);
  });

  test('counts success and error calls', () => {
    traceStore.record(makeTrace({ status: 'ok', totalTokens: 100 }));
    traceStore.record(makeTrace({ status: 'ok', totalTokens: 200 }));
    traceStore.record(makeTrace({ status: 'error', totalTokens: 0, error: 'timeout' }));
    const stats = traceStore.getStats();
    expect(stats.totalCalls).toBe(3);
    expect(stats.successfulCalls).toBe(2);
    expect(stats.errorCalls).toBe(1);
    expect(stats.totalTokens).toBe(300);
  });

  test('groups by model', () => {
    traceStore.record(makeTrace({ model: 'gpt-5.2', totalTokens: 100, durationMs: 1000 }));
    traceStore.record(makeTrace({ model: 'gpt-5.2', totalTokens: 200, durationMs: 2000 }));
    traceStore.record(makeTrace({ model: 'claude-sonnet', totalTokens: 150, durationMs: 800 }));
    const stats = traceStore.getStats();
    expect(stats.byModel['gpt-5.2'].calls).toBe(2);
    expect(stats.byModel['gpt-5.2'].tokens).toBe(300);
    expect(stats.byModel['gpt-5.2'].avgMs).toBe(1500);
    expect(stats.byModel['claude-sonnet'].calls).toBe(1);
    expect(stats.byModel['claude-sonnet'].tokens).toBe(150);
  });

  test('avgDurationMs is correct', () => {
    traceStore.record(makeTrace({ durationMs: 1000 }));
    traceStore.record(makeTrace({ durationMs: 3000 }));
    const stats = traceStore.getStats();
    expect(stats.avgDurationMs).toBe(2000);
  });
});

describe('TraceStore edge cases', () => {
  beforeEach(() => {
    traceStore.clear();
  });

  test('getRecentTraces with limit larger than trace count returns all', () => {
    traceStore.record(makeTrace({ model: 'a' }));
    traceStore.record(makeTrace({ model: 'b' }));
    const recent = traceStore.getRecentTraces(100);
    expect(recent).toHaveLength(2);
  });

  test('getRecentTraces default limit is 50', () => {
    for (let i = 0; i < 60; i++) {
      traceStore.record(makeTrace({ model: `m-${i}` }));
    }
    const recent = traceStore.getRecentTraces();
    expect(recent).toHaveLength(50);
    expect(recent[0].model).toBe('m-10');
  });

  test('getTraces returns empty after clear', () => {
    traceStore.record(makeTrace());
    traceStore.clear();
    expect(traceStore.getTraces()).toEqual([]);
  });

  test('getStats with all errors has zero tokens and duration', () => {
    traceStore.record(makeTrace({ status: 'error', totalTokens: 0, durationMs: 500, error: 'err1' }));
    traceStore.record(makeTrace({ status: 'error', totalTokens: 0, durationMs: 300, error: 'err2' }));
    const stats = traceStore.getStats();
    expect(stats.totalCalls).toBe(2);
    expect(stats.successfulCalls).toBe(0);
    expect(stats.totalTokens).toBe(0);
    expect(stats.totalDurationMs).toBe(0);
    expect(stats.avgDurationMs).toBe(0);
    expect(Object.keys(stats.byModel)).toHaveLength(0);
  });

  test('getStats byModel does not include error traces', () => {
    traceStore.record(makeTrace({ model: 'err-model', status: 'error', error: 'bad' }));
    traceStore.record(makeTrace({ model: 'ok-model', status: 'ok', totalTokens: 50 }));
    const stats = traceStore.getStats();
    expect(stats.byModel['ok-model']).toBeDefined();
    expect(stats.byModel['err-model']).toBeUndefined();
  });

  test('multiple subscribers all receive notifications', () => {
    let count1 = 0;
    let count2 = 0;
    const unsub1 = traceStore.subscribe(() => { count1++; });
    const unsub2 = traceStore.subscribe(() => { count2++; });
    // Each subscriber gets initial call
    expect(count1).toBe(1);
    expect(count2).toBe(1);
    traceStore.record(makeTrace());
    expect(count1).toBe(2);
    expect(count2).toBe(2);
    unsub1();
    unsub2();
  });

  test('clear notifies subscribers', () => {
    let notified = 0;
    const unsub = traceStore.subscribe(() => { notified++; });
    traceStore.record(makeTrace());
    const countBefore = notified;
    traceStore.clear();
    expect(notified).toBe(countBefore + 1);
    unsub();
  });

  test('trace with error field stores error string', () => {
    traceStore.record(makeTrace({ status: 'error', error: 'Connection refused' }));
    const traces = traceStore.getTraces();
    expect(traces[0].error).toBe('Connection refused');
  });
});

describe('TraceStore.setDatabase', () => {
  test('persists traces to database', async () => {
    const db = createTestDb();
    traceStore.setDatabase(db);
    traceStore.clear();
    
    traceStore.record(makeTrace({ id: 'trace-1', model: 'gpt-5.2', totalTokens: 100 }));
    
    await new Promise(r => setTimeout(r, 10));
    
    const rows = db.prepare('SELECT * FROM llm_traces').all() as Record<string, unknown>[];
    const row = rows.find(r => r.trace_id === 'trace-1');
    expect(row).toBeDefined();
    expect(row!.trace_id).toBe('trace-1');
    expect(row!.model).toBe('gpt-5.2');
    expect(row!.total_tokens).toBe(100);
  });

  test('persists error traces to database', async () => {
    const db = createTestDb();
    traceStore.setDatabase(db);
    traceStore.clear();
    
    traceStore.record(makeTrace({ status: 'error', error: 'timeout' }));
    
    await new Promise(r => setTimeout(r, 10));
    
    const rows = db.prepare('SELECT status, error FROM llm_traces').all() as { status: string; error: string | null }[];
    const row = rows.find(r => r.status === 'error');
    expect(row).toBeDefined();
    expect(row!.status).toBe('error');
    expect(row!.error).toBe('timeout');
  });
});
