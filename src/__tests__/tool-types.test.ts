import { describe, expect, test } from 'bun:test';
import { formatToolResult, parseSearchResults } from '../tools/types.js';

describe('formatToolResult', () => {
  test('wraps data in JSON with data key', () => {
    const result = JSON.parse(formatToolResult({ foo: 'bar' }));
    expect(result.data).toEqual({ foo: 'bar' });
  });

  test('omits sourceUrls when not provided', () => {
    const result = JSON.parse(formatToolResult('test'));
    expect(result.sourceUrls).toBeUndefined();
  });

  test('omits sourceUrls when empty array', () => {
    const result = JSON.parse(formatToolResult('test', []));
    expect(result.sourceUrls).toBeUndefined();
  });

  test('includes sourceUrls when provided', () => {
    const result = JSON.parse(formatToolResult('test', ['https://example.com']));
    expect(result.sourceUrls).toEqual(['https://example.com']);
  });

  test('handles complex data structures', () => {
    const data = { items: [1, 2, 3], nested: { a: true } };
    const result = JSON.parse(formatToolResult(data));
    expect(result.data).toEqual(data);
  });
});

describe('parseSearchResults', () => {
  test('parses JSON string with results array containing urls', () => {
    const input = JSON.stringify({ results: [{ url: 'https://a.com' }, { url: 'https://b.com' }] });
    const { parsed, urls } = parseSearchResults(input);
    expect(urls).toEqual(['https://a.com', 'https://b.com']);
  });

  test('parses array input with url fields', () => {
    const input = [{ url: 'https://a.com', title: 'A' }];
    const { urls } = parseSearchResults(input);
    expect(urls).toEqual(['https://a.com']);
  });

  test('returns empty urls for object without results', () => {
    const { urls } = parseSearchResults({ foo: 'bar' });
    expect(urls).toEqual([]);
  });

  test('handles plain string that is not JSON', () => {
    const { parsed, urls } = parseSearchResults('not json');
    expect(parsed).toBe('not json');
    expect(urls).toEqual([]);
  });

  test('filters out entries without url field', () => {
    const input = JSON.stringify({ results: [{ url: 'https://a.com' }, { title: 'no url' }] });
    const { urls } = parseSearchResults(input);
    expect(urls).toEqual(['https://a.com']);
  });
});
