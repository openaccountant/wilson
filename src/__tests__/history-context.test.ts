import { describe, expect, test } from 'bun:test';
import {
  buildBudgetedHistoryContext,
  buildHistoryContext,
  type HistoryEntry,
  HISTORY_CONTEXT_MARKER,
  CURRENT_MESSAGE_MARKER,
} from '../utils/history-context.js';

describe('buildHistoryContext', () => {
  test('empty entries returns just the current message', () => {
    const result = buildHistoryContext({
      entries: [],
      currentMessage: 'What is my balance?',
    });
    expect(result).toBe('What is my balance?');
  });

  test('single entry includes history marker', () => {
    const result = buildHistoryContext({
      entries: [{ role: 'user', content: 'Hello' }],
      currentMessage: 'How are you?',
    });
    expect(result).toContain(HISTORY_CONTEXT_MARKER);
    expect(result).toContain(CURRENT_MESSAGE_MARKER);
    expect(result).toContain('User: Hello');
    expect(result).toContain('How are you?');
  });

  test('multiple entries are formatted with roles', () => {
    const result = buildHistoryContext({
      entries: [
        { role: 'user', content: 'Question 1' },
        { role: 'assistant', content: 'Answer 1' },
        { role: 'user', content: 'Question 2' },
      ],
      currentMessage: 'Question 3',
    });
    expect(result).toContain('User: Question 1');
    expect(result).toContain('Assistant: Answer 1');
    expect(result).toContain('User: Question 2');
    expect(result).toContain('Question 3');
  });

  test('history marker appears before entries', () => {
    const result = buildHistoryContext({
      entries: [{ role: 'user', content: 'Hi' }],
      currentMessage: 'Now',
    });
    const markerIdx = result.indexOf(HISTORY_CONTEXT_MARKER);
    const entryIdx = result.indexOf('User: Hi');
    const currentIdx = result.indexOf(CURRENT_MESSAGE_MARKER);
    expect(markerIdx).toBeLessThan(entryIdx);
    expect(entryIdx).toBeLessThan(currentIdx);
  });

  test('respects custom lineBreak', () => {
    const result = buildHistoryContext({
      entries: [{ role: 'user', content: 'Hi' }],
      currentMessage: 'Now',
      lineBreak: '\r\n',
    });
    expect(result).toContain('\r\n');
  });
});

describe('buildBudgetedHistoryContext', () => {
  // One token per whitespace-separated word.
  const countTokens = (text: string) => text.split(/\s+/).filter(Boolean).length;
  const turns = (n: number): HistoryEntry[] =>
    Array.from({ length: n }, (_, i) => [
      { role: 'user' as const, content: `question ${i} ${'q '.repeat(20)}` },
      { role: 'assistant' as const, content: `answer ${i} ${'a '.repeat(80)}` },
    ]).flat();

  test('everything fits: same text as buildHistoryContext', () => {
    const entries = turns(3);
    const result = buildBudgetedHistoryContext({ entries, currentMessage: 'now?', countTokens, maxTokens: 10_000 });
    expect(result.text).toBe(buildHistoryContext({ entries, currentMessage: 'now?' }));
    expect(result.droppedEntries).toBe(0);
  });

  test('keeps the newest turns that fit and drops whole turns from the oldest', () => {
    const entries = turns(10);
    const result = buildBudgetedHistoryContext({ entries, currentMessage: 'now?', countTokens, maxTokens: 350 });
    expect(countTokens(result.text)).toBeLessThanOrEqual(350);
    expect(result.text).toContain('answer 9');
    expect(result.text).not.toContain('question 0 ');
    expect(result.droppedEntries % 2).toBe(0);
    expect(result.droppedEntries).toBeGreaterThan(0);
  });

  test('no room for any turn: just the current message', () => {
    const result = buildBudgetedHistoryContext({ entries: turns(2), currentMessage: 'now?', countTokens, maxTokens: 5 });
    expect(result.text).toBe('now?');
    expect(result.droppedEntries).toBe(4);
  });
});
