import { describe, expect, test } from 'bun:test';
import { parseToolCall } from '../model/providers/transformers.js';
import { classifyLocalOutput } from '../dashboard/ui/src/hybrid/core.js';

/**
 * The browser local chat is never offered tools, so any tool-call attempt must
 * hand off to the server agent instead of rendering raw JSON as an answer. The
 * server parser is the source of truth for what a call looks like; every output
 * it accepts must be detected by the browser classifier. Tag literals are built
 * from char codes so this file never contains them literally.
 */
const LT = String.fromCharCode(60);
const names = ['transaction_search', 'categorize', 'spending_summary'];
const skills = ['month-end-close'];

const calls: Array<[string, string]> = [
  ['tagged', `${LT}tool_call>{"name": "categorize", "arguments": {"limit": 5}}${LT}/tool_call>`],
  ['bare JSON', '{"name": "categorize", "arguments": {"limit": 5}}'],
  ['legacy args key', '{"name": "categorize", "args": {"limit": 5}}'],
  [
    'stringified arguments with a stray fence',
    '{"name": "transaction_search", "arguments": "{\\n  \\"query\\": \\"dining\\"\\n}"}\n```',
  ],
  ['fenced JSON', '```json\n{"name": "categorize", "arguments": {}}\n```'],
  [
    'call followed by invented text with braces',
    '{"name": "spending_summary", "arguments": "{\\"period\\": \\"July\\"}"}\n\n**Groceries:** $842.50 {braces}',
  ],
  ['braces and quotes inside a string value', '{"name": "categorize", "arguments": {"note": "a } \\" { b"}} done'],
  ['skill name called as a tool', '{"name": "month-end-close", "arguments": {}} Sure, closing...'],
];

const notCalls: Array<[string, string]> = [
  ['plain answer', 'You spent $42 on dining.'],
  ['unrelated JSON', '{"total": 42}'],
  ['object with a name but no arguments', '{"name": "Chase", "balance": 1200}'],
  ['truncated call', '{"name": "categorize", "arguments": {"limit": '],
];

describe('hybrid tool-call detection stays in step with the server parser', () => {
  for (const [label, raw] of calls) {
    test(`server parses and browser hands off: ${label}`, () => {
      expect(parseToolCall(raw, names, skills)).not.toBeNull();
      expect(classifyLocalOutput(raw)).toEqual({ kind: 'handoff', reason: 'tool-call' });
    });
  }

  for (const [label, raw] of notCalls) {
    test(`neither treats it as a call: ${label}`, () => {
      expect(parseToolCall(raw, names, skills)).toBeNull();
      expect(classifyLocalOutput(raw).kind).not.toBe('handoff');
    });
  }

  test('a call after prose is not a leading call; the answer stands', () => {
    const raw = 'You spent $42. {"name": "categorize", "arguments": {}}';
    expect(parseToolCall(raw, names)).toBeNull();
    expect(classifyLocalOutput(raw).kind).toBe('answer');
  });
});
