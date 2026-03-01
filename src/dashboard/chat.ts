import type { Database } from '../db/compat-sqlite.js';
import { AgentRunnerController } from '../controllers/index.js';
import { InMemoryChatHistory } from '../utils/in-memory-chat-history.js';

let chatHistory: InMemoryChatHistory | null = null;
let agentRunner: AgentRunnerController | null = null;

/**
 * Initialize a chat session for the dashboard.
 * Reuses the same agent runner as headless mode.
 */
export function initChatSession(_db: Database): void {
  chatHistory = new InMemoryChatHistory();
  agentRunner = new AgentRunnerController({ maxIterations: 10 }, chatHistory);
}

/**
 * Handle a chat message from the dashboard UI.
 * Returns the agent's response text.
 */
export async function handleChatMessage(query: string): Promise<string> {
  if (!agentRunner) return 'Chat session not initialized.';

  try {
    const result = await agentRunner.runQuery(query);
    return result?.answer ?? 'No response generated.';
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}
