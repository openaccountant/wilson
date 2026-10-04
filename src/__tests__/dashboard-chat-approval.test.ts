import { describe, expect, test } from 'bun:test';
import { pickPendingChatOperation, summarizeArgs, type ChatOperationLike } from '../dashboard/ui/src/lib/chatApproval';

function op(over: Partial<ChatOperationLike>): ChatOperationLike {
  return { id: 'x', source: 'chat', status: 'pending', tool_name: 'categorize', args_json: '{}', ...over };
}

describe('pickPendingChatOperation', () => {
  test('returns the pending chat operation among others', () => {
    const ops = [
      op({ id: 'a', source: 'webmcp' }),
      op({ id: 'b', status: 'committed' }),
      op({ id: 'c' }),
    ];
    expect(pickPendingChatOperation(ops)?.id).toBe('c');
  });

  test('null when none match or input is malformed', () => {
    expect(pickPendingChatOperation([op({ source: 'http-mcp' })])).toBeNull();
    expect(pickPendingChatOperation([])).toBeNull();
    expect(pickPendingChatOperation(null)).toBeNull();
    expect(pickPendingChatOperation(undefined)).toBeNull();
    expect(pickPendingChatOperation({} as unknown as ChatOperationLike[])).toBeNull();
  });

  test('skips dismissed ids', () => {
    const ops = [op({ id: 'a' }), op({ id: 'b' })];
    expect(pickPendingChatOperation(ops, new Set(['a']))?.id).toBe('b');
    expect(pickPendingChatOperation(ops, new Set(['a', 'b']))).toBeNull();
  });
});

describe('summarizeArgs', () => {
  test('formats key: value pairs', () => {
    expect(summarizeArgs('{"limit":5}')).toBe('limit: 5');
    expect(summarizeArgs('{"limit":5,"category":"Dining","dryRun":false}')).toBe(
      'limit: 5, category: Dining, dryRun: false',
    );
  });

  test('drops null args and handles empty', () => {
    expect(summarizeArgs('{"limit":null}')).toBe('');
    expect(summarizeArgs('{}')).toBe('');
    expect(summarizeArgs('null')).toBe('');
    expect(summarizeArgs(null)).toBe('');
    expect(summarizeArgs('')).toBe('');
  });

  test('arrays and nested objects stay short', () => {
    expect(summarizeArgs('{"ids":[1,2,3]}')).toBe('ids: 1, 2, 3');
    expect(summarizeArgs('{"ids":[1,2,3,4,5]}')).toBe('ids: 5 items');
    expect(summarizeArgs('{"f":{"a":1}}')).toBe('f: {"a":1}');
  });

  test('truncates long values and tolerates invalid JSON', () => {
    const long = 'x'.repeat(100);
    const out = summarizeArgs(JSON.stringify({ q: long }));
    expect(out.length).toBeLessThanOrEqual(3 + 40);
    expect(out.endsWith('…')).toBe(true);
    expect(summarizeArgs('not json')).toBe('not json');
  });
});
