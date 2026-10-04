import { Agent } from '../agent/agent.js';
import type { InMemoryChatHistory } from '../utils/in-memory-chat-history.js';
import type {
  AgentConfig,
  AgentEvent,
  ApprovalDecision,
  DoneEvent,
  ToolApprovalRequest,
} from '../agent/index.js';
import type { DisplayEvent } from '../agent/types.js';
import type { HistoryItem, HistoryItemStatus, WorkingState } from '../types.js';
import { randomUUID } from 'node:crypto';

type ChangeListener = () => void;

export interface RunQueryResult {
  answer: string;
}

export interface AgentRunnerOptions {
  /**
   * How tool approval requests are answered (#152).
   * - 'ask' (default): the request waits as `pendingApproval` until a UI calls
   *   respondToApproval (the TUI, the dashboard chat).
   * - 'deny': nobody can answer (headless --run), so every request is denied
   *   immediately — fail closed, never hang, never write.
   */
  approvals?: 'ask' | 'deny';
}

/** A prompt bound to one approval request (see bindPendingApproval). */
export interface BoundApproval {
  request: ToolApprovalRequest;
  requestId: string;
  /** Answer the bound request; false (and nothing happens) if it is no longer the pending one. */
  respond: (decision: ApprovalDecision) => boolean;
}

export class AgentRunnerController {
  private historyValue: HistoryItem[] = [];
  private workingStateValue: WorkingState = { status: 'idle' };
  private errorValue: string | null = null;
  private pendingApprovalValue: ToolApprovalRequest | null = null;
  /** Fresh per approval request; answers must name it to be accepted (see respondToApproval). */
  private pendingApprovalIdValue: string | null = null;
  private agentConfig: AgentConfig;
  private readonly inMemoryChatHistory: InMemoryChatHistory;
  private readonly onChange?: ChangeListener;
  private abortController: AbortController | null = null;
  private approvalResolve: ((decision: ApprovalDecision) => void) | null = null;
  private sessionApprovedTools = new Set<string>();
  private readonly approvals: 'ask' | 'deny';

  constructor(
    agentConfig: AgentConfig,
    inMemoryChatHistory: InMemoryChatHistory,
    onChange?: ChangeListener,
    options: AgentRunnerOptions = {},
  ) {
    this.agentConfig = agentConfig;
    this.inMemoryChatHistory = inMemoryChatHistory;
    this.onChange = onChange;
    this.approvals = options.approvals ?? 'ask';
  }

  /** Update the model used for subsequent agent runs (e.g. after /model switch). */
  updateModel(model: string, modelProvider: string) {
    this.agentConfig = { ...this.agentConfig, model, modelProvider };
  }

  get history(): HistoryItem[] {
    return this.historyValue;
  }

  get workingState(): WorkingState {
    return this.workingStateValue;
  }

  get error(): string | null {
    return this.errorValue;
  }

  get pendingApproval(): ToolApprovalRequest | null {
    return this.pendingApprovalValue;
  }

  /**
   * Unique id of the in-flight approval request (null when none). A new id is
   * minted for every request, so a UI that bound itself to one request (the
   * dashboard chat's approval card) can prove it is answering that request
   * and not whatever happens to be pending now.
   */
  get pendingApprovalId(): string | null {
    return this.pendingApprovalIdValue;
  }

  /** Tools denied at the approval gate during the most recent query, in order. */
  get lastDeniedTools(): string[] {
    const last = this.historyValue[this.historyValue.length - 1];
    if (!last) return [];
    return last.events.flatMap((e) => (e.event.type === 'tool_denied' ? [e.event.tool] : []));
  }

  get isProcessing(): boolean {
    return (
      this.historyValue.length > 0 && this.historyValue[this.historyValue.length - 1]?.status === 'processing'
    );
  }

  setError(error: string | null) {
    this.errorValue = error;
    this.emitChange();
  }

  /**
   * Answer the pending approval request. With `requestId`, the answer applies
   * only if that exact request is still the pending one; otherwise nothing
   * happens. Returns whether a request was answered.
   */
  respondToApproval(decision: ApprovalDecision, requestId?: string): boolean {
    if (!this.approvalResolve) {
      return false;
    }
    if (requestId !== undefined && requestId !== this.pendingApprovalIdValue) {
      return false;
    }
    const resolve = this.approvalResolve;
    this.clearPendingApproval();
    resolve(decision);
    if (decision !== 'deny') {
      this.workingStateValue = { status: 'thinking' };
    }
    this.emitChange();
    return true;
  }

  /**
   * Bind a prompt to the request pending right now: its `respond` answers
   * that exact request (by its pendingApprovalId) and nothing else, so a
   * prompt still on screen after its request was cancelled or replaced
   * cannot answer the next one. Null when nothing is pending. Used by the
   * TUI prompt (src/cli.ts), matching the dashboard card's binding.
   */
  bindPendingApproval(): BoundApproval | null {
    const request = this.pendingApprovalValue;
    const requestId = this.pendingApprovalIdValue;
    if (!request || !requestId) return null;
    return {
      request,
      requestId,
      respond: (decision) => this.respondToApproval(decision, requestId),
    };
  }

  private clearPendingApproval() {
    this.approvalResolve = null;
    this.pendingApprovalValue = null;
    this.pendingApprovalIdValue = null;
  }

  cancelExecution() {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    if (this.approvalResolve) {
      const resolve = this.approvalResolve;
      this.clearPendingApproval();
      resolve('deny');
    }
    this.markLastProcessing('interrupted');
    this.workingStateValue = { status: 'idle' };
    this.emitChange();
  }

  /**
   * Run one query. `options.approvals` overrides the runner's approval policy
   * for this run only — e.g. 'deny' for a dashboard user whose role cannot
   * write (#156): every mutating call is denied at once, no card is raised.
   */
  async runQuery(query: string, options: { approvals?: 'ask' | 'deny' } = {}): Promise<RunQueryResult | undefined> {
    const approvals = options.approvals ?? this.approvals;
    const controller = new AbortController();
    this.abortController = controller;
    let finalAnswer: string | undefined;

    const startTime = Date.now();
    const item: HistoryItem = {
      id: String(startTime),
      query,
      events: [],
      answer: '',
      status: 'processing',
      startTime,
    };
    this.historyValue = [...this.historyValue, item];
    this.inMemoryChatHistory.saveUserQuery(query);
    this.errorValue = null;
    this.workingStateValue = { status: 'thinking' };
    this.emitChange();

    try {
      const agent = await Agent.create({
        ...this.agentConfig,
        signal: controller.signal,
        // Bound to this run: once it is cancelled, any later approval request
        // it makes (an LLM call that was already in flight returning a
        // mutating tool call) is denied instead of raising a new card.
        requestToolApproval: (request) =>
          controller.signal.aborted || approvals === 'deny'
            ? Promise.resolve<ApprovalDecision>('deny')
            : this.requestToolApproval(request),
        sessionApprovedTools: this.sessionApprovedTools,
      });
      const stream = agent.run(query, this.inMemoryChatHistory);
      for await (const event of stream) {
        if (event.type === 'done') {
          finalAnswer = (event as DoneEvent).answer;
        }
        await this.handleEvent(event);
      }
      if (finalAnswer) {
        return { answer: finalAnswer };
      }
      return undefined;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        this.markLastProcessing('interrupted');
        this.workingStateValue = { status: 'idle' };
        this.emitChange();
        return undefined;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.errorValue = message;
      this.markLastProcessing('error');
      this.workingStateValue = { status: 'idle' };
      this.emitChange();
      return undefined;
    } finally {
      if (this.abortController === controller) this.abortController = null;
    }
  }

  private requestToolApproval = (request: ToolApprovalRequest) => {
    if (this.approvals === 'deny') {
      return Promise.resolve<ApprovalDecision>('deny');
    }
    if (this.approvalResolve) {
      // One approval at a time per runner. A second request would overwrite
      // the first one's resolver (leaving it hanging) and let an answer meant
      // for one request settle the other — deny it instead (fail closed).
      return Promise.resolve<ApprovalDecision>('deny');
    }
    return new Promise<ApprovalDecision>((resolve) => {
      this.approvalResolve = resolve;
      this.pendingApprovalValue = request;
      this.pendingApprovalIdValue = randomUUID();
      this.workingStateValue = { status: 'approval', toolName: request.tool };
      this.emitChange();
    });
  };

  private async handleEvent(event: AgentEvent) {
    switch (event.type) {
      case 'thinking':
        this.workingStateValue = { status: 'thinking' };
        this.pushEvent({
          id: `thinking-${Date.now()}`,
          event,
          completed: true,
        });
        break;
      case 'tool_start': {
        const toolId = `tool-${event.tool}-${Date.now()}`;
        this.workingStateValue = { status: 'tool', toolName: event.tool };
        this.updateLastItem((last) => ({
          ...last,
          activeToolId: toolId,
          events: [
            ...last.events,
            {
              id: toolId,
              event,
              completed: false,
            } as DisplayEvent,
          ],
        }));
        break;
      }
      case 'tool_progress':
        this.updateLastItem((last) => ({
          ...last,
          events: last.events.map((entry) =>
            entry.id === last.activeToolId ? { ...entry, progressMessage: event.message } : entry,
          ),
        }));
        break;
      case 'tool_end':
        this.finishToolEvent(event);
        this.workingStateValue = { status: 'thinking' };
        break;
      case 'tool_error':
        this.finishToolEvent(event);
        this.workingStateValue = { status: 'thinking' };
        break;
      case 'tool_approval':
        this.pushEvent({
          id: `approval-${event.tool}-${Date.now()}`,
          event,
          completed: true,
        });
        break;
      case 'tool_denied':
        this.pushEvent({
          id: `denied-${event.tool}-${Date.now()}`,
          event,
          completed: true,
        });
        break;
      case 'tool_selection':
        // Local tool selection diagnostics: logged by the agent, not displayed.
        return;
      case 'tool_limit':
      case 'context_cleared':
        this.pushEvent({
          id: `${event.type}-${Date.now()}`,
          event,
          completed: true,
        });
        break;
      case 'done': {
        const done = event as DoneEvent;
        if (done.answer) {
          await this.inMemoryChatHistory.saveAnswer(done.answer).catch(() => {});
        }
        this.updateLastItem((last) => ({
          ...last,
          answer: done.answer,
          status: 'complete',
          duration: done.totalTime,
          tokenUsage: done.tokenUsage,
          tokensPerSecond: done.tokensPerSecond,
        }));
        this.workingStateValue = { status: 'idle' };
        break;
      }
    }
    this.emitChange();
  }

  private finishToolEvent(event: AgentEvent) {
    this.updateLastItem((last) => ({
      ...last,
      activeToolId: undefined,
      events: last.events.map((entry) =>
        entry.id === last.activeToolId ? { ...entry, completed: true, endEvent: event } : entry,
      ),
    }));
  }

  private pushEvent(displayEvent: DisplayEvent) {
    this.updateLastItem((last) => ({ ...last, events: [...last.events, displayEvent] }));
  }

  private updateLastItem(updater: (item: HistoryItem) => HistoryItem) {
    const last = this.historyValue[this.historyValue.length - 1];
    if (!last || last.status !== 'processing') {
      return;
    }
    const next = updater(last);
    this.historyValue = [...this.historyValue.slice(0, -1), next];
  }

  private markLastProcessing(status: HistoryItemStatus) {
    const last = this.historyValue[this.historyValue.length - 1];
    if (!last || last.status !== 'processing') {
      return;
    }
    this.historyValue = [...this.historyValue.slice(0, -1), { ...last, status }];
  }

  private emitChange() {
    this.onChange?.();
  }
}
