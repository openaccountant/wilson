import type { Database } from '../db/compat-sqlite.js';
import { AgentRunnerController } from '../controllers/index.js';
import { InMemoryChatHistory } from '../utils/in-memory-chat-history.js';
import { getConfiguredModel } from '../utils/config.js';
import { initAgentTools } from '../agent/init-tools.js';
import { logger } from '../utils/logger.js';

let chatHistory: InMemoryChatHistory | null = null;
let agentRunner: AgentRunnerController | null = null;

// Last model applied to the runner + history (null = nothing applied yet).
let appliedModel: { model: string; provider: string } | null = null;

/**
 * Last chat model applied to the runner and history (null before the first
 * apply). Test/diagnostic accessor.
 */
export function getAppliedChatModel(): { model: string; provider: string } | null {
  return appliedModel;
}

/** The chat history backing the dashboard chat (null before initChatSession). */
export function getActiveChatHistory(): InMemoryChatHistory | null {
  return chatHistory;
}

/**
 * Re-read the chat model from settings and, when it changed, apply it through
 * the same live-update path the TUI's /model switch uses:
 * agentRunner.updateModel(model, provider) + chatHistory.setModel(model).
 *
 * This is the single apply point for the chat model: the panel write route
 * only persists the setting, and this refresh runs per dashboard message —
 * so the next message (and its background summarize/relevance calls, which
 * read chatHistory's model) uses the new model with no restart. One mechanism
 * covers every writer of the setting: the panel, the TUI's /model switch, or
 * a hand-edited settings.json.
 */
export function refreshChatModel(): void {
  if (!agentRunner || !chatHistory) return;
  const { model, provider } = getConfiguredModel();
  if (
    appliedModel &&
    appliedModel.model === model &&
    appliedModel.provider === provider
  ) {
    return;
  }
  agentRunner.updateModel(model, provider);
  chatHistory.setModel(model);
  appliedModel = { model, provider };
  logger.info(`Dashboard chat model applied`, { model, provider });
}

/**
 * Initialize a chat session for the dashboard.
 * Reuses the same agent runner as headless mode.
 */
export function initChatSession(db: Database): void {
  const { model, provider } = getConfiguredModel();

  // Wire every tool to the DB — without this the agent's tool calls fail and
  // the model answers from thin air instead of the user's real transactions.
  initAgentTools(db);

  chatHistory = new InMemoryChatHistory();
  chatHistory.setDatabase(db);
  agentRunner = new AgentRunnerController({ model, modelProvider: provider, maxIterations: 10 }, chatHistory);

  // Fresh runner + history: force re-apply so the session never rides the
  // InMemoryChatHistory DEFAULT_MODEL — the session starts on the configured
  // chat model (and stays live via refreshChatModel on every message).
  appliedModel = null;
  refreshChatModel();
  logger.info(`Dashboard chat session initialized`, { model, provider });
}

/**
 * Handle a chat message from the dashboard UI.
 * If sessionId is provided, messages are appended to that session.
 * Returns the agent's response text.
 */
export async function handleChatMessage(
  query: string, sessionId?: string
): Promise<{ answer: string; sessionId: string | null }> {
  if (!agentRunner || !chatHistory) {
    logger.warn(`Dashboard chat: session not initialized`);
    return { answer: 'Chat session not initialized.', sessionId: null };
  }

  // Per-message resolution: a chat-model change (panel write, TUI /model
  // switch, hand-edited settings) applies to the very next message without a
  // restart — the agent runner is re-configured and the background
  // summarize/relevance consumers follow chatHistory's model.
  refreshChatModel();

  if (sessionId) {
    chatHistory.setSessionId(sessionId);
    logger.debug(`Dashboard chat: switched to session ${sessionId}`);
  }

  logger.info(`Dashboard chat query`, { query: query.slice(0, 200), sessionId: sessionId ?? chatHistory.getSessionId() });
  const startTime = Date.now();

  try {
    const result = await agentRunner.runQuery(query);
    const durationMs = Date.now() - startTime;
    const answer = result?.answer ?? 'No response generated.';
    logger.info(`Dashboard chat response`, { durationMs, answerChars: answer.length });
    return { answer, sessionId: chatHistory.getSessionId() ?? null };
  } catch (err) {
    const durationMs = Date.now() - startTime;
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error(`Dashboard chat error`, { durationMs, error: errorMsg });
    return { answer: `Error: ${errorMsg}`, sessionId: chatHistory.getSessionId() ?? null };
  }
}
