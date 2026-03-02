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
import {
  AgentRunnerController,
  InputHistoryController,
  ModelSelectionController,
} from './controllers/index.js';
import {
  ApiKeyInputComponent,
  ApprovalPromptComponent,
  ChatLogComponent,
  CustomEditor,
  DebugPanelComponent,
  IntroComponent,
  WorkingIndicatorComponent,
  createApiKeyConfirmSelector,
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
import { initExportTool } from './tools/export/export-transactions.js';
import { initBudgetSetTool } from './tools/budget/budget-set.js';
import { initBudgetCheckTool } from './tools/budget/budget-check.js';
import { setBudget, clearBudget, getBudgetVsActual } from './db/queries.js';
import { initBudgetPrompt, initDataContext } from './agent/prompts.js';
import { initPlaidSyncTool } from './tools/import/plaid-sync.js';
import { initProfitLossTool } from './tools/query/profit-loss.js';
import { initProfitDiffTool } from './tools/query/profit-diff.js';
import { initRuleManageTool } from './tools/rules/rule-manage.js';
import { initTaxFlagTool } from './tools/tax/tax-flag.js';
import { initSavingsRateTool } from './tools/query/savings-rate.js';
import { initAlertCheckTool } from './tools/query/alert-check.js';
import { initGenerateReportTool } from './tools/export/generate-report.js';
import { initAlertPrompt } from './agent/prompts.js';
import { getPlaidItems, removePlaidItem } from './plaid/store.js';
import { startPlaidLinkServer } from './plaid/link-server.js';
import { initMcpClients } from './mcp/client.js';
import { loadMcpTools } from './mcp/adapter.js';
import { pullOllamaModel, RECOMMENDED_OLLAMA_MODELS } from './utils/model-downloader.js';
import { discoverSkills } from './skills/registry.js';
import { validateLicense, getLicenseInfo, deactivateLicense, hasLicense } from './licensing/license.js';
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
        if (tool === 'csv_import' || tool === 'monarch_import') {
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
  initImportTool(db);
  initCategorizeTool(db);
  initTransactionSearchTool(db);
  initEditTransactionTool(db);
  initDeleteTransactionTool(db);
  initSpendingSummaryTool(db);
  initAnomalyDetectTool(db);
  initMonarchTool(db);
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
  initAlertPrompt(db);

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

  const modelSelection = new ModelSelectionController(onError, () => {
    intro.setModel(modelSelection.model);
    renderSelectionOverlay();
    tui.requestRender();
  });

  // Enable chat history persistence
  modelSelection.inMemoryChatHistory.setDatabase(db);

  const agentRunner = new AgentRunnerController(
    { model: modelSelection.model, modelProvider: modelSelection.provider, maxIterations: 10 },
    modelSelection.inMemoryChatHistory,
    () => {
      renderHistory(chatLog, agentRunner.history);
      workingIndicator.setState(agentRunner.workingState);
      renderSelectionOverlay();
      tui.requestRender();
    },
  );

  const currentProfileName = getActiveProfileName();
  const intro = new IntroComponent(modelSelection.model, currentProfileName !== DEFAULT_PROFILE ? currentProfileName : undefined);
  const errorText = new Text('', 0, 0);
  const workingIndicator = new WorkingIndicatorComponent(tui);
  const editor = new CustomEditor(tui, editorTheme);
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
        '  /import    — Import a bank file (CSV, OFX, QIF)',
        '  /categorize — AI-categorize uncategorized transactions',
        '  /model     — Switch LLM provider and model',
        '  /pull      — Download an Ollama model (e.g. /pull granite3-dense:2b)',
        '  /connect   — Link a bank account via Plaid (Pro)',
        '  /sync      — Pull latest transactions from linked banks (Pro)',
        '  /budget    — View budget vs actual (set/clear with /budget set|clear)',
        '  /dashboard — Open browser dashboard with charts and chat',
        '  /license   — Manage your license key',
        '  /schedule  — Manage scheduled tasks',
        '  /profile   — Show or switch profile',
        '  /help      — Show this help message',
        ...discoverSkills().map((s) => `  /skill ${s.name}  — ${s.description}`),
      ];
      chatLog.finalizeAnswer(`**Available commands:**\n\n${commands.join('\n')}`);
      tui.requestRender();
      return;
    }

    if (query.startsWith('/import ') || query === '/import') {
      chatLog.addQuery(query);
      const rawPath = query.slice(8).trim();
      if (!rawPath) {
        chatLog.finalizeAnswer(
          'Usage: `/import <file>`\n\n' +
          'Supports CSV (Chase, Amex, BofA, auto-detected), OFX, and QIF.\n' +
          'Example: `/import ~/Downloads/chase-statement.csv`\n' +
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
        chatLog.finalizeAnswer(
          '**Bank sync is a Pro feature.**\n\n' +
          'Connect your bank for automatic transaction imports — no more CSV downloads.\n\n' +
          'Activate with: `/license activate <key>`\n' +
          'Get Pro at: openaccountant.ai/pricing'
        );
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
            result += `  Linked: ${new Date(item.linkedAt).toLocaleDateString()}\n\n`;
          }
          chatLog.finalizeAnswer(result);
        }
      } else if (subcommand.startsWith('remove ')) {
        const institution = subcommand.slice(7).trim();
        if (!institution) {
          chatLog.finalizeAnswer('Usage: `/connect remove <institution name>`');
        } else {
          const removed = removePlaidItem(institution);
          chatLog.finalizeAnswer(removed
            ? `Unlinked **${institution}**.`
            : `No linked account found for "${institution}".`);
        }
      } else {
        // Launch Plaid Link
        if (!process.env.PLAID_CLIENT_ID || !process.env.PLAID_SECRET) {
          chatLog.finalizeAnswer(
            'Plaid not configured. Set `PLAID_CLIENT_ID` and `PLAID_SECRET` environment variables.\n\n' +
            'Get free sandbox credentials at: https://dashboard.plaid.com'
          );
        } else {
          chatLog.finalizeAnswer('Opening Plaid Link in your browser...');
          tui.requestRender();
          try {
            const item = await startPlaidLinkServer();
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

    if (query === '/sync') {
      chatLog.addQuery(query);
      if (!hasLicense('pro')) {
        chatLog.finalizeAnswer(
          '**Bank sync is a Pro feature.**\n\n' +
          'Automatically pull transactions from your linked bank accounts.\n\n' +
          'Activate with: `/license activate <key>`\n' +
          'Get Pro at: openaccountant.ai/pricing'
        );
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

    if (query === '/license' || query.startsWith('/license ')) {
      chatLog.addQuery(query);
      const subcommand = query.slice(8).trim();

      if (subcommand.startsWith('activate ')) {
        const key = subcommand.slice(9).trim();
        if (!key) {
          chatLog.finalizeAnswer('Usage: `/license activate <key>`');
        } else {
          chatLog.finalizeAnswer('Validating license key...');
          tui.requestRender();
          try {
            const result = await validateLicense(key);
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
        }
      } else if (subcommand === 'deactivate') {
        deactivateLicense();
        chatLog.finalizeAnswer('License deactivated. Paid features are now locked.');
      } else {
        // Show current license status
        const info = getLicenseInfo();
        if (info) {
          const products = info.products.length > 0 ? info.products.join(', ') : 'all products';
          chatLog.finalizeAnswer(
            `**License Status**\n\n` +
            `  **Email:** ${info.email || '(none)'}\n` +
            `  **Products:** ${products}\n` +
            `  **Valid until:** ${new Date(info.validUntil).toLocaleDateString()}\n` +
            `  **Last validated:** ${new Date(info.validatedAt).toLocaleDateString()}\n\n` +
            `Commands: \`/license activate <key>\` · \`/license deactivate\``
          );
        } else {
          chatLog.finalizeAnswer(
            `No license active.\n\n` +
            `Activate with: \`/license activate <key>\`\n` +
            `Get a key at: openaccountant.ai/pricing`
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

    if (query === '/dashboard' || query === '/dashboard stop') {
      chatLog.addQuery(query);
      if (query === '/dashboard stop') {
        if ((globalThis as any).__oaDashboard) {
          const { stopDashboardServer } = await import('./dashboard/server.js');
          stopDashboardServer((globalThis as any).__oaDashboard);
          (globalThis as any).__oaDashboard = null;
          chatLog.finalizeAnswer('Dashboard stopped.');
        } else {
          chatLog.finalizeAnswer('No dashboard running.');
        }
      } else {
        if ((globalThis as any).__oaDashboard) {
          chatLog.finalizeAnswer('Dashboard already running. Type `/dashboard stop` to close it.');
        } else {
          const { startDashboardServer } = await import('./dashboard/server.js');
          const { server, url } = startDashboardServer(db);
          (globalThis as any).__oaDashboard = server;
          // Open in default browser
          try {
            Bun.spawn(['open', url]);
          } catch {
            // open may not be available on all platforms
          }
          chatLog.finalizeAnswer(`Dashboard at ${url} — type \`/dashboard stop\` to close`);
        }
      }
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

  tui.start();
  await new Promise<void>((resolve) => {
    const finish = () => resolve();
    process.once('exit', finish);
    process.once('SIGINT', finish);
    process.once('SIGTERM', finish);
  });

  workingIndicator.dispose();
  debugPanel.dispose();

  // Cleanup MCP connections
  const { closeMcpClients } = await import('./mcp/client.js');
  await closeMcpClients();
}
