import type { Database } from '../db/compat-sqlite.js';
import { initImportTool } from '../tools/import/csv-import.js';
import { initCategorizeTool } from '../tools/categorize/categorize.js';
import { initTransactionSearchTool } from '../tools/query/transaction-search.js';
import { initEditTransactionTool } from '../tools/query/edit-transaction.js';
import { initDeleteTransactionTool } from '../tools/query/delete-transaction.js';
import { initSpendingSummaryTool } from '../tools/query/spending-summary.js';
import { initAnomalyDetectTool } from '../tools/query/anomaly-detect.js';
import { initMonarchTool } from '../tools/import/monarch.js';
import { initFireflyTool } from '../tools/import/firefly.js';
import { initExportTool } from '../tools/export/export-transactions.js';
import { initBudgetSetTool } from '../tools/budget/budget-set.js';
import { initBudgetCheckTool } from '../tools/budget/budget-check.js';
import { initPlaidSyncTool } from '../tools/import/plaid-sync.js';
import { initPlaidBalancesTool } from '../tools/import/plaid-balances.js';
import { initCoinbaseSyncTool } from '../tools/import/coinbase-sync.js';
import { initProfitLossTool } from '../tools/query/profit-loss.js';
import { initProfitDiffTool } from '../tools/query/profit-diff.js';
import { initRuleManageTool } from '../tools/rules/rule-manage.js';
import { initTaxFlagTool } from '../tools/tax/tax-flag.js';
import { initSavingsRateTool } from '../tools/query/savings-rate.js';
import { initAlertCheckTool } from '../tools/query/alert-check.js';
import { initGenerateReportTool } from '../tools/export/generate-report.js';
import { initAccountManageTool } from '../tools/net-worth/account-manage.js';
import { initBalanceUpdateTool } from '../tools/net-worth/balance-update.js';
import { initNetWorthTool } from '../tools/net-worth/net-worth.js';
import { initMortgageManageTool } from '../tools/net-worth/mortgage-manage.js';
import { initLinkTransactionsTool } from '../tools/net-worth/link-transactions.js';
import { initCategoryManageTool } from '../tools/categorize/category-manage.js';
import { initGoalManageTool } from '../tools/goals/goal-manage.js';
import { initMemoryManageTool } from '../tools/memory/memory-manage.js';
import { initEntityManageTool } from '../tools/entity/entity-manage.js';
import { initEntityClassifyTool } from '../tools/entity/entity-classify.js';
import {
  initBudgetPrompt,
  initDataContext,
  initAlertPrompt,
  initNetWorthContext,
  initGoalContext,
  initMemoryContext,
  initCustomPromptContext,
} from './prompts.js';

/**
 * Wire every tool and prompt-context builder to a database connection.
 *
 * Tools hold a module-level DB reference that must be injected before the agent
 * runs, or tool calls throw "… tool not initialized". The interactive CLI and
 * headless runner each do this; the dashboard chat must too, or its agent calls
 * fail and the model answers from thin air.
 */
export function initAgentTools(db: Database): void {
  initImportTool(db);
  initCategorizeTool(db);
  initTransactionSearchTool(db);
  initEditTransactionTool(db);
  initDeleteTransactionTool(db);
  initSpendingSummaryTool(db);
  initAnomalyDetectTool(db);
  initMonarchTool(db);
  initFireflyTool(db);
  initExportTool(db);
  initBudgetSetTool(db);
  initBudgetCheckTool(db);
  initBudgetPrompt(db);
  initDataContext(db);
  initPlaidSyncTool(db);
  initPlaidBalancesTool(db);
  initCoinbaseSyncTool(db);
  initProfitLossTool(db);
  initProfitDiffTool(db);
  initRuleManageTool(db);
  initTaxFlagTool(db);
  initSavingsRateTool(db);
  initAlertCheckTool(db);
  initGenerateReportTool(db);
  initAccountManageTool(db);
  initBalanceUpdateTool(db);
  initNetWorthTool(db);
  initMortgageManageTool(db);
  initLinkTransactionsTool(db);
  initCategoryManageTool(db);
  initGoalManageTool(db);
  initMemoryManageTool(db);
  initEntityManageTool(db);
  initEntityClassifyTool(db);
  initAlertPrompt(db);
  initNetWorthContext(db);
  initGoalContext(db);
  initMemoryContext(db);
  initCustomPromptContext(db);
}
