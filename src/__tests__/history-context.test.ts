import { describe, expect, test } from 'bun:test';
import {
  buildHistoryContext,
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
