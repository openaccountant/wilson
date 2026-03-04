import { describe, expect, test } from 'bun:test';
import { TokenCounter } from '../agent/token-counter.js';

describe('TokenCounter', () => {
  test('add single usage accumulates correctly', () => {
    const counter = new TokenCounter();
    counter.add({ inputTokens: 100, outputTokens: 50, totalTokens: 150 });
    const usage = counter.getUsage();
    expect(usage).toEqual({ inputTokens: 100, outputTokens: 50, totalTokens: 150 });
  });

  test('add multiple usages sums correctly', () => {
    const counter = new TokenCounter();
    counter.add({ inputTokens: 100, outputTokens: 50, totalTokens: 150 });
    counter.add({ inputTokens: 200, outputTokens: 100, totalTokens: 300 });
    counter.add({ inputTokens: 50, outputTokens: 25, totalTokens: 75 });
    const usage = counter.getUsage();
    expect(usage).toEqual({ inputTokens: 350, outputTokens: 175, totalTokens: 525 });
  });

  test('add undefined is a no-op', () => {
    const counter = new TokenCounter();
    counter.add(undefined);
    expect(counter.getUsage()).toBeUndefined();
  });

  test('getUsage returns undefined when no tokens tracked', () => {
    const counter = new TokenCounter();
    expect(counter.getUsage()).toBeUndefined();
  });

  test('getUsage returns a copy', () => {
    const counter = new TokenCounter();
    counter.add({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
    const a = counter.getUsage();
    const b = counter.getUsage();
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
  });

  test('getTokensPerSecond calculates correctly', () => {
    const counter = new TokenCounter();
    counter.add({ inputTokens: 500, outputTokens: 500, totalTokens: 1000 });
    // 1000 tokens in 2000ms = 500 tokens/sec
    expect(counter.getTokensPerSecond(2000)).toBe(500);
  });

  test('getTokensPerSecond returns undefined when no tokens', () => {
    const counter = new TokenCounter();
    expect(counter.getTokensPerSecond(1000)).toBeUndefined();
  });

  test('getTokensPerSecond returns undefined when elapsedMs <= 0', () => {
    const counter = new TokenCounter();
    counter.add({ inputTokens: 100, outputTokens: 50, totalTokens: 150 });
    expect(counter.getTokensPerSecond(0)).toBeUndefined();
    expect(counter.getTokensPerSecond(-100)).toBeUndefined();
  });
});
