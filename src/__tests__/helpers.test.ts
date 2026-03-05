import { describe, test, expect } from 'bun:test';
import { mockCallLlm, mockTool, makeTmpPath, createTestDb, ensureTestProfile, collectEvents } from './helpers.js';

describe('mockCallLlm', () => {
  test('returns responses in sequence', async () => {
    const callLlm = mockCallLlm([
      { response: { content: 'first', toolCalls: [] } },
      { response: { content: 'second', toolCalls: [] } },
    ]);

    const r1 = await callLlm();
    expect(r1.response.content).toBe('first');

    const r2 = await callLlm();
    expect(r2.response.content).toBe('second');
  });

  test('repeats last response when calls exceed array length', async () => {
    const callLlm = mockCallLlm([
      { response: { content: 'only', toolCalls: [] } },
    ]);

    await callLlm();
    const r2 = await callLlm();
    const r3 = await callLlm();
    expect(r2.response.content).toBe('only');
    expect(r3.response.content).toBe('only');
  });

  test('defaults content and toolCalls when response omitted', async () => {
    const callLlm = mockCallLlm([{}]);
    const r = await callLlm();
    expect(r.response.content).toBe('');
    expect(r.response.toolCalls).toEqual([]);
  });

  test('interactionId defaults to null', async () => {
    const callLlm = mockCallLlm([{}]);
    const r = await callLlm();
    expect(r.interactionId).toBeNull();
  });

  test('explicit interactionId is preserved', async () => {
    const callLlm = mockCallLlm([{ interactionId: 123 }]);
    const r = await callLlm();
    expect(r.interactionId).toBe(123);
  });

  test('usage defaults to undefined', async () => {
    const callLlm = mockCallLlm([{}]);
    const r = await callLlm();
    expect(r.usage).toBeUndefined();
  });

  test('explicit usage is preserved', async () => {
    const usage = { inputTokens: 10, outputTokens: 20, totalTokens: 30 };
    const callLlm = mockCallLlm([{ usage }]);
    const r = await callLlm();
    expect(r.usage).toEqual(usage);
  });

  test('multiple calls cycle through responses with mixed fields', async () => {
    const callLlm = mockCallLlm([
      { response: { content: 'a', toolCalls: [] }, interactionId: 1 },
      { response: { content: 'b', toolCalls: [{ id: 'tc1', name: 'tool', args: {} }] }, usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 } },
    ]);

    const r1 = await callLlm();
    expect(r1.response.content).toBe('a');
    expect(r1.interactionId).toBe(1);
    expect(r1.usage).toBeUndefined();

    const r2 = await callLlm();
    expect(r2.response.content).toBe('b');
    expect(r2.response.toolCalls).toHaveLength(1);
    expect(r2.usage!.totalTokens).toBe(10);
    expect(r2.interactionId).toBeNull();
  });
});

describe('mockTool', () => {
  test('creates a tool with name and function', () => {
    const tool = mockTool('test', async () => 'result');
    expect(tool.name).toBe('test');
    expect(tool.description).toContain('test');
  });

  test('tool func returns expected value', async () => {
    const tool = mockTool('adder', async (args) => `sum: ${((args as Record<string, unknown>).a as number) + ((args as Record<string, unknown>).b as number)}`);
    const result = await tool.func({ a: 1, b: 2 });
    expect(result).toBe('sum: 3');
  });
});

describe('makeTmpPath', () => {
  test('returns path with given extension', () => {
    const p = makeTmpPath('.json');
    expect(p).toMatch(/\.json$/);
  });

  test('returns unique paths', () => {
    const a = makeTmpPath('.txt');
    const b = makeTmpPath('.txt');
    expect(a).not.toBe(b);
  });
});

describe('createTestDb', () => {
  test('creates an in-memory database with tables', () => {
    const db = createTestDb();
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain('transactions');
    expect(names).toContain('imports');
    db.close();
  });
});

describe('ensureTestProfile', () => {
  test('is idempotent', () => {
    ensureTestProfile();
    ensureTestProfile();
    // Should not throw
    expect(true).toBe(true);
  });
});

describe('collectEvents', () => {
  test('drains async generator into array', async () => {
    async function* gen() {
      yield 1;
      yield 2;
      yield 3;
    }
    const events = await collectEvents(gen());
    expect(events).toEqual([1, 2, 3]);
  });

  test('returns empty array for empty generator', async () => {
    async function* gen() {}
    const events = await collectEvents(gen());
    expect(events).toEqual([]);
  });
});
