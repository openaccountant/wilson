import { z } from 'zod';
import { defineTool } from '../define-tool.js';
import { formatToolResult } from '../types.js';
import type { Database } from '../../db/compat-sqlite.js';
import {
  getActiveMemories,
  addMemory,
  deactivateMemory,
  searchMemories,
} from '../../db/memory-queries.js';

let db: Database;

export function initMemoryManageTool(database: Database) {
  db = database;
}

export const memoryManageTool = defineTool({
  name: 'memory_manage',
  description: 'Store and retrieve memories — context about the user, insights discovered, and advice given.',
  schema: z.object({
    action: z.enum(['add', 'list', 'search', 'deactivate']).describe('Action to perform'),
    memoryType: z.enum(['context', 'insight', 'advice']).optional().describe('Memory type (required for add, optional filter for list)'),
    content: z.string().optional().describe('Memory content (required for add)'),
    category: z.string().optional().describe('Optional grouping category (spending, income, goals, tax, etc.)'),
    sourceQuery: z.string().optional().describe('The user query that triggered this memory'),
    expiresAt: z.string().optional().describe('Optional expiration date (ISO format)'),
    query: z.string().optional().describe('Search query (for search action)'),
    memoryId: z.number().optional().describe('Memory ID (for deactivate action)'),
  }),
  func: async ({ action, memoryType, content, category, sourceQuery, expiresAt, query, memoryId }) => {
    switch (action) {
      case 'add': {
        if (!memoryType || !content) {
          return formatToolResult({ error: 'memoryType and content are required for add action' });
        }
        const id = addMemory(db, { memoryType, content, category, sourceQuery, expiresAt });
        return formatToolResult({ message: `Memory stored (${memoryType}): "${content.slice(0, 80)}${content.length > 80 ? '...' : ''}"`, id });
      }

      case 'list': {
        const memories = getActiveMemories(db, memoryType, 20);
        return formatToolResult({ memories, count: memories.length });
      }

      case 'search': {
        if (!query) {
          return formatToolResult({ error: 'query is required for search action' });
        }
        const results = searchMemories(db, query);
        return formatToolResult({ results, count: results.length });
      }

      case 'deactivate': {
        if (!memoryId) {
          return formatToolResult({ error: 'memoryId is required for deactivate action' });
        }
        const success = deactivateMemory(db, memoryId);
        return formatToolResult({ message: success ? `Memory #${memoryId} deactivated` : `Memory #${memoryId} not found`, success });
      }

      default:
        return formatToolResult({ error: `Unknown action: ${action}` });
    }
  },
});
