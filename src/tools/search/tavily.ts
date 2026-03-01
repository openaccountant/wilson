import { z } from 'zod';
import { defineTool } from '../define-tool.js';
import { formatToolResult } from '../types.js';
import { logger } from '../../utils/logger.js';

const TAVILY_API_URL = 'https://api.tavily.com/search';

interface TavilyResult {
  title: string;
  url: string;
  content: string;
  score: number;
}

interface TavilyResponse {
  results: TavilyResult[];
  answer?: string;
}

export const tavilySearch = defineTool({
  name: 'web_search',
  description:
    'Search the web for current information on any topic. Returns relevant search results with URLs and content snippets.',
  schema: z.object({
    query: z.string().describe('The search query to look up on the web'),
  }),
  func: async (input) => {
    try {
      const apiKey = process.env.TAVILY_API_KEY;
      if (!apiKey) {
        throw new Error('TAVILY_API_KEY is not set');
      }

      const response = await fetch(TAVILY_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: apiKey,
          query: input.query,
          max_results: 5,
        }),
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`${response.status}: ${text}`);
      }

      const data = (await response.json()) as TavilyResponse;

      const urls = data.results.map((r) => r.url).filter(Boolean);
      const parsed = {
        results: data.results.map((r) => ({
          title: r.title,
          url: r.url,
          snippet: r.content?.slice(0, 300) ?? '',
        })),
      };

      return formatToolResult(parsed, urls.length ? urls : undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`[Tavily API] error: ${message}`);
      throw new Error(`[Tavily API] ${message}`);
    }
  },
});
