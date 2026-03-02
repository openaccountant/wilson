import { z } from 'zod';
import { defineTool } from '../define-tool.js';
import { formatToolResult } from '../types.js';
import type { Database } from '../../db/compat-sqlite.js';
import {
  insertAccount,
  updateAccount,
  deactivateAccount,
  getAccounts,
  getAccountById,
} from '../../db/net-worth-queries.js';
import {
  ACCOUNT_SUBTYPES,
  getAccountTypeForSubtype,
  SUBTYPE_LABELS,
  type AccountSubtype,
} from './account-types.js';

let db: Database;

export function initAccountManageTool(database: Database) {
  db = database;
}

export const accountManageTool = defineTool({
  name: 'account_manage',
  description: 'Add, update, remove, or list financial accounts (checking, savings, real estate, loans, etc.)',
  schema: z.object({
    action: z.enum(['add', 'update', 'remove', 'list']).describe('Action to perform'),
    name: z.string().optional().describe('Account name (required for add)'),
    accountSubtype: z.enum(ACCOUNT_SUBTYPES as unknown as [string, ...string[]]).optional()
      .describe('Account subtype (required for add)'),
    institution: z.string().optional().describe('Bank/institution name'),
    accountNumberLast4: z.string().optional().describe('Last 4 digits of account number'),
    currentBalance: z.number().optional().describe('Current balance (always positive)'),
    notes: z.string().optional().describe('Notes about this account'),
    accountId: z.number().optional().describe('Account ID (required for update/remove)'),
    type: z.enum(['asset', 'liability']).optional().describe('Filter by type (for list)'),
  }),
  func: async (args) => {
    switch (args.action) {
      case 'add': {
        if (!args.name) return formatToolResult({ error: 'name is required for add' });
        if (!args.accountSubtype) return formatToolResult({ error: 'accountSubtype is required for add' });

        const subtype = args.accountSubtype as AccountSubtype;
        const accountType = getAccountTypeForSubtype(subtype);

        const id = insertAccount(db, {
          name: args.name,
          account_type: accountType,
          account_subtype: subtype,
          institution: args.institution,
          account_number_last4: args.accountNumberLast4,
          current_balance: args.currentBalance,
          notes: args.notes,
        });

        const account = getAccountById(db, id);
        return formatToolResult({
          message: `Account #${id} created: ${args.name} (${SUBTYPE_LABELS[subtype]})`,
          account,
        });
      }

      case 'update': {
        if (!args.accountId) return formatToolResult({ error: 'accountId is required for update' });
        const updated = updateAccount(db, args.accountId, {
          name: args.name,
          institution: args.institution,
          account_number_last4: args.accountNumberLast4,
          current_balance: args.currentBalance,
          notes: args.notes,
        });
        if (!updated) return formatToolResult({ error: `Account #${args.accountId} not found` });
        const account = getAccountById(db, args.accountId);
        return formatToolResult({ message: `Account #${args.accountId} updated`, account });
      }

      case 'remove': {
        if (!args.accountId) return formatToolResult({ error: 'accountId is required for remove' });
        const removed = deactivateAccount(db, args.accountId);
        if (!removed) return formatToolResult({ error: `Account #${args.accountId} not found` });
        return formatToolResult({ message: `Account #${args.accountId} deactivated` });
      }

      case 'list': {
        const accounts = getAccounts(db, {
          type: args.type,
          active: true,
        });
        return formatToolResult({
          count: accounts.length,
          accounts: accounts.map((a) => ({
            id: a.id,
            name: a.name,
            type: a.account_type,
            subtype: a.account_subtype,
            institution: a.institution,
            balance: a.current_balance,
          })),
        });
      }

      default:
        return formatToolResult({ error: `Unknown action: ${args.action}` });
    }
  },
});
