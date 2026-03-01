import { initDatabase } from './db/database.js';
import { initImportTool } from './tools/import/csv-import.js';
import { initCategorizeTool } from './tools/categorize/categorize.js';
import { initTransactionSearchTool } from './tools/query/transaction-search.js';
import { initSpendingSummaryTool } from './tools/query/spending-summary.js';
import { initAnomalyDetectTool } from './tools/query/anomaly-detect.js';
import { initMonarchTool } from './tools/import/monarch.js';
import { initExportTool } from './tools/export/export-transactions.js';
import { initBudgetSetTool } from './tools/budget/budget-set.js';
import { initBudgetCheckTool } from './tools/budget/budget-check.js';
import { initBudgetPrompt } from './agent/prompts.js';
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

/**
 * Run Wilson in headless mode — single query, no TUI, stdout output.
 * Used for cron jobs and scripted invocations.
 */
export async function runHeadless(query: string): Promise<void> {
  try {
    // Initialize database and inject into tools (same as runCli)
    const db = initDatabase();
    initImportTool(db);
    initCategorizeTool(db);
    initTransactionSearchTool(db);
    initSpendingSummaryTool(db);
    initAnomalyDetectTool(db);
    initMonarchTool(db);
    initExportTool(db);
    initBudgetSetTool(db);
    initBudgetCheckTool(db);
    initBudgetPrompt(db);
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

    // Create a minimal chat history (single query, no multi-turn needed)
    const chatHistory = new InMemoryChatHistory();

    // Create agent runner with default model settings (no TUI callbacks)
    const agentRunner = new AgentRunnerController(
      { maxIterations: 10 },
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
