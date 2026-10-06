import type { Database } from '../db/compat-sqlite.js';
import { AgentRunnerController } from '../controllers/index.js';
import { createHash } from 'node:crypto';
import type { ApprovalDecision, ToolApprovalRequest } from '../agent/types.js';
import { InMemoryChatHistory } from '../utils/in-memory-chat-history.js';
import { getConfiguredModel } from '../utils/config.js';
import { initAgentTools } from '../agent/init-tools.js';
import { logger } from '../utils/logger.js';
import {
  createOperation,
  expirePendingOperationsBySource,
  getOperation,
  isDashboardAuthEnabled,
  isOperationExpired,
  markOperationStatus,
  type McpOperation,
} from '../mcp/store.js';
import { expandSlashCommand } from './chat-commands.js';
import { categorizeTool } from '../tools/categorize/categorize.js';
import type { ToolProgress } from '../model/types.js';
import { getTaskModel } from '../model/task-models.js';
import { resolveProvider } from '../providers.js';
import { formatCategorizeSummary, parseCategorizeResult } from '../tools/categorize/summary.js';
import { canWrite, onAuthEnabled, type DashboardUser } from './auth.js';
import { ensureHandoffSecret, setHandoffReplayDb } from '../training/handoff-tag.js';

/** The dashboard user a chat run belongs to (auth on); null when auth is off. */
export type ChatUser = Pick<DashboardUser, 'id' | 'role'>;

let chatHistory: InMemoryChatHistory | null = null;
let agentRunner: AgentRunnerController | null = null;
/** DB the current runner's approval cards live in (set by initChatSession). */
let chatDb: Database | null = null;

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
 * middleware, and approving needs canWrite (#156); each card is stamped with
 * the user whose run raised it. This only feeds the shared confirmation queue/UI.
 */
const CHAT_ORIGIN = 'dashboard-chat';
const CHAT_SESSION_GENERATION = 'dashboard-chat';

/**
 * Longest a dashboard chat message may run before /api/chat answers with an
 * error. Neither the server route nor the browser has any other timeout, so
 * without this a stuck run (a local model grinding on a prompt it cannot
 * finish, an approval nobody answers) left the request pending forever.
 * Generous: local models legitimately take minutes, and it includes the time
 * spent waiting on an approval card.
 */
const DEFAULT_CHAT_DEADLINE_MS = 10 * 60_000;
let chatDeadlineMs = DEFAULT_CHAT_DEADLINE_MS;

/** Override the chat deadline (tests); null restores the default. */
export function setChatDeadlineMs(ms: number | null): void {
  chatDeadlineMs = ms ?? DEFAULT_CHAT_DEADLINE_MS;
}

/** The agent runner's in-flight approval request, if any (diagnostic/test accessor). */
export function getPendingChatApproval(): ToolApprovalRequest | null {
  return agentRunner?.pendingApproval ?? null;
}

/**
 * The approval card (mcp_operations row) currently standing for the runner's
 * pending request, and the identity of that exact request: the request object
 * itself, the runner's per-request id (a nonce minted for every request) and
 * the tool name + canonical args hash. A card answers only the request it was
 * created for; anything else is refused (see respondToChatOperation).
 */
interface ChatApprovalBinding {
  operationId: string;
  request: ToolApprovalRequest;
  requestId: string;
  tool: string;
  argsHash: string;
}

let binding: ChatApprovalBinding | null = null;

/**
 * The user whose run is in flight (#156), or null when unknown (auth off, or
 * an in-process caller that named nobody). Its approval cards are stamped
 * with this user, so only they can see, approve or reject them — not whoever
 * happens to poll /api/mcp/operations first.
 */
let chatRunOwner: ChatUser | null = null;

/** Deterministic JSON (object keys sorted at every level). */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function argsHash(args: unknown): string {
  return createHash('sha256').update(canonicalJson(args)).digest('hex');
}

function isLive(op: McpOperation): boolean {
  return op.status === 'pending' && new Date(op.expires_at).getTime() > Date.now();
}

/**
 * The bound card's request is gone (answered elsewhere, cancelled by the chat
 * deadline, superseded, or its run ended): take the card off the queue so
 * nobody can approve it, and forget it.
 */
function retireBinding(db: Database | null, reason: string): void {
  const b = binding;
  if (!b) return;
  binding = null;
  if (!db) return;
  const op = getOperation(db, b.operationId);
  if (op && op.status === 'pending') {
    markOperationStatus(db, b.operationId, 'expired', { reason });
  }
}

/** Runner change listener: retire the card as soon as its request stops being the pending one. */
function onRunnerChange(runner: AgentRunnerController): void {
  if (runner !== agentRunner || !binding) return;
  if (runner.pendingApprovalId !== binding.requestId) {
    retireBinding(chatDb, runner.pendingApprovalId ? 'superseded' : 'request no longer pending');
  }
}

/**
 * Surface the agent runner's in-flight approval request (if any) as an
 * mcp_operations row, so the dashboard's confirmation UI can render and
 * resolve it through the exact same queue used for WebMCP mutations —
 * "one confirmation surface, not two". Lazily creates the row the first
 * time a given pending request is observed; returns the existing row on
 * subsequent polls until it resolves. A row whose request is no longer the
 * pending one is expired here, so it drops out of /api/mcp/operations.
 */
export function getPendingChatOperation(
  db: Database,
  scope: { profile: string; userId: number | null; role: 'admin' | 'viewer' }
): McpOperation | null {
  // `scope` names the profile the card belongs to. It is NOT an identity fallback: see below.
  // A chat operation whose confirmation window closed can never be approved,
  // so it must not stay in the queue (or leave the agent waiting) forever.
  if (binding) {
    const tracked = getOperation(db, binding.operationId);
    if (tracked && (tracked.status === 'expired' || (tracked.status === 'pending' && isOperationExpired(tracked)))) {
      expireChatOperation(db, tracked.id);
    }
  }

  const runner = agentRunner;
  const current = runner?.pendingApproval ?? null;
  const requestId = runner?.pendingApprovalId ?? null;

  if (binding && (!current || binding.requestId !== requestId || binding.request !== current)) {
    retireBinding(db, current ? 'superseded' : 'request no longer pending');
  }
  if (!runner || !current || !requestId) return null;

  if (!binding) {
    // A chat mutation belongs to the user whose run asked for it. With auth on
    // and no run owner there is nobody to attribute it to, and falling back to
    // whoever is polling the queue would hand the card to the wrong account (an
    // ownerless row is visible to nobody). Refuse to create it and tell the
    // agent "no", so it does not wait for a card that will never appear. With
    // auth off there is one implicit user, so the card is theirs.
    if (!chatRunOwner && isDashboardAuthEnabled(db)) {
      runner.respondToApproval('deny', requestId);
      return null;
    }
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
      userId: chatRunOwner?.id ?? null,
      role: chatRunOwner?.role ?? 'admin',
      // The request can wait as long as the chat deadline allows; the card
      // must not expire before the request it stands for.
      ttlMs: chatDeadlineMs,
    });
    binding = {
      operationId: operation.id,
      request: current,
      requestId,
      tool: current.tool,
      argsHash: argsHash(current.args),
    };
    return operation;
  }

  const op = getOperation(db, binding.operationId);
  if (!op || !isLive(op)) {
    // The card expired (or vanished) while its request still waits: nobody
    // can answer it any more, so deny the request rather than hang (fail closed).
    const b = binding;
    retireBinding(db, 'card expired');
    runner.respondToApproval('deny', b.requestId);
    return null;
  }
  return op;
}

export type ChatOperationResult =
  | { ok: true; status: 'committed' | 'rejected' }
  | { ok: false; error: string };

const STALE_CARD_ERROR =
  'This approval is no longer pending — the request it was created for was cancelled, answered or replaced. Nothing was changed.';

/**
 * Resolve a chat-originated operation. Unlike a WebMCP/HTTP-MCP operation,
 * this never applies a DB write itself — it unblocks the agent's own
 * in-flight tool call (src/agent/tool-executor.ts), which then runs the
 * tool's real `func()` exactly as it always has.
 *
 * A card answers only the exact request it was created for: the operation
 * must be the bound one, still pending and unexpired, and the runner's pending
 * request must still be that same request (same object, same per-request id,
 * same tool and canonical args hash — on the runner and in the stored row).
 * Anything else is refused with an error and changes nothing; a stale card is
 * taken off the queue.
 */
export function respondToChatOperation(db: Database, operationId: string, decision: ApprovalDecision): ChatOperationResult {
  const runner = agentRunner;
  const b = binding;
  const op = getOperation(db, operationId);
  const stale = (): ChatOperationResult => {
    if (op && op.source === 'chat' && op.status === 'pending' && b?.operationId !== operationId) {
      markOperationStatus(db, operationId, 'expired', { reason: 'stale card' });
    }
    return { ok: false, error: STALE_CARD_ERROR };
  };

  if (runner && b && b.operationId === operationId && (!op || !isLive(op))) {
    // The bound card ran out of time while its request still waits: fail
    // closed, as getPendingChatOperation would on its next poll.
    retireBinding(db, 'card expired');
    runner.respondToApproval('deny', b.requestId);
    return { ok: false, error: STALE_CARD_ERROR };
  }
  if (!runner || !b || b.operationId !== operationId || !op || op.source !== 'chat') {
    return stale();
  }
  const current = runner.pendingApproval;
  let rowArgs: unknown;
  try {
    rowArgs = JSON.parse(op.args_json);
  } catch {
    rowArgs = undefined;
  }
  const exact =
    current !== null &&
    current === b.request &&
    runner.pendingApprovalId === b.requestId &&
    current.tool === b.tool &&
    argsHash(current.args) === b.argsHash &&
    op.tool_name === b.tool &&
    argsHash(rowArgs) === b.argsHash;
  if (!exact) {
    retireBinding(db, 'request no longer pending');
    return { ok: false, error: STALE_CARD_ERROR };
  }

  // Unbind before answering: the runner's change listener must not expire
  // the card we are about to resolve.
  binding = null;
  if (!runner.respondToApproval(decision, b.requestId)) {
    markOperationStatus(db, operationId, 'expired', { reason: 'request no longer pending' });
    return { ok: false, error: STALE_CARD_ERROR };
  }
  // 'committed' here means "approved, and the agent's own tool call has been
  // unblocked to run". Any mutating agent tool can land here (#152), not just
  // categorize; the tool applies its own write once unblocked, so there is no
  // revision-checked delta for this row to guard.
  const status = decision === 'deny' ? 'rejected' : 'committed';
  markOperationStatus(db, operationId, status);
  return { ok: true, status };
}

/**
 * The dashboard chat runs one agent query at a time. The runner, its chat
 * history (and current session id) and its single approval slot are shared
 * server-side singletons, so a second concurrent POST /api/chat — another tab,
 * or a message sent while a cancelled run is still winding down — is refused
 * with `busy` (POST /api/chat answers 409) instead of queued or interleaved.
 * Refusing rather than waiting keeps one run's approval card from ever
 * appearing to (and being approved from) a request that did not raise it. The
 * chat UI already never sends while a reply is outstanding.
 *
 * Held until the run itself settles, not just until /api/chat answers: after
 * the chat deadline the cancelled run may still be finishing an in-flight
 * model call.
 */
let activeChatRun: Promise<void> | null = null;

/**
 * Stops the run `activeChatRun` stands for: the agent runner's cancel for a chat message, an abort of the
 * categorizer for "/categorize". Set and cleared with `activeChatRun`; one cancel path serves deactivation
 * (cancelChatRunForUser), auth being switched on under an ownerless run, and a replaced session.
 */
let cancelActiveRun: (() => void) | null = null;

/** True while a dashboard chat agent run is in progress (diagnostic/test accessor). */
export function isChatRunActive(): boolean {
  return activeChatRun !== null;
}

const STALE_PROFILE_MESSAGE =
  'The active profile changed while this message was being sent, so it was not run. Nothing was changed; send it again on the current profile.';

const CHAT_BUSY_MESSAGE =
  'Another chat message is still running. Wait for it to finish (or answer its approval) and try again.';

/**
 * A chat operation's confirmation window closed unanswered: record it as
 * expired, deny the agent's in-flight approval (it is told "no", exactly as if
 * the user had rejected) and forget the request, so the card does not come
 * back and the agent is not left blocked. Safe to call on an already-resolved id.
 */
export function expireChatOperation(db: Database, operationId: string): boolean {
  const op = getOperation(db, operationId);
  if (!op || op.source !== 'chat') return false;
  if (op.status === 'pending') markOperationStatus(db, operationId, 'expired', { reason: 'card expired' });
  const b = binding;
  if (!b || b.operationId !== operationId) return false;
  binding = null;
  agentRunner?.respondToApproval('deny', b.requestId);
  return true;
}

/**
 * A deactivated user's in-flight chat run ends with the account (#159): the
 * run they own is aborted, its pending approval is denied and its card is
 * taken off the queue, so nothing it was about to do can be approved or run.
 * Without this the run kept reading until its deadline. Covers a "/categorize"
 * too. Returns true when a run was cancelled; a run owned by someone else (or none) is left alone, and so
 * is any run when `db` is not the chat session's database (user ids are per profile).
 */
export function cancelChatRunForUser(db: Database, userId: number): boolean {
  // User ids are per profile database: only the session's own database can name this run's owner.
  if (db !== chatDb) return false;
  if (!activeChatRun || !cancelActiveRun || chatRunOwner?.id !== userId) return false;
  // Retire the card first, so no answer can reach the request while the run winds down.
  retireBinding(chatDb, 'user_deactivated');
  cancelActiveRun();
  return true;
}

/**
 * Dashboard auth was switched on for `db`. A run in flight with no owner (it started while auth was off, so
 * it is anonymous: user null) must not carry on under the new login rules. Nobody owns its approval cards, and
 * a "/categorize" writes without any card, so both are cancelled and their pending card taken off the queue.
 * A run that has an owner, or one on another profile's database, is left alone.
 */
function cancelOwnerlessRun(db: Database): void {
  if (db !== chatDb) return;
  if (!activeChatRun || !cancelActiveRun || chatRunOwner !== null) return;
  retireBinding(chatDb, 'auth_enabled');
  cancelActiveRun();
}

// enableAuth calls this on the off -> on transition (a hook, because auth.ts cannot import this module).
onAuthEnabled(cancelOwnerlessRun);

/**
 * Initialize a chat session for the dashboard.
 * Reuses the same agent runner as headless mode.
 */
export function initChatSession(db: Database): void {
  const { model, provider } = getConfiguredModel();

  // Replacing the session (profile switch, restart): the old runner can no
  // longer be reached by any approval card, so stop it (denies its pending
  // approval) and expire every chat card still pending in this DB — rows left
  // behind by a previous runner or server process can never be answered. The
  // previous DB is not touched (a profile switch may already have closed it);
  // its leftover cards are expired here when it is next opened.
  const previous = agentRunner;
  const cancelPrevious = cancelActiveRun;
  binding = null;
  agentRunner = null;
  activeChatRun = null;
  cancelActiveRun = null;
  chatRunOwner = null;
  previous?.cancelExecution();
  cancelPrevious?.(); // a "/categorize" has no runner: stop it before it writes into the old profile's tools
  try {
    expirePendingOperationsBySource(db, 'chat', 'chat session replaced');
  } catch (err) {
    // Hygiene only — the cards are unanswerable either way (no runner holds
    // their requests, so respondToChatOperation refuses them).
    logger.warn(`Dashboard chat: could not expire leftover approval cards`, {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  chatDb = db;
  setHandoffReplayDb(db);
  // Create the handoff tag secret now (idempotent), so only rows recorded before this code ran are "legacy".
  try {
    ensureHandoffSecret(db);
  } catch (err) {
    logger.warn('Dashboard chat: could not create the handoff tag secret', { error: err instanceof Error ? err.message : String(err) });
  }

  // Wire every tool to the DB — without this the agent's tool calls fail and
  // the model answers from thin air instead of the user's real transactions.
  initAgentTools(db);

  chatHistory = new InMemoryChatHistory();
  chatHistory.setDatabase(db);
  const runner: AgentRunnerController = new AgentRunnerController(
    { model, modelProvider: provider, maxIterations: 10 },
    chatHistory,
    () => onRunnerChange(runner),
  );
  agentRunner = runner;

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
 *
 * Slash commands are expanded first (chat-commands.ts); help, usage errors
 * and unknown commands are answered directly without calling any model.
 * `contextBlock` (resolved "@" mentions, see mentions.ts) is prepended to the
 * query — runQuery only takes a string, and this keeps the ids in history.
 */
export async function handleChatMessage(
  query: string, sessionId?: string, contextBlock?: string, options: { user?: ChatUser | null; db?: Database } = {}
): Promise<{ answer: string; sessionId: string | null; busy?: true; stale?: true }> {
  const user = options.user ?? null;
  // The runner and the agent tools are bound to the CURRENT profile's db (initChatSession). A caller that
  // authenticated against a different db (a request that outlived a profile switch) must not run on this one.
  if (options.db && options.db !== chatDb) {
    logger.warn(`Dashboard chat: refused a message authenticated against a different profile than the chat session`);
    return { answer: STALE_PROFILE_MESSAGE, sessionId: null, stale: true };
  }
  // A user whose role cannot write (viewer, with auth on) gets the same rule
  // in chat as on the REST write routes (#156): no write runs, and no card is
  // raised for one — every mutating tool call is denied at once.
  const readOnlyUser = user !== null && !canWrite(user.role);
  const expansion = expandSlashCommand(query);
  if ('direct' in expansion) {
    return { answer: expansion.direct, sessionId: sessionId ?? chatHistory?.getSessionId() ?? null };
  }
  if ('action' in expansion && readOnlyUser) {
    return { answer: viewerCannotWrite(user!, '/categorize'), sessionId: sessionId ?? chatHistory?.getSessionId() ?? null };
  }
  if ('action' in expansion) {
    // "/categorize" is a run like any other message: one at a time, owned by whoever typed it, and cancellable
    // (deactivation of its owner, auth switched on under an anonymous run, a replaced session).
    if (activeChatRun) {
      logger.warn(`Dashboard chat: refused /categorize while another run is active`);
      return { answer: CHAT_BUSY_MESSAGE, sessionId: sessionId ?? chatHistory?.getSessionId() ?? null, busy: true };
    }
    const controller = new AbortController();
    const categorizing = runCategorizeCommand(expansion.limit, controller.signal);
    const settled: Promise<void> = categorizing.then(() => {}, () => {}).finally(() => {
      if (activeChatRun !== settled) return; // the session was replaced meanwhile
      activeChatRun = null;
      cancelActiveRun = null;
      chatRunOwner = null;
    });
    activeChatRun = settled;
    cancelActiveRun = () => controller.abort();
    chatRunOwner = user;
    return { answer: await categorizing, sessionId: sessionId ?? chatHistory?.getSessionId() ?? null };
  }
  query = contextBlock ? `${contextBlock}${expansion.query}` : expansion.query;

  if (!agentRunner || !chatHistory) {
    logger.warn(`Dashboard chat: session not initialized`);
    return { answer: 'Chat session not initialized.', sessionId: null };
  }

  // One run at a time (see activeChatRun). Checked before anything touches
  // the shared runner or history (model refresh, session switch).
  if (activeChatRun) {
    logger.warn(`Dashboard chat: refused a concurrent message while another run is active`);
    return { answer: CHAT_BUSY_MESSAGE, sessionId: sessionId ?? chatHistory.getSessionId() ?? null, busy: true };
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

  const runner = agentRunner;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  chatRunOwner = user;
  cancelActiveRun = () => runner.cancelExecution();
  const run = runner.runQuery(query, readOnlyUser ? { approvals: 'deny' } : {});
  const settled: Promise<void> = run.then(
    () => {},
    () => {},
  ).finally(() => {
    if (activeChatRun !== settled) return; // the session was replaced meanwhile
    activeChatRun = null;
    cancelActiveRun = null;
    // The owner applies only to the run it started (held until the run settles, which can outlast the
    // request after the deadline); never leave it behind for the next caller.
    chatRunOwner = null;
    // The run is over: no card of it may stay approvable.
    if (runner === agentRunner) retireBinding(chatDb, 'run ended');
  });
  activeChatRun = settled;
  try {
    const timedOut = new Promise<'timeout'>((resolve) => {
      deadline = setTimeout(() => resolve('timeout'), chatDeadlineMs);
    });
    const result = await Promise.race([run, timedOut]);
    const durationMs = Date.now() - startTime;
    if (result === 'timeout') {
      // Stops the agent loop and denies any pending approval (its card is
      // expired by the runner change listener). An in-flight local inference
      // call cannot be interrupted, but the request settles; the run keeps the
      // chat busy until it has wound down.
      runner.cancelExecution();
      const minutes = Math.round(chatDeadlineMs / 60_000);
      logger.error(`Dashboard chat deadline exceeded`, { durationMs });
      return {
        answer: `Error: The request did not finish within ${minutes >= 1 ? `${minutes} minutes` : `${chatDeadlineMs} ms`} and was cancelled. ` +
          'A local model may be too slow for this request — try a shorter question or a cloud model.',
        sessionId: chatHistory.getSessionId() ?? null,
      };
    }
    // runQuery reports its own failures through `error` and resolves undefined.
    // A denied approval also ends the turn with no answer — say so (#152).
    const denied = runner.lastDeniedTools.at(-1);
    const answer =
      result?.answer ??
      (runner.error
        ? `Error: ${runner.error}`
        : denied
          ? readOnlyUser
            ? viewerCannotWrite(user!, denied)
            : `Cancelled — you denied ${denied}.`
          : 'No response generated.');
    logger.info(`Dashboard chat response`, { durationMs, answerChars: answer.length });
    return { answer, sessionId: chatHistory.getSessionId() ?? null };
  } catch (err) {
    const durationMs = Date.now() - startTime;
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error(`Dashboard chat error`, { durationMs, error: errorMsg });
    return { answer: `Error: ${errorMsg}`, sessionId: chatHistory.getSessionId() ?? null };
  } finally {
    clearTimeout(deadline);
  }
}

/** Answer for a write a read-only dashboard user asked for (#156). */
function viewerCannotWrite(user: ChatUser, what: string): string {
  return `Not allowed — your dashboard role (${user.role}) cannot make changes, so ${what} was not run. ` +
    'Nothing was changed. Ask an admin to do this.';
}

/**
 * A bare "/categorize" on a local model does this many transactions per run:
 * at ~15s per batch of 10, a backlog of hundreds would otherwise keep the chat
 * silent for twenty minutes or more. The answer says how many remain.
 */
const LOCAL_CATEGORIZE_CHUNK = 50;

/**
 * Progress of the /categorize run in flight (null when none). Module-level
 * like the rest of the chat state: the dashboard runs one chat request at a
 * time, and GET /api/chat/progress lets the UI show it while POST /api/chat
 * is still pending.
 */
let categorizeProgress: ToolProgress | null = null;

const CATEGORIZE_CANCELLED_MESSAGE =
  '**Categorization cancelled.** It was stopped before it finished (the account that started it was deactivated, ' +
  'or dashboard login was switched on while it ran). Rows it had already categorized stay as they are; nothing further was changed.';

/** Live batch progress of the running /categorize, or null (route + test accessor). */
export function getCategorizeProgress(): ToolProgress | null {
  return categorizeProgress;
}

/**
 * "/categorize [n]": the categorize tool, called directly — the same path as
 * the terminal's /categorize (src/cli.ts). Typing the command is the consent,
 * so there is no approval round-trip, and the categorizer's own small batch
 * prompt is used instead of the agent's full tool-schema prompt. Failures
 * always come back as an answer.
 */
async function runCategorizeCommand(limit: number | undefined, signal: AbortSignal): Promise<string> {
  const startTime = Date.now();
  const local = resolveProvider(getTaskModel('categorization')).id === 'transformers';
  const effectiveLimit = limit ?? (local ? LOCAL_CATEGORIZE_CHUNK : undefined);
  categorizeProgress = null;
  try {
    const resultJson = await categorizeTool.func(
      { ...(effectiveLimit !== undefined ? { limit: effectiveLimit } : {}), skipPendingReview: true },
      { onProgress: (p) => { categorizeProgress = p; }, signal },
    );
    const data = parseCategorizeResult(resultJson);
    let answer = formatCategorizeSummary(data, { errorDetail: true });
    const remaining = data.stillUncategorized ?? 0;
    const held = Math.min(data.pendingReview ?? 0, remaining);
    // Nothing was attempted and only held rows remain: the tool's message already says so.
    const nothingToDo = data.categorized === 0 && !data.totalUncategorized;
    if (!nothingToDo && remaining > 0 && (held > 0 || effectiveLimit !== undefined)) {
      answer += `\n\n${remaining} transactions are still uncategorized` +
        (held > 0 ? ` (${held} of them waiting in the Review tab)` : '');
      // Held rows are skipped, so only the rest has a next chunk to run.
      answer += effectiveLimit !== undefined && remaining > held
        ? ` — send \`/categorize\` again for the next ${effectiveLimit}.`
        : '.';
    }
    logger.info(`Dashboard /categorize`, { durationMs: Date.now() - startTime, limit: effectiveLimit, remaining });
    return answer;
  } catch (err) {
    if (signal.aborted) {
      logger.info(`Dashboard /categorize cancelled`, { durationMs: Date.now() - startTime });
      return CATEGORIZE_CANCELLED_MESSAGE;
    }
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error(`Dashboard /categorize error`, { durationMs: Date.now() - startTime, error: errorMsg });
    return `**Categorization failed:** ${errorMsg}`;
  } finally {
    categorizeProgress = null;
  }
}
