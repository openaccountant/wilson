import { z } from 'zod';
import type { Database } from '../../db/compat-sqlite.js';
import { defineTool } from '../define-tool.js';
import { formatToolResult } from '../types.js';
import {
  getCategories,
  getCategoryTree,
  getCategoryByName,
  addCategory,
  deleteCategory,
  type CategoryTreeNode,
} from '../../db/queries.js';

let db: Database | null = null;

export function initCategoryManageTool(database: Database): void {
  db = database;
}

function getDb(): Database {
  if (!db) {
    throw new Error('category_manage tool not initialized. Call initCategoryManageTool(database) first.');
  }
  return db;
}

function formatTree(nodes: CategoryTreeNode[], indent: number = 0): string {
  const lines: string[] = [];
  for (const node of nodes) {
    const prefix = '  '.repeat(indent);
    const system = node.is_system ? ' (system)' : '';
    const desc = node.description ? ` — ${node.description}` : '';
    lines.push(`${prefix}- ${node.name}${system}${desc}`);
    if (node.children.length > 0) {
      lines.push(formatTree(node.children, indent + 1));
    }
  }
  return lines.join('\n');
}

export const categoryManageTool = defineTool({
  name: 'category_manage',
  description:
    'Manage spending categories. Add custom categories, delete custom categories, or list all categories in a tree.',
  schema: z.object({
    action: z.enum(['add', 'delete', 'list']).describe('Action to perform'),
    name: z.string().optional().describe('Category name (for add)'),
    parentName: z.string().optional().describe('Parent category name (for add, to create a sub-category)'),
    description: z.string().optional().describe('Category description (for add)'),
    categoryId: z.number().optional().describe('Category ID (for delete)'),
  }),
  func: async ({ action, name, parentName, description, categoryId }) => {
    const database = getDb();

    switch (action) {
      case 'list': {
        const tree = getCategoryTree(database);
        const formatted = formatTree(tree);
        return formatToolResult({
          message: 'Categories:',
          tree: formatted,
          count: getCategories(database).length,
        });
      }

      case 'add': {
        if (!name) {
          return formatToolResult({ error: 'Name is required for add action' });
        }

        // Check if already exists
        const existing = getCategoryByName(database, name);
        if (existing) {
          return formatToolResult({ error: `Category "${name}" already exists` });
        }

        let parentId: number | undefined;
        if (parentName) {
          const parent = getCategoryByName(database, parentName);
          if (!parent) {
            return formatToolResult({ error: `Parent category "${parentName}" not found` });
          }
          parentId = parent.id;
        }

        const id = addCategory(database, name, parentId, description);
        return formatToolResult({
          message: parentName
            ? `Created sub-category "${name}" under "${parentName}"`
            : `Created category "${name}"`,
          id,
        });
      }

      case 'delete': {
        if (!categoryId) {
          return formatToolResult({ error: 'categoryId is required for delete action' });
        }
        const result = deleteCategory(database, categoryId);
        if (!result.ok) {
          return formatToolResult({ error: result.error });
        }
        return formatToolResult({ message: `Category #${categoryId} deleted` });
      }

      default:
        return formatToolResult({ error: `Unknown action: ${action}` });
    }
  },
});
