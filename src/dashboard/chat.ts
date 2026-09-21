import type { Database } from '../db/compat-sqlite.js';
import { AgentRunnerController } from '../controllers/index.js';
import type { ApprovalDecision } from '../agent/types.js';
import { InMemoryChatHistory } from '../utils/in-memory-chat-history.js';
import { getConfiguredModel } from '../utils/config.js';
import { initAgentTools } from '../agent/init-tools.js';
import { logger } from '../utils/logger.js';
import { createOperation, getOperation, markOperationStatus, type McpOperation } from '../mcp/store.js';

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
 * Bound scope for chat-originated confirmations — fixed rather than
 * per-browser-tab, because the agent runner itself is a single server-side
 * singleton shared across the dashboard, not a per-tab WebMCP grant. The
 * approve/reject endpoint is still gated by the normal dashboard auth
 * middleware; this only feeds the shared confirmation queue/UI.
 */
const CHAT_ORIGIN = 'dashboard-chat';
const CHAT_SESSION_GENERATION = 'dashboard-chat';

let pendingChatRequest: { tool: string; args: Record<string, unknown> } | null = null;
let pendingChatOperationId: string | null = null;

/**
 * Surface the agent runner's in-flight approval request (if any) as an
 * mcp_operations row, so the dashboard's confirmation UI can render and
 * resolve it through the exact same queue used for WebMCP mutations —
 * "one confirmation surface, not two". Lazily creates the row the first
 * time a given pending request is observed; returns the existing row on
 * subsequent polls until it resolves.
 */
export function getPendingChatOperation(
  db: Database,
  scope: { profile: string; userId: number | null; role: 'admin' | 'viewer' }
): McpOperation | null {
  const current = agentRunner?.pendingApproval ?? null;
  if (!current) {
    pendingChatRequest = null;
    pendingChatOperationId = null;
    return null;
  }

  if (pendingChatRequest !== current || !pendingChatOperationId) {
    const operation = createOperation(db, {
      source: 'chat',
      grantId: null,
      toolName: current.tool,
      args: current.args,
      before: null,
      after: null,
      transactionId: null,
      revisionAtPrepare: null,
      profile: scope.profile,
      origin: CHAT_ORIGIN,
      sessionGeneration: CHAT_SESSION_GENERATION,
      userId: scope.userId,
      role: scope.role,
    });
    pendingChatRequest = current;
    pendingChatOperationId = operation.id;
    return operation;
  }

  return getOperation(db, pendingChatOperationId);
}

/**
 * Resolve a chat-originated operation. Unlike a WebMCP/HTTP-MCP operation,
 * this never applies a DB write itself — it unblocks the agent's own
 * in-flight tool call (src/agent/tool-executor.ts), which then runs the
 * tool's real `func()` exactly as it always has. This is the actual fix for
 * the chat hang: previously nothing ever called respondToApproval() outside
 * the CLI, so the promise in AgentToolExecutor.executeSingle sat forever.
 */
export function respondToChatOperation(db: Database, operationId: string, decision: ApprovalDecision): boolean {
  if (operationId !== pendingChatOperationId || !agentRunner?.pendingApproval) {
    return false;
  }
  agentRunner.respondToApproval(decision);
  // 'committed' here means "approved, and the agent's own tool call has been
  // unblocked to run" — the bulk categorize tool has no revision-checked
  // delta of its own, so there's nothing further for this row to guard.
  markOperationStatus(db, operationId, decision === 'deny' ? 'rejected' : 'committed');
  pendingChatRequest = null;
  pendingChatOperationId = null;
  return true;
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
