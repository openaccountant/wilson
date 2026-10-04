import { initDatabase } from './db/database.js';
import { logger } from './utils/logger.js';
import { traceStore } from './utils/trace-store.js';
import { interactionStore } from './utils/interaction-store.js';
import { initImportTool } from './tools/import/csv-import.js';
import { initCategorizeTool } from './tools/categorize/categorize.js';
import { initTransactionSearchTool } from './tools/query/transaction-search.js';
import { initEditTransactionTool } from './tools/query/edit-transaction.js';
import { initDeleteTransactionTool } from './tools/query/delete-transaction.js';
import { initSpendingSummaryTool } from './tools/query/spending-summary.js';
import { initAnomalyDetectTool } from './tools/query/anomaly-detect.js';
import { initMonarchTool } from './tools/import/monarch.js';
import { initFireflyTool } from './tools/import/firefly.js';
import { initExportTool } from './tools/export/export-transactions.js';
import { initBudgetSetTool } from './tools/budget/budget-set.js';
import { initBudgetCheckTool } from './tools/budget/budget-check.js';
import { initBudgetPrompt, initDataContext, initNetWorthContext } from './agent/prompts.js';
import { initPlaidSyncTool } from './tools/import/plaid-sync.js';
import { initPlaidBalancesTool } from './tools/import/plaid-balances.js';
import { initProfitLossTool } from './tools/query/profit-loss.js';
import { initProfitDiffTool } from './tools/query/profit-diff.js';
import { initRuleManageTool } from './tools/rules/rule-manage.js';
import { initTaxFlagTool } from './tools/tax/tax-flag.js';
import { initSavingsRateTool } from './tools/query/savings-rate.js';
import { initAlertCheckTool } from './tools/query/alert-check.js';
import { initGenerateReportTool } from './tools/export/generate-report.js';
import { initAccountManageTool } from './tools/net-worth/account-manage.js';
import { initBalanceUpdateTool } from './tools/net-worth/balance-update.js';
import { initNetWorthTool } from './tools/net-worth/net-worth.js';
import { initMortgageManageTool } from './tools/net-worth/mortgage-manage.js';
import { initLinkTransactionsTool } from './tools/net-worth/link-transactions.js';
import { initCategoryManageTool } from './tools/categorize/category-manage.js';
import { initGoalManageTool } from './tools/goals/goal-manage.js';
import { initMemoryManageTool } from './tools/memory/memory-manage.js';
import { initEntityManageTool } from './tools/entity/entity-manage.js';
import { initEntityClassifyTool } from './tools/entity/entity-classify.js';
import { initGoalContext, initMemoryContext, initCustomPromptContext } from './agent/prompts.js';
import { initMcpClients, closeMcpClients } from './mcp/client.js';
import { loadMcpTools } from './mcp/adapter.js';
import { AgentRunnerController, type RunQueryResult } from './controllers/index.js';
import type { AgentConfig } from './agent/index.js';
import { InMemoryChatHistory } from './utils/in-memory-chat-history.js';
import { getConfiguredModel } from './utils/config.js';

/**
 * The agent runner for a headless run. Nobody is there to answer an approval
 * prompt, so every call that needs one (any write, see #152) is denied
 * immediately — fail closed instead of hanging on a prompt that never comes.
 * There is deliberately no auto-approve option.
 */
export function createHeadlessRunner(config: AgentConfig, history: InMemoryChatHistory): AgentRunnerController {
  return new AgentRunnerController(config, history, undefined, { approvals: 'deny' });
}

/** Explains a denied tool to the person reading headless output. */
export function headlessDenialMessage(tool: string): string {
  return (
    `Denied ${tool}: headless runs (--run) can't approve changes, so it was not run. ` +
    `Run wilson interactively to review and approve it.`
  );
}

/**
 * Print a headless run's outcome and return the exit code: the answer on
 * stdout; each denied tool, or "No response generated.", on stderr.
 */
export function reportHeadlessResult(
  result: RunQueryResult | undefined,
  runner: AgentRunnerController,
  out: { log: (msg: string) => void; error: (msg: string) => void } = console,
): number {
  if (result?.answer) out.log(result.answer);
  const denied = runner.lastDeniedTools;
  for (const tool of denied) out.error(headlessDenialMessage(tool));
  if (result?.answer && denied.length === 0) return 0;
  if (!result?.answer && denied.length === 0) {
    out.error(runner.error ? `Error: ${runner.error}` : 'No response generated.');
  }
  return 1;
}

/**
 * Run Open Accountant in headless mode — single query, no TUI, stdout output.
 * Used for cron jobs and scripted invocations.
 */
export async function runHeadless(query: string): Promise<void> {
  try {
    // Initialize database and inject into tools (same as runCli)
    const db = initDatabase();
    logger.setDatabase(db);
    traceStore.setDatabase(db);
    interactionStore.setDatabase(db);
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
    initNetWorthContext(db);
    initPlaidSyncTool(db);
    initPlaidBalancesTool(db);
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
    initGoalContext(db);
    initMemoryContext(db);
    initCustomPromptContext(db);

    await initMcpClients();
    await loadMcpTools();

    // Resolve user's saved model/provider
    const { model, provider } = getConfiguredModel();

    // Create a minimal chat history (single query, no multi-turn needed)
    const chatHistory = new InMemoryChatHistory();
    chatHistory.setDatabase(db);

    // Agent runner with the user's saved model settings; no UI, so any tool
    // call that needs approval is denied (createHeadlessRunner).
    const agentRunner = createHeadlessRunner({ model, modelProvider: provider, maxIterations: 10 }, chatHistory);

    const result = await agentRunner.runQuery(query);
    const exitCode = reportHeadlessResult(result, agentRunner);
    if (exitCode !== 0) process.exitCode = exitCode;
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  } finally {
    await closeMcpClients();
  }
}
