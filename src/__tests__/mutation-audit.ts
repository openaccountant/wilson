import type { ToolDef } from '../model/types.js';
import { csvImportTool } from '../tools/import/csv-import.js';
import { monarchImportTool } from '../tools/import/monarch.js';
import { fireflyImportTool } from '../tools/import/firefly.js';
import { plaidSyncTool } from '../tools/import/plaid-sync.js';
import { plaidBalancesTool } from '../tools/import/plaid-balances.js';
import { plaidRecurringTool } from '../tools/import/plaid-recurring.js';
import { coinbaseSyncTool } from '../tools/import/coinbase-sync.js';
import { categorizeTool } from '../tools/categorize/categorize.js';
import { categoryManageTool } from '../tools/categorize/category-manage.js';
import { goalManageTool } from '../tools/goals/goal-manage.js';
import { memoryManageTool } from '../tools/memory/memory-manage.js';
import { entityManageTool } from '../tools/entity/entity-manage.js';
import { entityClassifyTool } from '../tools/entity/entity-classify.js';
import { transactionSearchTool } from '../tools/query/transaction-search.js';
import { editTransactionTool } from '../tools/query/edit-transaction.js';
import { deleteTransactionTool } from '../tools/query/delete-transaction.js';
import { spendingSummaryTool } from '../tools/query/spending-summary.js';
import { anomalyDetectTool } from '../tools/query/anomaly-detect.js';
import { profitLossTool } from '../tools/query/profit-loss.js';
import { profitDiffTool } from '../tools/query/profit-diff.js';
import { savingsRateTool } from '../tools/query/savings-rate.js';
import { alertCheckTool } from '../tools/query/alert-check.js';
import { exportTransactionsTool } from '../tools/export/export-transactions.js';
import { generateReportTool } from '../tools/export/generate-report.js';
import { budgetSetTool } from '../tools/budget/budget-set.js';
import { budgetCheckTool } from '../tools/budget/budget-check.js';
import { ruleManageTool } from '../tools/rules/rule-manage.js';
import { taxFlagTool } from '../tools/tax/tax-flag.js';
import { accountManageTool } from '../tools/net-worth/account-manage.js';
import { balanceUpdateTool } from '../tools/net-worth/balance-update.js';
import { netWorthTool } from '../tools/net-worth/net-worth.js';
import { mortgageManageTool } from '../tools/net-worth/mortgage-manage.js';
import { linkTransactionsTool } from '../tools/net-worth/link-transactions.js';
import { exaSearch } from '../tools/search/exa.js';
import { perplexitySearch } from '../tools/search/perplexity.js';
import { tavilySearch } from '../tools/search/tavily.js';
import { braveSearch } from '../tools/search/brave.js';
import { skillTool } from '../tools/skill.js';

/**
 * Static audit of every agent tool (#152). Each entry pins whether a call
 * writes to the DB, the filesystem, or an external service. A new tool must be
 * added to exactly one of these tables (see the registry coverage test in
 * tool-registry.test.ts), so nothing can write without being flagged.
 */

/** Always mutating, whatever the args. */
export const ALWAYS_MUTATING: Array<[ToolDef, Record<string, unknown>]> = [
  [csvImportTool, { path: '/tmp/x.csv' }],
  [monarchImportTool, {}],
  [fireflyImportTool, {}],
  [plaidSyncTool, {}],
  [plaidBalancesTool, {}],
  [coinbaseSyncTool, {}],
  [categorizeTool, {}],
  [editTransactionTool, { id: 1, category: 'Dining' }],
  [deleteTransactionTool, { id: 1 }],
  [budgetSetTool, { category: 'Dining', monthlyLimit: 200 }],
  [balanceUpdateTool, { accountId: 1, balance: 10 }],
  [exportTransactionsTool, { format: 'csv', filePath: '/tmp/x.csv' }],
  [generateReportTool, { filePath: '/tmp/x.md' }],
];

/** Mutating for the listed write calls, read-only for the listed read calls. */
export const CONDITIONALLY_MUTATING: Array<{
  tool: ToolDef;
  writes: Record<string, unknown>[];
  reads: Record<string, unknown>[];
}> = [
  { tool: categoryManageTool, writes: [{ action: 'add', name: 'X' }, { action: 'delete', categoryId: 1 }], reads: [{ action: 'list' }] },
  {
    tool: goalManageTool,
    writes: ['add', 'update', 'progress', 'complete', 'pause', 'abandon'].map((action) => ({ action })),
    reads: [{ action: 'list' }],
  },
  { tool: memoryManageTool, writes: [{ action: 'add' }, { action: 'deactivate' }], reads: [{ action: 'list' }, { action: 'search' }] },
  {
    tool: entityManageTool,
    writes: ['add', 'update', 'delete', 'assign'].map((action) => ({ action })),
    reads: [{ action: 'list' }],
  },
  { tool: entityClassifyTool, writes: [{}, { dryRun: false }], reads: [{ dryRun: true }] },
  { tool: ruleManageTool, writes: ['add', 'update', 'delete'].map((action) => ({ action })), reads: [{ action: 'list' }] },
  { tool: taxFlagTool, writes: ['flag', 'unflag', 'export'].map((action) => ({ action })), reads: [{ action: 'summary' }, { action: 'list' }] },
  { tool: accountManageTool, writes: ['add', 'update', 'remove'].map((action) => ({ action })), reads: [{ action: 'list' }] },
  {
    tool: mortgageManageTool,
    writes: [{ action: 'add' }, { action: 'update' }],
    reads: ['schedule', 'summary', 'payoff'].map((action) => ({ action })),
  },
  { tool: linkTransactionsTool, writes: [{ accountId: 1 }, { accountId: 1, dryRun: false }], reads: [{ accountId: 1, dryRun: true }] },
];

/** Never mutating. */
export const READ_ONLY: ToolDef[] = [
  transactionSearchTool,
  spendingSummaryTool,
  anomalyDetectTool,
  profitLossTool,
  profitDiffTool,
  savingsRateTool,
  alertCheckTool,
  budgetCheckTool,
  netWorthTool,
  plaidRecurringTool,
  exaSearch,
  perplexitySearch,
  tavilySearch,
  braveSearch,
  skillTool,
];

export const MUTATING_TOOL_NAMES = [
  ...ALWAYS_MUTATING.map(([t]) => t.name),
  ...CONDITIONALLY_MUTATING.map((c) => c.tool.name),
].sort();

export const READ_ONLY_TOOL_NAMES = [...new Set(READ_ONLY.map((t) => t.name))].sort();
