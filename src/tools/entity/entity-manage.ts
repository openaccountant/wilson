import { z } from 'zod';
import type { Database } from '../../db/compat-sqlite.js';
import { defineTool } from '../define-tool.js';
import { formatToolResult } from '../types.js';
import {
  getEntities,
  getEntityById,
  createEntity,
  updateEntity,
  deleteEntity,
  assignEntityToTransactions,
  assignEntityToAccount,
} from '../../db/entity-queries.js';

let db: Database | null = null;

export function initEntityManageTool(database: Database): void {
  db = database;
}

function getDb(): Database {
  if (!db) {
    throw new Error('entity_manage tool not initialized. Call initEntityManageTool(database) first.');
  }
  return db;
}

export const entityManageTool = defineTool({
  name: 'entity_manage',
  description:
    'Manage business entities — list, add, update, delete, or assign transactions/accounts to an entity.',
  schema: z.object({
    action: z.enum(['list', 'add', 'update', 'delete', 'assign']).describe('Action to perform'),
    name: z.string().optional().describe('Entity name (for add)'),
    description: z.string().optional().describe('Entity description (for add/update)'),
    color: z.string().optional().describe('Entity color hex (for add/update, default #22c55e)'),
    entityId: z.number().optional().describe('Entity ID (for update/delete/assign)'),
    transactionIds: z.array(z.number()).optional().describe('Transaction IDs to assign (for assign action)'),
    accountId: z.number().optional().describe('Account ID to assign (for assign action)'),
  }),
  func: async ({ action, name, description, color, entityId, transactionIds, accountId }) => {
    const database = getDb();

    switch (action) {
      case 'list': {
        const entities = getEntities(database);
        if (entities.length === 0) {
          return formatToolResult({ message: 'No entities found.', entities: [] });
        }
        const formatted = entities.map((e) => ({
          id: e.id,
          name: e.name,
          slug: e.slug,
          description: e.description,
          color: e.color,
          isDefault: !!e.is_default,
        }));
        return formatToolResult({ message: `${entities.length} entities`, entities: formatted });
      }

      case 'add': {
        if (!name) {
          return formatToolResult({ error: 'Name is required for add action' });
        }
        try {
          const id = createEntity(database, { name, description, color });
          return formatToolResult({ message: `Created entity "${name}"`, id });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes('UNIQUE constraint')) {
            return formatToolResult({ error: `Entity "${name}" already exists` });
          }
          return formatToolResult({ error: msg });
        }
      }

      case 'update': {
        if (!entityId) {
          return formatToolResult({ error: 'entityId is required for update action' });
        }
        const updates: { name?: string; description?: string; color?: string } = {};
        if (name !== undefined) updates.name = name;
        if (description !== undefined) updates.description = description;
        if (color !== undefined) updates.color = color;
        const success = updateEntity(database, entityId, updates);
        if (!success) {
          return formatToolResult({ error: `Entity #${entityId} not found or no changes` });
        }
        return formatToolResult({ message: `Updated entity #${entityId}` });
      }

      case 'delete': {
        if (!entityId) {
          return formatToolResult({ error: 'entityId is required for delete action' });
        }
        const result = deleteEntity(database, entityId);
        if (!result.ok) {
          return formatToolResult({ error: result.error });
        }
        return formatToolResult({ message: `Deleted entity #${entityId}` });
      }

      case 'assign': {
        if (!entityId) {
          return formatToolResult({ error: 'entityId is required for assign action' });
        }
        // Verify entity exists
        const entity = getEntityById(database, entityId);
        if (!entity) {
          return formatToolResult({ error: `Entity #${entityId} not found` });
        }

        const results: string[] = [];

        if (transactionIds && transactionIds.length > 0) {
          const count = assignEntityToTransactions(database, entityId, transactionIds);
          results.push(`Assigned ${count} transactions to "${entity.name}"`);
        }

        if (accountId !== undefined) {
          const success = assignEntityToAccount(database, entityId, accountId);
          results.push(
            success
              ? `Assigned account #${accountId} to "${entity.name}"`
              : `Account #${accountId} not found`
          );
        }

        if (results.length === 0) {
          return formatToolResult({ error: 'Provide transactionIds or accountId to assign' });
        }

        return formatToolResult({ message: results.join('. ') });
      }

      default:
        return formatToolResult({ error: `Unknown action: ${action}` });
    }
  },
});
