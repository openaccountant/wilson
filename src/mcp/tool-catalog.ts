/**
 * The v1 WebMCP tool catalog: the exact set of capabilities exposed to
 * browser agents, shared verbatim by both transports (the in-page
 * `document.modelContext.registerTool` bridge and the Streamable-HTTP
 * `/mcp` fallback) so "WebMCP exposes dashboard capabilities as tools" is
 * true of one definition, not two that can drift apart.
 *
 * Mutating tools never write directly — see prepareMutation/commitMutation.
 * Read tools execute immediately once a grant is validated.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Database } from '../db/compat-sqlite.js';
import {
  getTransactionById,
  updateTransaction,
  flagTaxDeduction,
  unflagTaxDeduction,
  getTaxSummary,
  getTaxDeductions,
} from '../db/queries.js';
import { transactionSearchTool } from '../tools/query/transaction-search.js';
import { spendingSummaryTool } from '../tools/query/spending-summary.js';
import { profitLossTool } from '../tools/query/profit-loss.js';
import { netWorthTool } from '../tools/net-worth/net-worth.js';
import { computeForecast } from '../tools/query/forecast.js';

// ── Catalog definition ───────────────────────────────────────────────────────
//
// The zod shape is the single source of truth: it's both the raw shape the
// MCP Streamable-HTTP server registers tools with, and (via z.toJSONSchema)
// the JSON Schema the in-page WebMCP bridge hands to
// `document.modelContext.registerTool`. One definition, two transports.

export type ToolClassification = 'read' | 'mutating';

export interface McpToolDef {
  name: string;
  description: string;
  /** Raw zod shape (not a ZodObject) — what @modelcontextprotocol/sdk's registerTool expects. */
  zodShape: Record<string, z.ZodTypeAny>;
  classification: ToolClassification;
}

const whatIfShape = z.object({
  type: z.enum(['adjust_category', 'drop_recurring']),
  category: z.string().optional().describe('Category to adjust (adjust_category)'),
  monthlyDelta: z.number().optional().describe('Signed change to monthly spend (adjust_category)'),
  description: z.string().optional().describe('Description substring to match (drop_recurring)'),
});

export const MCP_TOOL_CATALOG: McpToolDef[] = [
  {
    name: 'categorize_transaction',
    description: 'Assign a category (and optionally an entity) to a single transaction by ID.',
    classification: 'mutating',
    zodShape: {
      id: z.number().describe('Transaction ID'),
      category: z.string().describe('New category name'),
      entityId: z.number().optional().describe('Optional entity ID to assign'),
    },
  },
  {
    name: 'tax_flag',
    description:
      'Flag or unflag a transaction as tax-deductible with an IRS Schedule C category, or read a tax summary/list. ' +
      'flag/unflag require confirmation; summary/list execute immediately.',
    classification: 'mutating',
    zodShape: {
      action: z.enum(['flag', 'unflag', 'summary', 'list']),
      transactionId: z.number().optional().describe('Transaction ID (for flag/unflag)'),
      irsCategory: z.string().optional().describe('IRS Schedule C category (for flag)'),
      taxYear: z.number().optional().describe('Tax year (default: current year)'),
      notes: z.string().optional().describe('Optional notes'),
    },
  },
  {
    name: 'edit_transaction',
    description: 'Edit a transaction by ID: date, description, amount, category, or notes.',
    classification: 'mutating',
    zodShape: {
      id: z.number().describe('Transaction ID to edit'),
      date: z.string().optional().describe('New date (YYYY-MM-DD)'),
      description: z.string().optional().describe('New description'),
      amount: z.number().optional().describe('New amount (negative=expense, positive=income)'),
      category: z.string().optional().describe('New category'),
      notes: z.string().optional().describe('New notes'),
    },
  },
  {
    name: 'transaction_search',
    description: 'Search transactions using a natural language query.',
    classification: 'read',
    zodShape: {
      query: z.string().describe('Natural language query about transactions'),
    },
  },
  {
    name: 'spending_summary',
    description: 'Spending breakdown by category for the current month, quarter, or year.',
    classification: 'read',
    zodShape: {
      period: z.enum(['month', 'quarter', 'year']).optional(),
      compareWithPrevious: z.boolean().optional(),
    },
  },
  {
    name: 'profit_loss',
    description: 'Profit & loss report: income vs. expenses by category for a given period.',
    classification: 'read',
    zodShape: {
      period: z.enum(['month', 'quarter', 'year']).optional(),
      offset: z.number().optional().describe('0 = current period, -1 = previous, etc.'),
    },
  },
  {
    name: 'net_worth',
    description: 'Net worth summary, trend over time, or full balance sheet.',
    classification: 'read',
    zodShape: {
      action: z.enum(['summary', 'trend', 'balance_sheet']),
      months: z.number().optional().describe('Number of months for trend (default 12)'),
    },
  },
  {
    name: 'forecast',
    description:
      "Trailing-rate projection of end-of-period cash/savings, with optional what-if adjustments " +
      "(adjust a category's monthly spend, or drop a recurring expense).",
    classification: 'read',
    zodShape: {
      trailingMonths: z.number().optional().describe('Lookback window in months (default 3)'),
      horizonMonths: z.number().optional().describe('Projection horizon in months (default 3)'),
      whatIf: z.array(whatIfShape).optional(),
    },
  },
];

const CATALOG_BY_NAME = new Map(MCP_TOOL_CATALOG.map((t) => [t.name, t]));

export function getToolDef(name: string): McpToolDef | undefined {
  return CATALOG_BY_NAME.get(name);
}

/** JSON Schema for the WebMCP `document.modelContext.registerTool` inputSchema field. */
export function jsonSchemaFor(name: string): unknown {
  const def = getToolDef(name);
  if (!def) return undefined;
  return z.toJSONSchema(z.object(def.zodShape));
}

/** Bound into every grant; a schema edit invalidates every grant issued against the old shape. */
export function schemaDigest(name: string): string {
  const schema = jsonSchemaFor(name);
  if (!schema) return '';
  return createHash('sha256').update(JSON.stringify(schema)).digest('hex').slice(0, 16);
}

/** tax_flag is read-only for summary/list and mutating for flag/unflag — everything else is static. */
export function isMutatingCall(toolName: string, args: Record<string, unknown>): boolean {
  const def = getToolDef(toolName);
  if (!def) return false;
  if (def.classification === 'read') return false;
  if (toolName === 'tax_flag') {
    return args.action === 'flag' || args.action === 'unflag';
  }
  return true;
}

// ── Read execution ───────────────────────────────────────────────────────────

export class ToolNotFoundError extends Error {}

async function callFunc(toolFunc: (args: any) => Promise<string>, args: Record<string, unknown>): Promise<unknown> {
  const raw = await toolFunc(args);
  try {
    return JSON.parse(raw).data;
  } catch {
    return raw;
  }
}

export async function executeRead(db: Database, toolName: string, args: Record<string, unknown>): Promise<unknown> {
  switch (toolName) {
    case 'transaction_search':
      return callFunc(transactionSearchTool.func, args as any);
    case 'spending_summary':
      return callFunc(spendingSummaryTool.func, args as any);
    case 'profit_loss':
      return callFunc(profitLossTool.func, args as any);
    case 'net_worth':
      return callFunc(netWorthTool.func, args as any);
    case 'forecast':
      return computeForecast(db, args as any);
    case 'tax_flag': {
      const action = args.action as string;
      const year = (args.taxYear as number) ?? new Date().getFullYear();
      if (action === 'summary') return { taxYear: year, summary: getTaxSummary(db, year) };
      if (action === 'list') return { taxYear: year, deductions: getTaxDeductions(db, year, args.irsCategory as string | undefined) };
      throw new ToolNotFoundError(`tax_flag action "${action}" is not a read action`);
    }
    default:
      throw new ToolNotFoundError(`"${toolName}" is not a read-only tool`);
  }
}

// ── Mutation prepare/commit ──────────────────────────────────────────────────

export interface PreparedMutation {
  transactionId: number | null;
  revision: number | null;
  before: unknown;
  after: unknown;
  summary: string;
}

export class PrepareError extends Error {}

function getTaxDeductionByTransaction(db: Database, transactionId: number) {
  return db.prepare('SELECT * FROM tax_deductions WHERE transaction_id = @transactionId').get({ transactionId }) as
    | { irs_category: string; tax_year: number; notes: string | null }
    | undefined;
}

/**
 * Resolve the current record and compute the exact before/after delta the
 * confirmation UI renders — never agent-provided prose. Throws PrepareError
 * for a caller mistake (unknown tool/action, missing required field); throws
 * nothing for "row not found" so callers can render that as part of the card.
 */
export function prepareMutation(db: Database, toolName: string, args: Record<string, unknown>): PreparedMutation {
  if (toolName === 'categorize_transaction') {
    const id = args.id as number;
    const txn = getTransactionById(db, id);
    if (!txn) {
      return { transactionId: id, revision: null, before: null, after: null, summary: `Transaction #${id} not found` };
    }
    const entityId = (args.entityId as number | undefined) ?? txn.entity_id ?? undefined;
    return {
      transactionId: id,
      revision: txn.revision,
      before: { category: txn.category, entity_id: txn.entity_id },
      after: { category: args.category, entity_id: entityId ?? null },
      summary: `Categorize "${txn.description}" (${txn.date}) as "${args.category}"`,
    };
  }

  if (toolName === 'edit_transaction') {
    const id = args.id as number;
    const txn = getTransactionById(db, id);
    if (!txn) {
      return { transactionId: id, revision: null, before: null, after: null, summary: `Transaction #${id} not found` };
    }
    const fields = ['date', 'description', 'amount', 'category', 'notes'] as const;
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    for (const field of fields) {
      if (args[field] !== undefined) {
        before[field] = (txn as unknown as Record<string, unknown>)[field];
        after[field] = args[field];
      }
    }
    if (Object.keys(after).length === 0) {
      throw new PrepareError('No fields to update.');
    }
    return {
      transactionId: id,
      revision: txn.revision,
      before,
      after,
      summary: `Edit transaction #${id}: ${txn.description}`,
    };
  }

  if (toolName === 'tax_flag') {
    const action = args.action as string;
    const transactionId = args.transactionId as number;
    if (action !== 'flag' && action !== 'unflag') {
      throw new PrepareError(`tax_flag action "${action}" does not require confirmation`);
    }
    const txn = getTransactionById(db, transactionId);
    if (!txn) {
      return { transactionId, revision: null, before: null, after: null, summary: `Transaction #${transactionId} not found` };
    }
    const existing = getTaxDeductionByTransaction(db, transactionId);
    const year = (args.taxYear as number) ?? new Date().getFullYear();
    if (action === 'flag') {
      return {
        transactionId,
        revision: txn.revision,
        before: existing ?? null,
        after: { irs_category: args.irsCategory, tax_year: year, notes: (args.notes as string) ?? null },
        summary: `Flag "${txn.description}" (${txn.date}) as tax-deductible: ${args.irsCategory}`,
      };
    }
    return {
      transactionId,
      revision: txn.revision,
      before: existing ?? null,
      after: null,
      summary: `Remove tax-deduction flag from "${txn.description}" (${txn.date})`,
    };
  }

  throw new PrepareError(`"${toolName}" has no prepare step`);
}

export type CommitOutcome = 'committed' | 'stale' | 'unknown';

export interface CommitResult {
  outcome: CommitOutcome;
  after?: unknown;
}

/**
 * Apply the mutation with a revision precondition. Never called without a
 * consumed one-shot approval token — see src/mcp/store.ts. Returns 'stale'
 * (not an exception) when the row moved since prepare, so callers can
 * surface it as a typed outcome rather than a generic error.
 */
export function commitMutation(
  db: Database,
  toolName: string,
  args: Record<string, unknown>,
  expectedRevision: number | null
): CommitResult {
  try {
    if (toolName === 'categorize_transaction') {
      const id = args.id as number;
      const entityId = (args.entityId as number | undefined) ?? null;
      const ok = updateTransaction(db, id, { category: args.category as string, entity_id: entityId }, expectedRevision ?? undefined);
      if (!ok) return { outcome: 'stale' };
      return { outcome: 'committed', after: getTransactionById(db, id) };
    }

    if (toolName === 'edit_transaction') {
      const id = args.id as number;
      const fields = ['date', 'description', 'amount', 'category', 'notes'] as const;
      const updates: Record<string, unknown> = {};
      for (const field of fields) {
        if (args[field] !== undefined) updates[field] = args[field];
      }
      const ok = updateTransaction(db, id, updates, expectedRevision ?? undefined);
      if (!ok) return { outcome: 'stale' };
      return { outcome: 'committed', after: getTransactionById(db, id) };
    }

    if (toolName === 'tax_flag') {
      const action = args.action as string;
      const transactionId = args.transactionId as number;
      // tax_deductions has no revision column (out of the ALTER-only scope for this migration);
      // the transaction row itself is what we guard against disappearing mid-approval.
      const txn = getTransactionById(db, transactionId);
      if (!txn || (expectedRevision !== null && txn.revision !== expectedRevision)) {
        return { outcome: 'stale' };
      }
      if (action === 'flag') {
        const year = (args.taxYear as number) ?? new Date().getFullYear();
        flagTaxDeduction(db, transactionId, args.irsCategory as string, year, args.notes as string | undefined);
        return { outcome: 'committed', after: getTaxDeductionByTransaction(db, transactionId) ?? null };
      }
      unflagTaxDeduction(db, transactionId);
      return { outcome: 'committed', after: null };
    }

    return { outcome: 'unknown' };
  } catch {
    return { outcome: 'unknown' };
  }
}
