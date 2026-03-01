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
import { initImportTool } from './tools/import/csv-import.js';
import { initCategorizeTool } from './tools/categorize/categorize.js';
import { initTransactionSearchTool } from './tools/query/transaction-search.js';
import { initSpendingSummaryTool } from './tools/query/spending-summary.js';
import { initAnomalyDetectTool } from './tools/query/anomaly-detect.js';
import { initMonarchTool } from './tools/import/monarch.js';
import { initExportTool } from './tools/export/export-transactions.js';
import { initMcpClients } from './mcp/client.js';
import { loadMcpTools } from './mcp/adapter.js';
import { pullOllamaModel, RECOMMENDED_OLLAMA_MODELS } from './utils/model-downloader.js';
import { discoverSkills } from './skills/registry.js';

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
  initSpendingSummaryTool(db);
  initAnomalyDetectTool(db);
  initMonarchTool(db);
  initExportTool(db);

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

  const intro = new IntroComponent(modelSelection.model);
  const errorText = new Text('', 0, 0);
  const workingIndicator = new WorkingIndicatorComponent(tui);
  const editor = new CustomEditor(tui, editorTheme);
  const debugPanel = new DebugPanelComponent(8, true);

  // Set up slash command autocomplete with @ file search
  const slashCommands: SlashCommand[] = [
    { name: 'model', description: 'Switch LLM provider and model' },
    { name: 'pull', description: 'Download an Ollama model' },
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
        '  /model  — Switch LLM provider and model',
        '  /pull   — Download an Ollama model (e.g. /pull granite3-dense:2b)',
        '  /help   — Show this help message',
        ...discoverSkills().map((s) => `  /skill ${s.name}  — ${s.description}`),
      ];
      chatLog.finalizeAnswer(`**Available commands:**\n\n${commands.join('\n')}`);
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
    root.addChild(new Text(theme.primary('\u276f '), 0, 0));
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
