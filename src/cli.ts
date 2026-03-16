import {
  Container,
  ProcessTerminal,
  Spacer,
  Text,
  TUI,
  CombinedAutocompleteProvider,
} from '@mariozechner/pi-tui';
import type { SlashCommand } from '@mariozechner/pi-tui';
import { execFileSync } from 'child_process';
import type {
  AgentEvent,
  ApprovalDecision,
  DoneEvent,
  ToolEndEvent,
  ToolErrorEvent,
  ToolStartEvent,
} from './agent/index.js';
import { getModelDisplayName } from './utils/model.js';
import { getApiKeyNameForProvider, getProviderDisplayName } from './utils/env.js';
import type { DisplayEvent } from './agent/types.js';
import { logger } from './utils/logger.js';
import { traceStore } from './utils/trace-store.js';
import { interactionStore } from './utils/interaction-store.js';
import {
  AgentRunnerController,
  InputHistoryController,
  ModelSelectionController,
} from './controllers/index.js';
import {
  ApiKeyInputComponent,
  ApprovalPromptComponent,
  ChatLogComponent,
  ContextHintsComponent,
  CustomEditor,
  DebugPanelComponent,
  IntroComponent,
  WorkingIndicatorComponent,
  createApiKeyConfirmSelector,
  createDownloadConfirmSelector,
  createModelSelector,
  createProviderSelector,
} from './components/index.js';
import { editorTheme, theme } from './theme.js';
import { initDatabase } from './db/database.js';
import { initImportTool, csvImportTool } from './tools/import/csv-import.js';
import { initCategorizeTool, categorizeTool } from './tools/categorize/categorize.js';
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
import { setBudget, clearBudget, getBudgetVsActual, getCategoryTree, getCategoryByName, addCategory, deleteCategory, getCategories, type CategoryTreeNode } from './db/queries.js';
import { initBudgetPrompt, initDataContext } from './agent/prompts.js';
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
import { initAlertPrompt, initNetWorthContext, initGoalContext, initMemoryContext, initCustomPromptContext } from './agent/prompts.js';
import { getPlaidItems, removePlaidItem, findPlaidItem, isReauthRequired } from './plaid/store.js';
import { startPlaidLinkServer, startPlaidLinkUpdateServer } from './plaid/link-server.js';
import { removeItem as plaidRemoveItem } from './plaid/client.js';
import { getCoinbaseConnections, removeCoinbaseConnection, saveCoinbaseConnection } from './coinbase/store.js';
import { hasLocalCoinbaseCreds, validateCoinbaseKey } from './coinbase/client.js';
import { initCoinbaseSyncTool } from './tools/import/coinbase-sync.js';
import { initMcpClients } from './mcp/client.js';
import { loadMcpTools } from './mcp/adapter.js';
import { pullOllamaModel, RECOMMENDED_OLLAMA_MODELS } from './utils/model-downloader.js';
import { discoverSkills } from './skills/registry.js';
import { validateLicense, getLicenseInfo, deactivateLicense, hasLicense } from './licensing/license.js';
import { clearOrchestrationCache } from './orchestration/registry.js';
import { interactiveUpsell, getCheckoutUrl } from './licensing/upsell.js';
import { openBrowser } from './utils/browser.js';
import { getSchedules, addSchedule, removeSchedule, toggleSchedule } from './schedule/store.js';
import { syncCrontab } from './schedule/cron.js';
import { getActiveProfileName, listProfiles, DEFAULT_PROFILE } from './profile/index.js';

function truncateAtWord(str: string, maxLength: number): string {
  if (str.length <= maxLength) {
    return str;
  }
  const lastSpace = str.lastIndexOf(' ', maxLength);
  if (lastSpace > maxLength * 0.5) {
    return `${str.slice(0, lastSpace)}...`;
  }
  return `${str.slice(0, maxLength)}...`;
}

function summarizeToolResult(tool: string, args: Record<string, unknown>, result: string): string {
  if (tool === 'skill') {
    const skillName = args.skill as string;
    return `Loaded ${skillName} skill`;
  }
  try {
    const parsed = JSON.parse(result);
    if (parsed.data) {
      if (Array.isArray(parsed.data)) {
        return `Received ${parsed.data.length} items`;
      }
      if (typeof parsed.data === 'object') {
        const keys = Object.keys(parsed.data).filter((key) => !key.startsWith('_'));
        if (tool === 'csv_import' || tool === 'monarch_import' || tool === 'firefly_import') {
          const count = parsed.data.transactionsImported ?? parsed.data.transaction_count;
          if (count !== undefined) {
            return `Imported ${count} transactions`;
          }
          return 'Imported transactions';
        }
        if (tool === 'categorize') {
          const count = parsed.data.categorizedCount ?? parsed.data.count;
          if (count !== undefined) {
            return `Categorized ${count} transactions`;
          }
          return 'Categorized transactions';
        }
        if (tool === 'transaction_search') {
          if (parsed.data.transactions && Array.isArray(parsed.data.transactions)) {
            return `Found ${parsed.data.transactions.length} transactions`;
          }
          if (parsed.data.count !== undefined) {
            return `Found ${parsed.data.count} transactions`;
          }
          return 'Found transactions';
        }
        if (tool === 'spending_summary') {
          return 'Generated spending report';
        }
        if (tool === 'anomaly_detect') {
          if (parsed.data.anomalies && Array.isArray(parsed.data.anomalies)) {
            return `Detected ${parsed.data.anomalies.length} anomalies`;
          }
          if (parsed.data.count !== undefined) {
            return `Detected ${parsed.data.count} anomalies`;
          }
          return 'Scanned for anomalies';
        }
        if (tool === 'export_transactions') {
          const count = parsed.data.transactionsExported;
          if (count !== undefined) {
            return `Exported ${count} transactions`;
          }
          return 'Exported transactions';
        }
        if (tool === 'web_search') {
          return 'Did 1 search';
        }
        return `Received ${keys.length} fields`;
      }
    }
  } catch {
    return truncateAtWord(result, 50);
  }
  return 'Received data';
}

function createScreen(
  title: string,
  description: string,
  body: any,
  footer?: string,
): Container {
  const container = new Container();
  if (title) {
    container.addChild(new Text(theme.bold(theme.primary(title)), 0, 0));
  }
  if (description) {
    container.addChild(new Text(theme.muted(description), 0, 0));
  }
  container.addChild(new Spacer(1));
  container.addChild(body);
  if (footer) {
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.muted(footer), 0, 0));
  }
  return container;
}

function renderHistory(chatLog: ChatLogComponent, history: AgentRunnerController['history']) {
  chatLog.clearAll();
  for (const item of history) {
    chatLog.addQuery(item.query);
    chatLog.resetToolGrouping();

    if (item.status === 'interrupted') {
      chatLog.addInterrupted();
    }

    for (const display of item.events) {
      const event = display.event;
      if (event.type === 'thinking') {
        const message = event.message.trim();
        if (message) {
          chatLog.addChild(
            new Text(message.length > 200 ? `${message.slice(0, 200)}...` : message, 0, 0),
          );
        }
        continue;
      }

      if (event.type === 'tool_start') {
        const toolStart = event as ToolStartEvent;
        const component = chatLog.startTool(display.id, toolStart.tool, toolStart.args);
        if (display.completed && display.endEvent?.type === 'tool_end') {
          const done = display.endEvent as ToolEndEvent;
          component.setComplete(
            summarizeToolResult(done.tool, toolStart.args, done.result),
            done.duration,
          );
        } else if (display.completed && display.endEvent?.type === 'tool_error') {
          const toolError = display.endEvent as ToolErrorEvent;
          component.setError(toolError.error);
        } else if (display.progressMessage) {
          component.setActive(display.progressMessage);
        }
        continue;
      }

      if (event.type === 'tool_approval') {
        const approval = chatLog.startTool(display.id, event.tool, event.args);
        approval.setApproval(event.approved);
        continue;
      }

      if (event.type === 'tool_denied') {
        const denied = chatLog.startTool(display.id, event.tool, event.args);
        const path = (event.args.path as string) ?? '';
        denied.setDenied(path, event.tool);
        continue;
      }

      if (event.type === 'tool_limit') {
        continue;
      }

      if (event.type === 'context_cleared') {
        chatLog.addContextCleared(event.clearedCount, event.keptCount);
      }
    }

    if (item.answer) {
      chatLog.finalizeAnswer(item.answer);
    }
    if (item.status === 'complete') {
      chatLog.addPerformanceStats(item.duration ?? 0, item.tokenUsage, item.tokensPerSecond);
    }
  }
}

export async function runCli() {
  // Initialize database and inject into tools
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

  // Initialize MCP client connections (non-blocking — failures are logged, not fatal)
  await initMcpClients();
  await loadMcpTools();

  const tui = new TUI(new ProcessTerminal());
  const root = new Container();
  const chatLog = new ChatLogComponent(tui);
  const inputHistory = new InputHistoryController(() => tui.requestRender());
  let lastError: string | null = null;

  const onError = (message: string) => {
    lastError = message;
    logger.error(message);
    tui.requestRender();
  };

  let agentRunner: AgentRunnerController;
  const modelSelection = new ModelSelectionController(onError, () => {
    intro.setModel(modelSelection.model);
    agentRunner?.updateModel(modelSelection.model, modelSelection.provider);
    renderSelectionOverlay();
    tui.requestRender();
  });

  // Enable chat history persistence
  modelSelection.inMemoryChatHistory.setDatabase(db);

  let renderPending = false;
  agentRunner = new AgentRunnerController(
    { model: modelSelection.model, modelProvider: modelSelection.provider, maxIterations: 10 },
    modelSelection.inMemoryChatHistory,
    () => {
      if (!renderPending) {
        renderPending = true;
        queueMicrotask(() => {
          renderPending = false;
          renderHistory(chatLog, agentRunner.history);
          workingIndicator.setState(agentRunner.workingState);
          renderSelectionOverlay();
          tui.requestRender();
        });
      }
    },
  );

  const currentProfileName = getActiveProfileName();
  const intro = new IntroComponent(modelSelection.model, currentProfileName !== DEFAULT_PROFILE ? currentProfileName : undefined);
  const errorText = new Text('', 0, 0);
  const workingIndicator = new WorkingIndicatorComponent(tui);
  const editor = new CustomEditor(tui, editorTheme);
  const contextHints = new ContextHintsComponent();
  const debugPanel = new DebugPanelComponent(8, true);

  // Set up slash command autocomplete with @ file search
  const slashCommands: SlashCommand[] = [
    { name: 'import', description: 'Import a bank file (CSV, OFX, QIF)' },
    { name: 'categorize', description: 'AI-categorize uncategorized transactions' },
    { name: 'model', description: 'Switch LLM provider and model' },
    { name: 'pull', description: 'Download an Ollama model' },
    { name: 'license', description: 'Manage your license key' },
    { name: 'budget', description: 'View and set spending budgets' },
    { name: 'connect', description: 'Link a bank account via Plaid' },
    { name: 'sync', description: 'Pull latest transactions from linked banks' },
    { name: 'dashboard', description: 'Open browser dashboard' },
    { name: 'schedule', description: 'Manage scheduled tasks (add/remove/pause/resume)' },
    { name: 'profile', description: 'Show or switch profile (e.g. /profile switch business)' },
    { name: 'upgrade', description: 'Upgrade to Open Accountant Pro' },
    { name: 'help', description: 'Show available commands' },
    ...RECOMMENDED_OLLAMA_MODELS.map((m) => ({
      name: `pull ${m.name}`,
      description: `${m.desc} (${m.size})`,
    })),
    ...discoverSkills().map((s) => ({
      name: `skill ${s.name}`,
      description: s.description,
    })),
  ];

  // Detect fd on PATH for @ fuzzy file search (faster, respects .gitignore)
  let fdPath: string | null = null;
  try {
    fdPath = execFileSync('which', ['fd'], { encoding: 'utf-8' }).trim() || null;
  } catch {
    // fd not found — will fall back to directory-walking for @ file completion
  }

  const baseAutocomplete = new CombinedAutocompleteProvider(slashCommands, process.cwd(), fdPath);

  // Wrap provider so @ falls back to directory-walking when fd isn't available
  // (pi-tui's built-in @ only uses fd; without it, @ returns nothing)
  if (!fdPath) {
    const origGetSuggestions = baseAutocomplete.getSuggestions.bind(baseAutocomplete);
    baseAutocomplete.getSuggestions = (lines, cursorLine, cursorCol) => {
      const result = origGetSuggestions(lines, cursorLine, cursorCol);
      if (result) return result;

      // Check if user typed @something — fall back to directory-based completion
      const line = lines[cursorLine] || '';
      const before = line.slice(0, cursorCol);
      const atMatch = before.match(/(^|[\s])(@[^\s]*)$/);
      if (atMatch) {
        const atPrefix = atMatch[2]; // e.g. "@../doc"
        const pathPart = atPrefix.slice(1); // strip @
        // Use the provider's built-in getFileSuggestions (directory walking)
        const fileSuggestions = (baseAutocomplete as any).getFileSuggestions(pathPart);
        if (fileSuggestions && fileSuggestions.length > 0) {
          return {
            items: fileSuggestions.map((s: any) => ({
              ...s,
              value: `@${s.value}`,
            })),
            prefix: atPrefix,
          };
        }
      }
      return null;
    };
  }

  editor.setAutocompleteProvider(baseAutocomplete);

  tui.addChild(root);

  const refreshError = () => {
    const message = lastError ?? agentRunner.error;
    errorText.setText(message ? theme.error(`Error: ${message}`) : '');
  };

  const handleSubmit = async (query: string) => {
    if (query.toLowerCase() === 'exit' || query.toLowerCase() === 'quit') {
      tui.stop();
      process.exit(0);
      return;
    }

    if (query === '/model') {
      modelSelection.startSelection();
      return;
    }

    if (query === '/help') {
      chatLog.addQuery(query);
      const commands = [
        '  /import       — Import a bank file or directory (CSV, OFX, QIF)',
        '  /categorize   — AI-categorize uncategorized transactions',
        '  /model        — Switch LLM provider and model',
        '  /pull         — Download an Ollama model',
        '  /connect      — Link a bank account via Plaid (Pro)',
        '  /connect-coinbase — Link Coinbase crypto account (Pro)',
        '  /sync         — Pull latest transactions (Pro)',
        '  /budget       — View budget vs actual',
        '  /category     — Manage spending categories',
        '  /dashboard    — Open browser dashboard',
        '  /upgrade      — Upgrade to Pro',
        '  /license <key> — Activate a license key',
        '  /schedule     — Manage scheduled tasks',
        '  /profile      — Show or switch profile',
        '  /help         — Show this help message',
      ];
      const skills = discoverSkills();
      const freeSkills = skills.filter((s) => s.tier !== 'paid').map((s) => s.name);
      const paidSkills = skills.filter((s) => s.tier === 'paid').map((s) => s.name);
      let output = `**Commands**\n\n${commands.join('\n')}`;
      if (skills.length > 0) {
        output += `\n\n**Skills** — run with \`/skill <name>\``;
        if (freeSkills.length > 0) {
          output += `\n\n  **Free:** ${freeSkills.join(', ')}`;
        }
        if (paidSkills.length > 0) {
          output += `\n\n  **Pro:** ${paidSkills.join(', ')}`;
        }
        output += `\n\n  Ask me about any skill by name for details.`;
      }
      chatLog.finalizeAnswer(output);
      tui.requestRender();
      return;
    }

    if (query.startsWith('/import ') || query === '/import') {
      chatLog.addQuery(query);
      const rawPath = query.slice(8).trim();
      if (!rawPath) {
        chatLog.finalizeAnswer(
          'Usage: `/import <file or directory>`\n\n' +
          'Supports CSV (Chase, Amex, BofA, auto-detected), OFX, and QIF.\n' +
          'Example: `/import ~/Downloads/chase-statement.csv`\n' +
          'Example: `/import ~/Downloads/bank-statements/`\n' +
          'Tip: type `@` to search for files.'
        );
        tui.requestRender();
        return;
      }

      // Strip surrounding quotes and leading @ (from file autocomplete)
      const filePath = rawPath.replace(/^["']|["']$/g, '').replace(/^@/, '');

      chatLog.finalizeAnswer(`Importing **${filePath}**...`);
      tui.requestRender();

      try {
        const resultJson = await csvImportTool.func({ filePath, bank: 'auto' });
        const result = JSON.parse(resultJson);
        const data = result.data ?? result;

        if (data.error) {
          chatLog.finalizeAnswer(`**Import failed:** ${data.error}`);
        } else if (data.alreadyImported) {
          chatLog.finalizeAnswer(data.message);
        } else {
          let msg = `Imported **${data.transactionsImported}** transactions`;
          if (data.bankDetected) {
            msg += ` (${data.bankDetected} ${data.formatDetected?.toUpperCase() ?? 'CSV'})`;
          }
          if (data.dateRange) {
            msg += `\nDate range: ${data.dateRange.start} to ${data.dateRange.end}`;
          }
          if (data.transactionsSkipped > 0) {
            msg += `\n${data.transactionsSkipped} duplicates skipped.`;
          }
          msg += '\n\nRun `/categorize` to categorize them.';
          chatLog.finalizeAnswer(msg);
        }
      } catch (err) {
        chatLog.finalizeAnswer(`**Import failed:** ${err instanceof Error ? err.message : String(err)}`);
      }
      tui.requestRender();
      return;
    }

    if (query === '/categorize' || query.startsWith('/categorize ')) {
      chatLog.addQuery(query);
      chatLog.finalizeAnswer('Categorizing transactions...');
      tui.requestRender();

      const limitArg = query.slice(12).trim();
      const limit = limitArg ? parseInt(limitArg, 10) : undefined;

      try {
        const resultJson = await categorizeTool.func({
          limit: limit && !isNaN(limit) ? limit : undefined,
        });
        const result = JSON.parse(resultJson);
        const data = result.data ?? result;

        if (data.categorized === 0 && !data.error) {
          chatLog.finalizeAnswer(data.message ?? 'All transactions are already categorized.');
        } else if (data.error) {
          chatLog.finalizeAnswer(`**Categorization failed:** ${data.error}`);
        } else {
          let msg = `Categorized **${data.categorized}** of ${data.totalUncategorized} transactions`;
          if (data.ruleMatched > 0) {
            msg += ` (${data.ruleMatched} by rules, ${data.llmCategorized} by AI)`;
          }
          if (data.needingReview > 0) {
            msg += `\n${data.needingReview} need review (low confidence).`;
          }
          if (data.categoriesApplied && Object.keys(data.categoriesApplied).length > 0) {
            msg += '\n\n**Categories:**\n';
            const sorted = Object.entries(data.categoriesApplied as Record<string, number>)
              .sort(([, a], [, b]) => b - a);
            for (const [cat, count] of sorted) {
              msg += `  ${cat}: ${count}\n`;
            }
          }
          if (data.errors && data.errors.length > 0) {
            msg += `\n${data.errors.length} batch errors occurred.`;
          }
          chatLog.finalizeAnswer(msg);
        }
      } catch (err) {
        chatLog.finalizeAnswer(`**Categorization failed:** ${err instanceof Error ? err.message : String(err)}`);
      }
      tui.requestRender();
      return;
    }

    if (query.startsWith('/pull ')) {
      const modelName = query.slice(6).trim();
      if (!modelName) return;
      chatLog.addQuery(query);
      chatLog.finalizeAnswer(`Pulling **${modelName}**...`);
      tui.requestRender();
      try {
        let lastStatus = '';
        await pullOllamaModel(modelName, (pct, status) => {
          if (status !== lastStatus) {
            lastStatus = status;
            const progress = pct > 0 ? ` (${pct}%)` : '';
            chatLog.finalizeAnswer(`Pulling **${modelName}**... ${status}${progress}`);
            tui.requestRender();
          }
        });
        chatLog.finalizeAnswer(`**${modelName}** downloaded successfully. Use \`/model\` to select it.`);
      } catch (err) {
        chatLog.finalizeAnswer(`Failed to pull **${modelName}**: ${err instanceof Error ? err.message : String(err)}`);
      }
      tui.requestRender();
      return;
    }

    if (query === '/connect' || query.startsWith('/connect ')) {
      chatLog.addQuery(query);
      if (!hasLicense('pro')) {
        chatLog.finalizeAnswer(interactiveUpsell('Bank sync', 'Connect your bank for automatic transaction imports — no more CSV downloads.'));
        tui.requestRender();
        return;
      }
      const subcommand = query.slice(8).trim();

      if (subcommand === 'list') {
        const items = getPlaidItems();
        if (items.length === 0) {
          chatLog.finalizeAnswer('No bank accounts linked. Use `/connect` to link one.');
        } else {
          let result = '**Linked Accounts**\n\n';
          for (const item of items) {
            const accounts = item.accounts.map((a) => `${a.name} (****${a.mask})`).join(', ');
            result += `  **${item.institutionName}** — ${accounts}\n`;
            result += `  Linked: ${new Date(item.linkedAt).toLocaleDateString()}`;
            if (item.errorState) {
              result += `  \u26a0 Needs re-auth (${item.errorState.code})`;
            } else if (isReauthRequired(item)) {
              result += `  \u26a0 Re-auth recommended (approaching 12-month expiry)`;
            }
            result += '\n\n';
          }
          chatLog.finalizeAnswer(result);
        }
      } else if (subcommand === 'reauth') {
        // Re-authenticate a Plaid Item with stale credentials
        const items = getPlaidItems();
        if (items.length === 0) {
          chatLog.finalizeAnswer('No bank accounts linked. Use `/connect` to link one.');
        } else if (items.length === 1) {
          chatLog.finalizeAnswer('Opening Plaid Link in update mode for re-authentication...');
          tui.requestRender();
          try {
            const hasLocalCreds = !!(process.env.PLAID_CLIENT_ID && process.env.PLAID_SECRET);
            const useProxy = !hasLocalCreds;
            const success = await startPlaidLinkUpdateServer(items[0], useProxy);
            chatLog.finalizeAnswer(success
              ? `Re-authenticated **${items[0].institutionName}** successfully.`
              : 'Re-authentication was cancelled or timed out.');
          } catch (err) {
            chatLog.finalizeAnswer(`Re-authentication failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        } else {
          chatLog.finalizeAnswer(
            'Multiple accounts linked. Specify which to re-authenticate:\n\n' +
            items.map((i) => `  \`/connect reauth ${i.institutionName}\``).join('\n')
          );
        }
      } else if (subcommand.startsWith('reauth ')) {
        const institution = subcommand.slice(7).trim();
        const item = findPlaidItem(institution);
        if (!item) {
          chatLog.finalizeAnswer(`No linked account found for "${institution}".`);
        } else {
          chatLog.finalizeAnswer(`Opening Plaid Link in update mode for **${item.institutionName}**...`);
          tui.requestRender();
          try {
            const hasLocalCreds = !!(process.env.PLAID_CLIENT_ID && process.env.PLAID_SECRET);
            const useProxy = !hasLocalCreds;
            const success = await startPlaidLinkUpdateServer(item, useProxy);
            chatLog.finalizeAnswer(success
              ? `Re-authenticated **${item.institutionName}** successfully.`
              : 'Re-authentication was cancelled or timed out.');
          } catch (err) {
            chatLog.finalizeAnswer(`Re-authentication failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      } else if (subcommand.startsWith('remove ')) {
        const institution = subcommand.slice(7).trim();
        if (!institution) {
          chatLog.finalizeAnswer('Usage: `/connect remove <institution name>`');
        } else {
          // Call Plaid API to revoke access token, then remove locally
          const item = findPlaidItem(institution);
          if (item) {
            try {
              const hasLocalCreds = !!(process.env.PLAID_CLIENT_ID && process.env.PLAID_SECRET);
              const useProxy = !hasLocalCreds;
              await plaidRemoveItem(item.accessToken, useProxy);
            } catch {
              // Non-fatal: local cleanup proceeds even if Plaid API call fails
            }
          }
          const removed = removePlaidItem(institution);
          chatLog.finalizeAnswer(removed
            ? `Disconnected **${institution}** and revoked Plaid access token.`
            : `No linked account found for "${institution}".`);
        }
      } else {
        // Launch Plaid Link
        const hasLocalCreds = !!(process.env.PLAID_CLIENT_ID && process.env.PLAID_SECRET);
        const useProxy = !hasLocalCreds; // Pro users without local creds use OA API proxy

        if (!hasLocalCreds && !hasLicense('pro')) {
          chatLog.finalizeAnswer(
            'Plaid not configured. Set `PLAID_CLIENT_ID` and `PLAID_SECRET` environment variables.\n\n' +
            'Get free sandbox credentials at: https://dashboard.plaid.com\n\n' +
            'Or upgrade to **Pro** for zero-config bank sync — no Plaid credentials needed.'
          );
        } else {
          chatLog.finalizeAnswer(
            useProxy
              ? 'Opening Plaid Link via Open Accountant Pro...'
              : 'Opening Plaid Link in your browser...'
          );
          tui.requestRender();
          try {
            const item = await startPlaidLinkServer(useProxy);
            if (item) {
              const accounts = item.accounts.map((a) => `${a.name} (****${a.mask})`).join(', ');
              chatLog.finalizeAnswer(
                `Bank linked! **${item.institutionName}** — ${accounts}\n\n` +
                `Use \`/sync\` to pull transactions.`
              );
            } else {
              chatLog.finalizeAnswer('Bank linking was cancelled or timed out.');
            }
          } catch (err) {
            chatLog.finalizeAnswer(`Failed to connect: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
      tui.requestRender();
      return;
    }

    if (query === '/connect-coinbase' || query.startsWith('/connect-coinbase ')) {
      chatLog.addQuery(query);
      if (!hasLicense('pro')) {
        chatLog.finalizeAnswer(interactiveUpsell('Coinbase sync', 'Connect your Coinbase account for automatic crypto transaction imports.'));
        tui.requestRender();
        return;
      }
      const subcommand = query.slice(17).trim();

      if (subcommand === 'list') {
        const connections = getCoinbaseConnections();
        if (connections.length === 0) {
          chatLog.finalizeAnswer('No Coinbase accounts linked. Use `/connect-coinbase` to link one.');
        } else {
          let result = '**Linked Coinbase Accounts**\n\n';
          for (const conn of connections) {
            const accounts = conn.accounts.map((a) => `${a.name} (${a.currency})`).join(', ');
            result += `  **Coinbase** — ${accounts}\n`;
            result += `  Linked: ${new Date(conn.linkedAt).toLocaleDateString()}`;
            if (conn.lastSyncedAt) {
              result += ` | Last synced: ${new Date(conn.lastSyncedAt).toLocaleDateString()}`;
            }
            result += '\n\n';
          }
          chatLog.finalizeAnswer(result);
        }
      } else if (subcommand.startsWith('remove')) {
        const accountName = subcommand.slice(6).trim();
        if (!accountName) {
          chatLog.finalizeAnswer('Usage: `/connect-coinbase remove <account name>`');
        } else {
          const removed = removeCoinbaseConnection(accountName);
          chatLog.finalizeAnswer(removed
            ? `Unlinked Coinbase account **${accountName}**.`
            : `No linked Coinbase account found matching "${accountName}".`);
        }
      } else {
        // Check env vars first, then accept file path as argument
        let keyName = process.env.COINBASE_KEY_NAME;
        let privateKey = process.env.COINBASE_PRIVATE_KEY;

        if (!keyName || !privateKey) {
          // Accept a JSON key file path as argument: /connect-coinbase ~/cdp_api_key.json
          const keyPath = subcommand.trim();
          if (keyPath) {
            try {
              const { readFileSync } = await import('fs');
              const { resolve: resolvePath } = await import('path');
              const { homedir } = await import('os');
              const expanded = keyPath.startsWith('~')
                ? keyPath.replace('~', homedir())
                : keyPath;
              const content = readFileSync(resolvePath(expanded), 'utf-8');

              if (keyPath.endsWith('.json')) {
                // CDP JSON key file format: { "name": "...", "privateKey": "..." }
                const keyData = JSON.parse(content) as { name?: string; privateKey?: string };
                keyName = keyData.name;
                privateKey = keyData.privateKey;
              } else {
                // Plain PEM file — need key name from env
                keyName = process.env.COINBASE_KEY_NAME;
                privateKey = content.trim();
              }
            } catch (err) {
              chatLog.finalizeAnswer(`Failed to read key file: ${err instanceof Error ? err.message : String(err)}`);
              tui.requestRender();
              return;
            }
          }
        }

        if (!keyName || !privateKey) {
          chatLog.finalizeAnswer(
            'To connect Coinbase, provide your CDP API key:\n\n' +
            '**Option 1:** Set environment variables:\n' +
            '```\n' +
            'export COINBASE_KEY_NAME="organizations/.../apiKeys/..."\n' +
            'export COINBASE_PRIVATE_KEY="-----BEGIN EC PRIVATE KEY-----\\n..."\n' +
            '```\n' +
            'Then run `/connect-coinbase` again.\n\n' +
            '**Option 2:** Pass the CDP JSON key file:\n' +
            '```\n' +
            '/connect-coinbase ~/path/to/cdp_api_key.json\n' +
            '```\n\n' +
            'Get your key from [CDP Dashboard](https://portal.cdp.coinbase.com/) → API Keys → Secret API Keys (ES256).'
          );
          tui.requestRender();
          return;
        }

        // Normalize PEM newlines
        if (privateKey.includes('\\n')) {
          privateKey = privateKey.replace(/\\n/g, '\n');
        }

        chatLog.finalizeAnswer('Validating Coinbase credentials...');
        tui.requestRender();

        try {
          const accounts = await validateCoinbaseKey(keyName, privateKey);
          const conn = {
            keyName,
            privateKey,
            accounts: accounts.map((a) => ({
              id: a.id,
              name: a.name,
              type: a.type,
              currency: a.currency.code,
            })),
            linkedAt: new Date().toISOString(),
            lastSyncedAt: null,
          };
          saveCoinbaseConnection(conn);

          const accountList = conn.accounts.map((a) => `${a.name} (${a.currency})`).join(', ');
          chatLog.finalizeAnswer(
            `Coinbase linked! ${accountList}\n\n` +
            `Use \`/sync\` to pull transactions.`
          );
        } catch (err) {
          chatLog.finalizeAnswer(`Failed to connect Coinbase: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      tui.requestRender();
      return;
    }

    if (query === '/sync') {
      chatLog.addQuery(query);
      if (!hasLicense('pro')) {
        chatLog.finalizeAnswer(interactiveUpsell('Bank sync', 'Auto-pull transactions from your linked bank accounts.'));
        tui.requestRender();
        return;
      }
      const items = getPlaidItems();
      if (items.length === 0) {
        chatLog.finalizeAnswer('No bank accounts linked. Use `/connect` to link one first.');
      } else {
        chatLog.finalizeAnswer('Syncing transactions...');
        tui.requestRender();
        // Route through agent so it uses the plaid_sync tool
        await inputHistory.saveMessage(query);
        inputHistory.resetNavigation();
        const result = await agentRunner.runQuery('Sync my bank transactions using the plaid_sync tool');
        if (result?.answer) {
          await inputHistory.updateAgentResponse(result.answer);
        }
        refreshError();
      }
      tui.requestRender();
      return;
    }

    if (query === '/category' || query.startsWith('/category ')) {
      chatLog.addQuery(query);
      const subcommand = query.slice(9).trim();

      if (subcommand.startsWith('add ')) {
        const rest = subcommand.slice(4).trim();
        // Parse: /category add <name> under <parent>
        const underMatch = rest.match(/^(.+?)\s+under\s+(.+)$/i);
        if (underMatch) {
          const [, childName, parentName] = underMatch;
          const parent = getCategoryByName(db, parentName.trim());
          if (!parent) {
            chatLog.finalizeAnswer(`Parent category "${parentName.trim()}" not found.`);
          } else {
            const id = addCategory(db, childName.trim(), parent.id);
            chatLog.finalizeAnswer(`Created sub-category **${childName.trim()}** under **${parent.name}** (id: ${id})`);
          }
        } else if (rest) {
          const id = addCategory(db, rest);
          chatLog.finalizeAnswer(`Created category **${rest}** (id: ${id})`);
        } else {
          chatLog.finalizeAnswer('Usage: `/category add <name>` or `/category add <name> under <parent>`');
        }
      } else if (subcommand.startsWith('delete ')) {
        const idStr = subcommand.slice(7).trim();
        const id = parseInt(idStr, 10);
        if (isNaN(id)) {
          chatLog.finalizeAnswer('Usage: `/category delete <id>`');
        } else {
          const result = deleteCategory(db, id);
          chatLog.finalizeAnswer(result.ok
            ? `Category #${id} deleted.`
            : `Cannot delete: ${result.error}`);
        }
      } else {
        // List categories as tree
        const tree = getCategoryTree(db);
        if (tree.length === 0) {
          chatLog.finalizeAnswer('No categories found.');
        } else {
          const formatCatTree = (nodes: CategoryTreeNode[], indent: number = 0): string => {
            const lines: string[] = [];
            for (const node of nodes) {
              const prefix = '  '.repeat(indent);
              const sys = node.is_system ? '' : ' *(custom)*';
              lines.push(`${prefix}- **${node.name}**${sys}`);
              if (node.children.length > 0) {
                lines.push(formatCatTree(node.children, indent + 1));
              }
            }
            return lines.join('\n');
          };
          const total = getCategories(db).length;
          chatLog.finalizeAnswer(`**Categories** (${total} total)\n\n${formatCatTree(tree)}`);
        }
      }
      tui.requestRender();
      return;
    }

    if (query === '/budget' || query.startsWith('/budget ')) {
      chatLog.addQuery(query);
      const subcommand = query.slice(7).trim();

      if (subcommand.startsWith('set ')) {
        // /budget set <category> <amount>
        const parts = subcommand.slice(4).trim();
        const lastSpace = parts.lastIndexOf(' ');
        if (lastSpace === -1) {
          chatLog.finalizeAnswer('Usage: `/budget set <category> <amount>`\nExample: `/budget set Dining 400`');
        } else {
          const category = parts.slice(0, lastSpace).trim();
          const amount = parseFloat(parts.slice(lastSpace + 1));
          if (isNaN(amount) || amount <= 0) {
            chatLog.finalizeAnswer('Invalid amount. Usage: `/budget set <category> <amount>`');
          } else {
            setBudget(db, category, amount);
            chatLog.finalizeAnswer(`Budget set: **${category}** → $${amount}/month`);
          }
        }
      } else if (subcommand.startsWith('clear ')) {
        const category = subcommand.slice(6).trim();
        if (!category) {
          chatLog.finalizeAnswer('Usage: `/budget clear <category>`');
        } else {
          const removed = clearBudget(db, category);
          chatLog.finalizeAnswer(removed
            ? `Budget removed for **${category}**.`
            : `No budget found for "${category}".`);
        }
      } else {
        // Show current month budget vs actual
        const currentMonth = new Date().toISOString().slice(0, 7);
        const results = getBudgetVsActual(db, currentMonth);
        if (results.length === 0) {
          chatLog.finalizeAnswer('No budgets set. Use `/budget set <category> <amount>` to create one.');
        } else {
          let table = `**Budget vs Actual — ${currentMonth}**\n\n`;
          table += '| Category | Budget | Actual | Remaining | Used |\n';
          table += '|----------|--------|--------|-----------|------|\n';
          for (const r of results) {
            const status = r.over ? `**${r.percent_used}% OVER**` : `${r.percent_used}%`;
            const rem = r.over ? `-$${Math.abs(r.remaining).toFixed(0)}` : `$${r.remaining.toFixed(0)}`;
            table += `| ${r.category} | $${r.monthly_limit.toFixed(0)} | $${r.actual.toFixed(0)} | ${rem} | ${status} |\n`;
          }
          chatLog.finalizeAnswer(table);
        }
      }
      tui.requestRender();
      return;
    }

    if (query === '/upgrade' || query.startsWith('/upgrade ')) {
      chatLog.addQuery(query);
      const arg = query.slice(8).trim().toLowerCase();
      const isMonthly = arg === 'month' || arg === 'monthly';
      const cycle = isMonthly ? 'monthly' as const : 'annual' as const;

      const pitch = [
        '**Open Accountant Pro** — everything unlocked.',
        '',
        '  Bank sync (Plaid, Monarch, Firefly)',
        '  40+ financial skills (tax prep, subscription audit, forecasting...)',
        '  Tax tracking & deduction flagging',
        '  Net worth trends & mortgage tools',
        '',
        isMonthly
          ? '  **$20/mo**  ←  opening checkout now'
          : '  **$99/yr (save 59%)**  ←  opening checkout now',
        '',
        !isMonthly ? '  `/upgrade month`  $20/mo if you prefer' : '  `/upgrade`  $99/yr to save 59%',
      ];

      chatLog.finalizeAnswer(pitch.join('\n'));
      tui.requestRender();
      openBrowser(getCheckoutUrl(cycle));
      return;
    }

    if (query === '/license' || query.startsWith('/license ')) {
      chatLog.addQuery(query);
      const subcommand = query.slice(8).trim();

      const activateKey = async (key: string) => {
        chatLog.finalizeAnswer('Validating license key...');
        tui.requestRender();
        try {
          const result = await validateLicense(key);
          clearOrchestrationCache();
          const products = result.products.length > 0 ? result.products.join(', ') : 'all products';
          chatLog.finalizeAnswer(
            `License activated!\n\n` +
            `  **Email:** ${result.email || '(none)'}\n` +
            `  **Products:** ${products}\n` +
            `  **Valid until:** ${new Date(result.validUntil).toLocaleDateString()}`
          );
        } catch (err) {
          chatLog.finalizeAnswer(`License activation failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      };

      if (subcommand.startsWith('activate ')) {
        const key = subcommand.slice(9).trim();
        if (!key) {
          chatLog.finalizeAnswer('Usage: `/license <key>`');
        } else {
          await activateKey(key);
        }
      } else if (subcommand === 'manage') {
        openBrowser('https://polar.sh/openaccountant/portal');
        chatLog.finalizeAnswer(
          'Opening customer portal — manage billing, cancel, or view invoices.\n\n' +
          'If the page didn\'t open, visit: https://polar.sh/openaccountant/portal'
        );
      } else if (subcommand === 'deactivate') {
        deactivateLicense();
        clearOrchestrationCache();
        chatLog.finalizeAnswer('License deactivated. Paid features are now locked.');
      } else if (subcommand && subcommand !== 'activate') {
        // Treat bare key as activation: /license OA-xxx → activate
        await activateKey(subcommand);
      } else {
        // /license with no args (or bare "activate" with no key) — show status
        const info = getLicenseInfo();
        if (info) {
          const products = info.products.length > 0 ? info.products.join(', ') : 'all products';
          chatLog.finalizeAnswer(
            `**License Status**\n\n` +
            `  **Email:** ${info.email || '(none)'}\n` +
            `  **Products:** ${products}\n` +
            `  **Valid until:** ${new Date(info.validUntil).toLocaleDateString()}\n` +
            `  **Last validated:** ${new Date(info.validatedAt).toLocaleDateString()}\n\n` +
            `Commands: \`/license <key>\` · \`/license manage\` · \`/license deactivate\``
          );
        } else {
          chatLog.finalizeAnswer(
            '**No license activated.**\n\n' +
            'Already have a key? Paste it:\n\n' +
            '  `/license <key>`\n\n' +
            'Need to purchase?\n\n' +
            '  `/upgrade`        $99/yr\n' +
            '  `/upgrade month`  $20/mo'
          );
        }
      }
      tui.requestRender();
      return;
    }

    if (query === '/schedule' || query.startsWith('/schedule ')) {
      chatLog.addQuery(query);
      const subcommand = query.slice(9).trim();

      if (subcommand.startsWith('add ')) {
        // /schedule add "0 8 * * *" Sync my bank transactions
        const rest = subcommand.slice(4).trim();
        // Parse cron expression (in quotes) and query
        const cronMatch = rest.match(/^"([^"]+)"\s+(.+)$/);
        if (!cronMatch) {
          chatLog.finalizeAnswer(
            'Usage: `/schedule add "<cron>" <query>`\n' +
            'Example: `/schedule add "0 8 * * *" Sync my bank transactions`'
          );
        } else {
          const [, cron, scheduleQuery] = cronMatch;
          const schedule = addSchedule({
            query: scheduleQuery,
            cron,
            label: scheduleQuery,
            enabled: true,
          });
          try {
            syncCrontab();
            chatLog.finalizeAnswer(
              `Schedule added!\n\n` +
              `  **ID:** ${schedule.id.slice(0, 8)}...\n` +
              `  **Cron:** ${cron}\n` +
              `  **Query:** ${scheduleQuery}\n` +
              `  **Status:** enabled`
            );
          } catch (err) {
            chatLog.finalizeAnswer(
              `Schedule saved but crontab update failed: ${err instanceof Error ? err.message : String(err)}\n\n` +
              `The schedule is stored but won't run automatically until crontab is fixed.`
            );
          }
        }
      } else if (subcommand.startsWith('remove ')) {
        const id = subcommand.slice(7).trim();
        // Support partial ID matching
        const schedules = getSchedules();
        const match = schedules.find((s) => s.id === id || s.id.startsWith(id));
        if (!match) {
          chatLog.finalizeAnswer(`No schedule found matching "${id}".`);
        } else {
          removeSchedule(match.id);
          try {
            syncCrontab();
          } catch {
            // Best effort crontab sync
          }
          chatLog.finalizeAnswer(`Schedule removed: **${match.label}**`);
        }
      } else if (subcommand.startsWith('pause ')) {
        const id = subcommand.slice(6).trim();
        const schedules = getSchedules();
        const match = schedules.find((s) => s.id === id || s.id.startsWith(id));
        if (!match) {
          chatLog.finalizeAnswer(`No schedule found matching "${id}".`);
        } else if (!match.enabled) {
          chatLog.finalizeAnswer(`Schedule **${match.label}** is already paused.`);
        } else {
          toggleSchedule(match.id);
          try {
            syncCrontab();
          } catch {
            // Best effort
          }
          chatLog.finalizeAnswer(`Schedule paused: **${match.label}**`);
        }
      } else if (subcommand.startsWith('resume ')) {
        const id = subcommand.slice(7).trim();
        const schedules = getSchedules();
        const match = schedules.find((s) => s.id === id || s.id.startsWith(id));
        if (!match) {
          chatLog.finalizeAnswer(`No schedule found matching "${id}".`);
        } else if (match.enabled) {
          chatLog.finalizeAnswer(`Schedule **${match.label}** is already running.`);
        } else {
          toggleSchedule(match.id);
          try {
            syncCrontab();
          } catch {
            // Best effort
          }
          chatLog.finalizeAnswer(`Schedule resumed: **${match.label}**`);
        }
      } else {
        // List all schedules
        const schedules = getSchedules();
        if (schedules.length === 0) {
          chatLog.finalizeAnswer(
            'No schedules configured.\n\n' +
            'Add one with: `/schedule add "<cron>" <query>`\n' +
            'Example: `/schedule add "0 8 * * *" Sync my bank transactions`'
          );
        } else {
          let result = '**Scheduled Tasks**\n\n';
          result += '| Status | Cron | Query | Last Run | ID |\n';
          result += '|--------|------|-------|----------|----|\n';
          for (const s of schedules) {
            const status = s.enabled ? 'active' : 'paused';
            const lastRun = s.lastRunAt ? new Date(s.lastRunAt).toLocaleDateString() : 'never';
            const shortId = s.id.slice(0, 8);
            result += `| ${status} | \`${s.cron}\` | ${s.label} | ${lastRun} | ${shortId}... |\n`;
          }
          result += '\n**Commands:** `/schedule add` · `/schedule remove <id>` · `/schedule pause <id>` · `/schedule resume <id>`';
          chatLog.finalizeAnswer(result);
        }
      }
      tui.requestRender();
      return;
    }

    if (query === '/profile' || query.startsWith('/profile ')) {
      chatLog.addQuery(query);
      const subcommand = query.slice(8).trim();

      if (subcommand.startsWith('switch ')) {
        const target = subcommand.slice(7).trim();
        if (!target) {
          chatLog.finalizeAnswer('Usage: `/profile switch <name>`');
        } else {
          chatLog.finalizeAnswer(`Switching to profile **${target}**... (restarting)`);
          tui.requestRender();
          // Re-exec with --profile flag to get clean DB/tool state
          const oaPath = process.argv[1];
          const newArgs = ['--profile', target, ...process.argv.slice(2).filter((a, i, arr) => {
            if (a === '--profile') return false;
            if (i > 0 && arr[i - 1] === '--profile') return false;
            return true;
          })];
          const { execFileSync } = await import('child_process');
          tui.stop();
          try {
            execFileSync(process.argv[0], [oaPath, ...newArgs], { stdio: 'inherit' });
          } catch {
            // Child process exited
          }
          process.exit(0);
        }
      } else {
        const currentProfile = getActiveProfileName();
        const profiles = listProfiles();
        let msg = `**Active profile:** ${currentProfile}`;
        if (profiles.length > 0) {
          msg += '\n\n**All profiles:**\n';
          for (const p of profiles) {
            const marker = p === currentProfile ? ' (active)' : '';
            const isDefault = p === DEFAULT_PROFILE ? ' (default)' : '';
            msg += `  ${p}${marker}${isDefault}\n`;
          }
        }
        msg += '\nSwitch with: `/profile switch <name>`';
        chatLog.finalizeAnswer(msg);
      }
      tui.requestRender();
      return;
    }

    if (query === '/dashboard') {
      chatLog.addQuery(query);
      openBrowser(dashUrl);
      chatLog.finalizeAnswer(`Dashboard at ${dashUrl}`);
      tui.requestRender();
      return;
    }

    if (query.startsWith('/skill ')) {
      const skillName = query.slice(7).trim();
      if (!skillName) return;
      // Route to agent with skill invocation
      await inputHistory.saveMessage(query);
      inputHistory.resetNavigation();
      const result = await agentRunner.runQuery(`Use the skill "${skillName}"`);
      if (result?.answer) {
        await inputHistory.updateAgentResponse(result.answer);
      }
      refreshError();
      tui.requestRender();
      return;
    }

    if (modelSelection.isInSelectionFlow() || agentRunner.pendingApproval || agentRunner.isProcessing) {
      return;
    }

    await inputHistory.saveMessage(query);
    inputHistory.resetNavigation();
    const result = await agentRunner.runQuery(query);
    if (result?.answer) {
      await inputHistory.updateAgentResponse(result.answer);
    }
    refreshError();
    tui.requestRender();
  };

  editor.onSubmit = (text) => {
    const value = text.trim();
    if (!value) return;
    editor.setText('');
    editor.addToHistory(value);
    void handleSubmit(value);
  };

  editor.onEscape = () => {
    if (modelSelection.isInSelectionFlow()) {
      modelSelection.cancelSelection();
      return;
    }
    if (agentRunner.isProcessing || agentRunner.pendingApproval) {
      agentRunner.cancelExecution();
      return;
    }
  };

  editor.onCtrlC = () => {
    if (modelSelection.isInSelectionFlow()) {
      modelSelection.cancelSelection();
      return;
    }
    if (agentRunner.isProcessing || agentRunner.pendingApproval) {
      agentRunner.cancelExecution();
      return;
    }
    tui.stop();
    process.exit(0);
  };

  const renderMainView = () => {
    root.clear();
    root.addChild(intro);
    root.addChild(new Spacer(1));
    root.addChild(chatLog);
    if (lastError ?? agentRunner.error) {
      root.addChild(errorText);
    }
    if (agentRunner.workingState.status !== 'idle') {
      root.addChild(workingIndicator);
    }
    root.addChild(new Spacer(1));
    root.addChild(editor);
    contextHints.refresh(db);
    root.addChild(contextHints);
    root.addChild(debugPanel);
    tui.setFocus(editor);
  };

  const renderScreenView = (
    title: string,
    description: string,
    body: any,
    footer?: string,
    focusTarget?: any,
  ) => {
    root.clear();
    root.addChild(createScreen(title, description, body, footer));
    if (focusTarget) {
      tui.setFocus(focusTarget);
    }
  };

  const renderSelectionOverlay = () => {
    const state = modelSelection.state;
    if (state.appState === 'idle' && !agentRunner.pendingApproval) {
      refreshError();
      renderMainView();
      return;
    }

    if (agentRunner.pendingApproval) {
      const prompt = new ApprovalPromptComponent(
        agentRunner.pendingApproval.tool,
        agentRunner.pendingApproval.args,
      );
      prompt.onSelect = (decision: ApprovalDecision) => {
        agentRunner.respondToApproval(decision);
      };
      renderScreenView('', '', prompt, undefined, prompt.selector);
      return;
    }

    if (state.appState === 'provider_select') {
      const selector = createProviderSelector(modelSelection.provider, (providerId) => {
        void modelSelection.handleProviderSelect(providerId);
      });
      renderScreenView(
        'Select provider',
        'Switch between LLM providers. Applies to this session and future sessions.',
        selector,
        'Enter to confirm · esc to exit',
        selector,
      );
      return;
    }

    if (state.appState === 'model_select' && state.pendingProvider) {
      const selector = createModelSelector(
        state.pendingModels,
        modelSelection.provider === state.pendingProvider ? modelSelection.model : undefined,
        (modelId) => modelSelection.handleModelSelect(modelId),
        state.pendingProvider,
      );
      renderScreenView(
        `Select model for ${getProviderDisplayName(state.pendingProvider)}`,
        '',
        selector,
        'Enter to confirm · esc to go back',
        selector,
      );
      return;
    }

    if (state.appState === 'model_input' && state.pendingProvider) {
      const input = new ApiKeyInputComponent();
      input.onSubmit = (value) => modelSelection.handleModelInputSubmit(value);
      input.onCancel = () => modelSelection.handleModelInputSubmit(null);
      renderScreenView(
        `Enter model name for ${getProviderDisplayName(state.pendingProvider)}`,
        'Type or paste the model name from openrouter.ai/models',
        input,
        'Examples: anthropic/claude-3.5-sonnet, openai/gpt-4-turbo, meta-llama/llama-3-70b\nEnter to confirm · esc to go back',
        input,
      );
      return;
    }

    if (state.appState === 'download_confirm') {
      const sizeNote = state.pendingDownloadSize ? ` (${state.pendingDownloadSize})` : '';
      const selector = createDownloadConfirmSelector((proceed) =>
        modelSelection.handleDownloadConfirm(proceed),
      );
      renderScreenView(
        'Download Model',
        `This model hasn't been downloaded yet. First run will download it${sizeNote} to ~/.openaccountant/models/.`,
        selector,
        'Enter to confirm · esc to go back',
        selector,
      );
      return;
    }

    if (state.appState === 'api_key_confirm' && state.pendingProvider) {
      const selector = createApiKeyConfirmSelector((wantsToSet) =>
        modelSelection.handleApiKeyConfirm(wantsToSet),
      );
      renderScreenView(
        'Set API Key',
        `Would you like to set your ${getProviderDisplayName(state.pendingProvider)} API key?`,
        selector,
        'Enter to confirm · esc to decline',
        selector,
      );
      return;
    }

    if (state.appState === 'api_key_input' && state.pendingProvider) {
      const input = new ApiKeyInputComponent(true);
      input.onSubmit = (apiKey) => modelSelection.handleApiKeySubmit(apiKey);
      input.onCancel = () => modelSelection.handleApiKeySubmit(null);
      const apiKeyName = getApiKeyNameForProvider(state.pendingProvider) ?? '';
      renderScreenView(
        `Enter ${getProviderDisplayName(state.pendingProvider)} API Key`,
        apiKeyName ? `(${apiKeyName})` : '',
        input,
        'Enter to confirm · Esc to cancel',
        input,
      );
    }
  };

  await inputHistory.init();
  for (const msg of inputHistory.getMessages().reverse()) {
    editor.addToHistory(msg);
  }
  renderSelectionOverlay();
  refreshError();

  // Auto-start dashboard server
  const { startDashboardServer, stopDashboardServer } = await import('./dashboard/server.js');
  const { server: dashServer, url: dashUrl } = await startDashboardServer(db);
  (globalThis as any).__oaDashboard = dashServer;
  intro.setDashboard(dashUrl);

  tui.start();
  await new Promise<void>((resolve) => {
    const finish = () => resolve();
    process.once('exit', finish);
    process.once('SIGINT', finish);
    process.once('SIGTERM', finish);
  });

  workingIndicator.dispose();
  debugPanel.dispose();

  // Stop dashboard server
  if ((globalThis as any).__oaDashboard) {
    stopDashboardServer((globalThis as any).__oaDashboard);
    (globalThis as any).__oaDashboard = null;
  }

  // Cleanup MCP connections
  const { closeMcpClients } = await import('./mcp/client.js');
  await closeMcpClients();
}
