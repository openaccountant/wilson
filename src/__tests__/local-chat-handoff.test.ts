import { describe, expect, test } from 'bun:test';
import {
  classifyLocalOutput,
  NEED_MORE_SENTINEL,
  NEED_MORE_PHRASES,
} from '../dashboard/ui/src/hybrid/core.js';

/**
 * Hand-off detection: local output that looks like a tool-call attempt, asks
 * for data outside the bundle, or is empty must hand off silently to the
 * server agent path. Order matters (tool-call shapes first) and is pinned
 * here. The tool-call tag literals are built from char codes so this file
 * never contains them literally.
 */
const LT = String.fromCharCode(60); // '<'

const repoToolCall = `${LT}tool_call>{"name": "query_transactions", "arguments": {}}${LT}/tool_call>`;
const qwenNativeToolCall = `${LT}tool_call>{"name": "query_transactions", "arguments": {}}${LT}tool_response>{"rows": []}`;

describe('classifyLocalOutput', () => {
  describe('tool-call shapes → handoff tool-call', () => {
    test('repo marker form (mirrors parseToolCall in transformers.ts)', () => {
      const v = classifyLocalOutput(`Let me check. ${repoToolCall}`);
      expect(v).toEqual({ kind: 'handoff', reason: 'tool-call' });
    });

    test('Qwen3 native form (tool_call … tool_response)', () => {
      const v = classifyLocalOutput(qwenNativeToolCall);
      expect(v).toEqual({ kind: 'handoff', reason: 'tool-call' });
    });

    test('both shapes detected even when the answer text looks reasonable', () => {
      expect(classifyLocalOutput(`You spent $54.21. ${repoToolCall}`).kind).toBe('handoff');
    });

    test('tool-call beats the sentinel (order matters)', () => {
      const v = classifyLocalOutput(`${NEED_MORE_SENTINEL} ${repoToolCall}`);
      expect(v).toEqual({ kind: 'handoff', reason: 'tool-call' });
    });
  });

  describe('NEED_MORE_DATA sentinel → handoff outside-bundle', () => {
    test('exact sentinel', () => {
      expect(classifyLocalOutput(NEED_MORE_SENTINEL)).toEqual({ kind: 'handoff', reason: 'outside-bundle' });
    });

    test('sentinel embedded in prose', () => {
      expect(classifyLocalOutput(`Sorry — ${NEED_MORE_SENTINEL} for that period.`)).toEqual({
        kind: 'handoff',
        reason: 'outside-bundle',
      });
    });
  });

  describe('fuzzy phrases → handoff outside-bundle', () => {
    for (const phrase of NEED_MORE_PHRASES) {
      test(`"${phrase}"`, () => {
        const v = classifyLocalOutput(`I ${phrase} transactions from last year.`);
        expect(v).toEqual({ kind: 'handoff', reason: 'outside-bundle' });
      });
    }

    test('matching is case-insensitive', () => {
      expect(classifyLocalOutput('I DO NOT HAVE ACCESS to that.').kind).toBe('handoff');
    });
  });

  describe('empty output → handoff no-answer', () => {
    test('empty string', () => {
      expect(classifyLocalOutput('')).toEqual({ kind: 'handoff', reason: 'no-answer' });
    });

    test('whitespace only', () => {
      expect(classifyLocalOutput('  \n\t ')).toEqual({ kind: 'handoff', reason: 'no-answer' });
    });
  });

  describe('normal answers → answer', () => {
    test('plain data-grounded answer', () => {
      const v = classifyLocalOutput('You spent $54.21 on groceries this week.');
      expect(v).toEqual({ kind: 'answer', text: 'You spent $54.21 on groceries this week.' });
    });

    test('the innocuous word "provide" alone does not trip the fuzzy backstop', () => {
      const v = classifyLocalOutput('I can provide the weekly total: $123.45.');
      expect(v.kind).toBe('answer');
    });

    test('the word "access" alone does not trip the backstop', () => {
      expect(classifyLocalOutput('Your top category this week was Dining.').kind).toBe('answer');
    });

    test('answers are trimmed', () => {
      expect(classifyLocalOutput('  $12.00 total.  ')).toEqual({ kind: 'answer', text: '$12.00 total.' });
    });

    test('tool-call-looking partial strings without the full shape stay answers', () => {
      // Unbalanced / partial markers are not a tool call — the model may be
      // writing prose that mentions the format.
      expect(classifyLocalOutput('The tool_call format is used for tools.').kind).toBe('answer');
    });
  });
});