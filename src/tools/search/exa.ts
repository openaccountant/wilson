import Exa from 'exa-js';
import { z } from 'zod';
import { defineTool } from '../define-tool.js';
import { formatToolResult } from '../types.js';
import { logger } from '../../utils/logger.js';

// Lazily initialized to avoid errors when API key is not set
let client: Exa | null = null;

function getClient(): Exa {
  if (!client) {
    client = new Exa(process.env.EXASEARCH_API_KEY);
  }
  return client;
}

export const exaSearch = defineTool({
  name: 'web_search',
  description:
    'Search the web for current information on any topic. Returns relevant search results with URLs and content snippets.',
  schema: z.object({
    query: z.string().describe('The search query to look up on the web'),
  }),
  func: async (input) => {
    try {
      const results = await getClient().searchAndContents(input.query, {
        numResults: 5,
        highlights: true,
      });

      const urls = results.results.map((r) => r.url).filter(Boolean);
      const parsed = {
        results: results.results.map((r) => ({
          title: r.title ?? '',
          url: r.url,
          snippet: r.highlights?.join(' ') ?? (r as { text?: string }).text?.slice(0, 300) ?? '',
        })),
      };

      return formatToolResult(parsed, urls.length ? urls : undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`[Exa API] error: ${message}`);
      throw new Error(`[Exa API] ${message}`);
    }
  },
});
