import { z } from 'zod';
import type { Database } from '../../db/compat-sqlite.js';
import { defineTool } from '../define-tool.js';
import { addRule, updateRule, deleteRule, getRules } from '../../db/queries.js';
import { formatToolResult } from '../types.js';

let db: Database | null = null;

export function initRuleManageTool(database: Database): void {
  db = database;
}

function getDb(): Database {
  if (!db) throw new Error('rule_manage tool not initialized. Call initRuleManageTool(database) first.');
  return db;
}

export const ruleManageTool = defineTool({
  name: 'rule_manage',
  description:
    'Manage categorization rules. Rules auto-categorize transactions by pattern before the LLM runs. ' +
    'Supports add, update, delete, and list actions.',
  schema: z.object({
    action: z.enum(['add', 'update', 'delete', 'list']).describe('CRUD action'),
    pattern: z.string().optional().describe('Match pattern (glob with * or regex if is_regex=true)'),
    category: z.string().optional().describe('Category to assign on match'),
    priority: z.number().optional().describe('Higher priority rules match first (default 0)'),
    is_regex: z.boolean().optional().describe('Treat pattern as regex instead of glob'),
    ruleId: z.number().optional().describe('Rule ID (for update/delete)'),
  }),
  func: async ({ action, pattern, category, priority, is_regex, ruleId }) => {
    const database = getDb();

    switch (action) {
      case 'add': {
        if (!pattern || !category) {
          return formatToolResult({ error: 'pattern and category are required for add' });
        }
        const id = addRule(database, pattern, category, priority ?? 0, is_regex ?? false);
        return formatToolResult({
          message: `Rule #${id} created: "${pattern}" → ${category}`,
          rule: { id, pattern, category, priority: priority ?? 0, is_regex: is_regex ?? false },
        });
      }
      case 'update': {
        if (!ruleId) return formatToolResult({ error: 'ruleId is required for update' });
        const updated = updateRule(database, ruleId, { pattern, category, priority, is_regex });
        return formatToolResult({
          message: updated ? `Rule #${ruleId} updated.` : `Rule #${ruleId} not found.`,
          success: updated,
        });
      }
      case 'delete': {
        if (!ruleId) return formatToolResult({ error: 'ruleId is required for delete' });
        const deleted = deleteRule(database, ruleId);
        return formatToolResult({
          message: deleted ? `Rule #${ruleId} deleted.` : `Rule #${ruleId} not found.`,
          success: deleted,
        });
      }
      case 'list': {
        const rules = getRules(database);
        if (rules.length === 0) {
          return formatToolResult({ message: 'No categorization rules configured.', rules: [] });
        }
        const formatted = rules.map((r) =>
          `#${r.id} [pri:${r.priority}] "${r.pattern}" → ${r.category}${r.is_regex ? ' (regex)' : ''}`
        ).join('\n');
        return formatToolResult({ rules, formatted });
      }
    }
  },
});
