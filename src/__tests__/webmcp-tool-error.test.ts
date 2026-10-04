import { describe, expect, test } from 'bun:test';
import { ToolCallError, errorResult, isErrorResult, runToolSafely, toolErrorFromResponse } from '../dashboard/webmcp-tool-error.js';

/**
 * Chrome 154 replaces ANY error thrown by a page or imperative tool handler with a generic
 * "UnknownError: Tool was executed but the invocation failed", so an agent never reads the actionable text.
 * Every refusal therefore comes back as a normal result `{ error: { code, message } }` (L4).
 */

describe('toolErrorFromResponse', () => {
  test('keeps the server code, message and hint; the status never leaves the REST layer', () => {
    const err = toolErrorFromResponse(404, { error: { code: 'not_found', message: 'Transaction #9 not found', hint: 'use transaction_search' } });
    expect(err).toBeInstanceOf(ToolCallError);
    expect(err.code).toBe('not_found');
    expect(err.message).toBe('Transaction #9 not found (use transaction_search)');
    expect(errorResult(err)).toEqual({ error: { code: 'not_found', message: 'Transaction #9 not found (use transaction_search)' } });
  });

  test('rubric_changed carries the current rubric version as its own field', () => {
    const err = toolErrorFromResponse(409, {
      error: { code: 'rubric_changed', message: 'rubricVersion "old" is not current.', currentRubricVersion: 'abc123def456' },
    });
    expect(errorResult(err)).toEqual({
      error: { code: 'rubric_changed', message: 'rubricVersion "old" is not current.', currentRubricVersion: 'abc123def456' },
    });
  });

  test('a body with no usable error falls back to an http_<status> code and a readable message', () => {
    expect(errorResult(toolErrorFromResponse(502, undefined))).toEqual({ error: { code: 'http_502', message: 'Request failed with status 502' } });
    expect(errorResult(toolErrorFromResponse(400, { error: 'plain text' }))).toEqual({ error: { code: 'http_400', message: 'plain text' } });
  });

  test('only a plain string is copied into currentRubricVersion (nothing else from the body rides along)', () => {
    const err = toolErrorFromResponse(409, { error: { code: 'rubric_changed', message: 'm', currentRubricVersion: { evil: 1 }, secret: 'x' } });
    expect(errorResult(err)).toEqual({ error: { code: 'rubric_changed', message: 'm' } });
  });
});

describe('errorResult / isErrorResult', () => {
  test('any Error becomes {error:{code,message}}; a non-Error is stringified', () => {
    expect(errorResult(new Error('boom'))).toEqual({ error: { code: 'tool_failed', message: 'boom' } });
    expect(errorResult('nope')).toEqual({ error: { code: 'tool_failed', message: 'nope' } });
  });

  test('the message is bounded so an error can never outgrow the 1,500-character answer cap', () => {
    const out = errorResult(new Error('x'.repeat(5000)));
    expect(JSON.stringify(out).length).toBeLessThan(1500);
  });

  test('isErrorResult recognises only the {error:{code,message}} shape', () => {
    expect(isErrorResult({ error: { code: 'a', message: 'b' } })).toBe(true);
    expect(isErrorResult({ error: 'string' })).toBe(false);
    expect(isErrorResult({ outcome: 'rejected', operationId: 'op' })).toBe(false);
    expect(isErrorResult(null)).toBe(false);
    expect(isErrorResult('x')).toBe(false);
  });
});

describe('runToolSafely', () => {
  test('a thrown error becomes a returned error result', async () => {
    expect(await runToolSafely(async () => { throw new ToolCallError('policy_off', 'search is turned off'); })).toEqual({
      error: { code: 'policy_off', message: 'search is turned off' },
    });
    expect(await runToolSafely(() => { throw new Error('sync throw'); })).toEqual({ error: { code: 'tool_failed', message: 'sync throw' } });
  });

  test('a value passes through untouched', async () => {
    expect(await runToolSafely(async () => ({ rows: 1 }))).toEqual({ rows: 1 });
  });

  test('an AbortError still rejects: the agent gave up, there is nobody to tell', async () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    await expect(runToolSafely(async () => { throw abort; })).rejects.toMatchObject({ name: 'AbortError' });
  });
});
