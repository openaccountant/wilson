import type { Database } from '../db/compat-sqlite.js';
import { AgentRunnerController } from '../controllers/index.js';
import { InMemoryChatHistory } from '../utils/in-memory-chat-history.js';
import { getConfiguredModel } from '../utils/config.js';
import { initDataContext } from '../agent/prompts.js';
import { logger } from '../utils/logger.js';

let chatHistory: InMemoryChatHistory | null = null;
let agentRunner: AgentRunnerController | null = null;

/**
 * Initialize a chat session for the dashboard.
 * Reuses the same agent runner as headless mode.
 */
export function initChatSession(db: Database): void {
  const { model, provider } = getConfiguredModel();

  initDataContext(db);

  chatHistory = new InMemoryChatHistory();
  chatHistory.setDatabase(db);
  agentRunner = new AgentRunnerController({ model, modelProvider: provider, maxIterations: 10 }, chatHistory);
  logger.info(`Dashboard chat session initialized`, { model, provider });
}

/**
 * Handle a chat message from the dashboard UI.
 * If sessionId is provided, messages are appended to that session.
 * Returns the agent's response text.
 */
export async function handleChatMessage(query: string, sessionId?: string): Promise<string> {
  if (!agentRunner || !chatHistory) {
    logger.warn(`Dashboard chat: session not initialized`);
    return 'Chat session not initialized.';
  }

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
    return answer;
  } catch (err) {
    const durationMs = Date.now() - startTime;
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error(`Dashboard chat error`, { durationMs, error: errorMsg });
    return `Error: ${errorMsg}`;
  }
}
