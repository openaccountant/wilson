import { z } from 'zod';
import { defineTool } from '../define-tool.js';
import { formatToolResult } from '../types.js';
import { logger } from '../../utils/logger.js';

const BRAVE_SEARCH_URL = 'https://api.search.brave.com/res/v1/web/search';

interface BraveSearchResult {
  title: string;
  url: string;
  description: string;
}

interface BraveSearchResponse {
  web?: {
    results?: BraveSearchResult[];
  };
}

export const braveSearch = defineTool({
  name: 'web_search',
  description:
    'Search the web for current information on any topic. Returns relevant search results with URLs and content snippets.',
  schema: z.object({
    query: z.string().describe('The search query to look up on the web'),
  }),
  func: async (input) => {
    try {
      const apiKey = process.env.BRAVE_API_KEY;
      if (!apiKey) {
        throw new Error('BRAVE_API_KEY is not set');
      }

      const params = new URLSearchParams({
        q: input.query,
        count: '5',
      });

      const response = await fetch(`${BRAVE_SEARCH_URL}?${params}`, {
        headers: {
          Accept: 'application/json',
          'Accept-Encoding': 'gzip',
          'X-Subscription-Token': apiKey,
        },
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`${response.status}: ${text}`);
      }

      const data = (await response.json()) as BraveSearchResponse;
      const results = data.web?.results ?? [];

      const urls = results.map((r) => r.url).filter(Boolean);
      const parsed = {
        results: results.map((r) => ({
          title: r.title,
          url: r.url,
          snippet: r.description?.slice(0, 300) ?? '',
        })),
      };

      return formatToolResult(parsed, urls.length ? urls : undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`[Brave Search API] error: ${message}`);
      throw new Error(`[Brave Search API] ${message}`);
    }
  },
});
