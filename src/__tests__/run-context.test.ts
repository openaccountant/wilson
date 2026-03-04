import { describe, expect, test, beforeEach } from 'bun:test';
import { createRunContext } from '../agent/run-context.js';
import { Scratchpad } from '../agent/scratchpad.js';
import { TokenCounter } from '../agent/token-counter.js';
import { ensureTestProfile } from './helpers.js';

describe('createRunContext', () => {
  beforeEach(() => {
    ensureTestProfile();
  });

  test('creates unique runIds', () => {
    const ctx1 = createRunContext('query 1');
    const ctx2 = createRunContext('query 2');
    expect(ctx1.runId).not.toBe(ctx2.runId);
    // UUID format
    expect(ctx1.runId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  test('query field matches input', () => {
    const ctx = createRunContext('show my spending');
    expect(ctx.query).toBe('show my spending');
  });

  test('scratchpad is a Scratchpad instance', () => {
    const ctx = createRunContext('test');
    expect(ctx.scratchpad).toBeInstanceOf(Scratchpad);
  });

  test('tokenCounter is a TokenCounter instance', () => {
    const ctx = createRunContext('test');
    expect(ctx.tokenCounter).toBeInstanceOf(TokenCounter);
  });

  test('startTime is close to Date.now()', () => {
    const before = Date.now();
    const ctx = createRunContext('test');
    const after = Date.now();
    expect(ctx.startTime).toBeGreaterThanOrEqual(before);
    expect(ctx.startTime).toBeLessThanOrEqual(after);
  });

  test('iteration starts at 0', () => {
    const ctx = createRunContext('test');
    expect(ctx.iteration).toBe(0);
  });

  test('sequenceNum starts at 0', () => {
    const ctx = createRunContext('test');
    expect(ctx.sequenceNum).toBe(0);
  });
});
