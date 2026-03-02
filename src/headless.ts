import { initDatabase } from './db/database.js';
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
import { initBudgetPrompt, initDataContext } from './agent/prompts.js';
import { initPlaidSyncTool } from './tools/import/plaid-sync.js';
import { initProfitLossTool } from './tools/query/profit-loss.js';
import { initProfitDiffTool } from './tools/query/profit-diff.js';
import { initRuleManageTool } from './tools/rules/rule-manage.js';
import { initTaxFlagTool } from './tools/tax/tax-flag.js';
import { initSavingsRateTool } from './tools/query/savings-rate.js';
import { initAlertCheckTool } from './tools/query/alert-check.js';
import { initGenerateReportTool } from './tools/export/generate-report.js';
import { initMcpClients, closeMcpClients } from './mcp/client.js';
import { loadMcpTools } from './mcp/adapter.js';
import { AgentRunnerController } from './controllers/index.js';
import { InMemoryChatHistory } from './utils/in-memory-chat-history.js';
import { getConfiguredModel } from './utils/config.js';

/**
 * Run Open Accountant in headless mode — single query, no TUI, stdout output.
 * Used for cron jobs and scripted invocations.
 */
export async function runHeadless(query: string): Promise<void> {
  try {
    // Initialize database and inject into tools (same as runCli)
    const db = initDatabase();
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
    initProfitLossTool(db);
    initProfitDiffTool(db);
    initRuleManageTool(db);
    initTaxFlagTool(db);
    initSavingsRateTool(db);
    initAlertCheckTool(db);
    initGenerateReportTool(db);

    await initMcpClients();
    await loadMcpTools();

    // Resolve user's saved model/provider
    const { model, provider } = getConfiguredModel();

    // Create a minimal chat history (single query, no multi-turn needed)
    const chatHistory = new InMemoryChatHistory();
    chatHistory.setDatabase(db);

    // Create agent runner with user's saved model settings (no TUI callbacks)
    const agentRunner = new AgentRunnerController(
      { model, modelProvider: provider, maxIterations: 10 },
      chatHistory,
    );

    // Run the query
    const result = await agentRunner.runQuery(query);

    if (result?.answer) {
      console.log(result.answer);
    } else {
      console.error('No response generated.');
      process.exitCode = 1;
    }
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  } finally {
    await closeMcpClients();
  }
}
