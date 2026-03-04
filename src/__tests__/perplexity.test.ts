import { describe, test, expect, spyOn, beforeEach, afterEach } from 'bun:test';

describe('perplexity search tool', () => {
  let fetchSpy: ReturnType<typeof spyOn>;
  const origKey = process.env.PERPLEXITY_API_KEY;

  beforeEach(() => {
    process.env.PERPLEXITY_API_KEY = 'test-perplexity-key';
  });

  afterEach(() => {
    fetchSpy?.mockRestore();
    if (origKey !== undefined) {
      process.env.PERPLEXITY_API_KEY = origKey;
    } else {
      delete process.env.PERPLEXITY_API_KEY;
    }
  });

  // Lazily import to pick up env vars at call time
  async function getTool() {
    const { perplexitySearch } = await import('../tools/search/perplexity.js');
    return perplexitySearch;
  }

  test('throws when API key is not set', async () => {
    delete process.env.PERPLEXITY_API_KEY;
    const tool = await getTool();

    await expect(tool.func({ query: 'test' })).rejects.toThrow('PERPLEXITY_API_KEY');
  });

  test('returns formatted result with citations', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: 'The answer is 42.' } }],
          citations: ['https://example.com/source1'],
          search_results: [
            { title: 'Source 1', url: 'https://example.com/source1', snippet: 'A snippet' },
            { title: 'Source 2', url: 'https://example.com/source2', snippet: 'Another' },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const tool = await getTool();
    const result = tool.func({ query: 'what is 42' });
    const text = await result;
    const parsed = JSON.parse(text);

    expect(parsed.data.answer).toBe('The answer is 42.');
    expect(parsed.data.results).toHaveLength(2);
    expect(parsed.data.results[0].title).toBe('Source 1');
    expect(parsed.sourceUrls).toContain('https://example.com/source1');
    expect(parsed.sourceUrls).toContain('https://example.com/source2');
  });

  test('throws on API error', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('Rate limited', { status: 429 }),
    );

    const tool = await getTool();
    await expect(tool.func({ query: 'test' })).rejects.toThrow('429');
  });

  test('handles missing citations gracefully', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: 'No citations here.' } }],
          // No citations or search_results
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const tool = await getTool();
    const text = await tool.func({ query: 'test' });
    const parsed = JSON.parse(text);

    expect(parsed.data.answer).toBe('No citations here.');
    expect(parsed.data.results).toEqual([]);
  });

  test('handles empty choices', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ choices: [] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const tool = await getTool();
    const text = await tool.func({ query: 'test' });
    const parsed = JSON.parse(text);

    expect(parsed.data.answer).toBe('');
  });

  test('deduplicates URLs from citations and search_results', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: 'answer' } }],
          citations: ['https://example.com/a', 'https://example.com/b'],
          search_results: [
            { title: 'A', url: 'https://example.com/a', snippet: '' },
            { title: 'C', url: 'https://example.com/c', snippet: '' },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const tool = await getTool();
    const text = await tool.func({ query: 'test' });
    const parsed = JSON.parse(text);

    // 'a' should only appear once
    const urls = parsed.sourceUrls as string[];
    expect(urls.filter((u: string) => u === 'https://example.com/a')).toHaveLength(1);
    expect(urls).toContain('https://example.com/b');
    expect(urls).toContain('https://example.com/c');
  });
});
