import type { SessionApprovalScope } from '../tools/mutation.js';

/**
 * User's response to a tool approval prompt.
 * - 'allow-once': approve this single invocation
 * - 'allow-session': approve this tool (or this tool + action, for tools whose
 *   writes depend on the action) for the rest of the session; not offered
 *   for chain/team tools, where it counts as 'allow-once'
 * - 'deny': reject and immediately end the agent's turn
 */
export type ApprovalDecision = 'allow-once' | 'allow-session' | 'deny';

/**
 * A tool call waiting for the user's approval. `session` is what
 * 'allow-session' would cover (the tool, or the tool + action), or null when
 * the call can only be approved once (chain/team tools) — see
 * src/tools/mutation.ts::sessionApprovalScope.
 */
export interface ToolApprovalRequest {
  tool: string;
  args: Record<string, unknown>;
  session: SessionApprovalScope | null;
}

/**
 * Agent configuration
 */
export interface AgentConfig {
  /** Model to use for LLM calls (e.g., 'gpt-5.2', 'claude-sonnet-4-20250514') */
  model?: string;
  /** Model provider (e.g., 'openai', 'anthropic', 'google', 'ollama') */
  modelProvider?: string;
  /** Maximum agent loop iterations (default: 10) */
  maxIterations?: number;
  /** AbortSignal for cancelling agent execution */
  signal?: AbortSignal;
  /** Called when a tool needs explicit user approval to proceed */
  requestToolApproval?: (request: ToolApprovalRequest) => Promise<ApprovalDecision>;
  /** Shared set of session approval keys (SessionApprovalScope.key; persists across queries) */
  sessionApprovedTools?: Set<string>;
}

/**
 * Message in conversation history
 */
export interface Message {
  role: 'user' | 'assistant' | 'tool';
  content: string;
}

// ============================================================================
// Agent Events (for real-time streaming UI)
// ============================================================================

/**
 * Agent is processing/thinking
 */
export interface ThinkingEvent {
  type: 'thinking';
  message: string;
}

/**
 * Tool execution started
 */
export interface ToolStartEvent {
  type: 'tool_start';
  tool: string;
  args: Record<string, unknown>;
}

/**
 * Tool execution completed successfully
 */
export interface ToolEndEvent {
  type: 'tool_end';
  tool: string;
  args: Record<string, unknown>;
  result: string;
  duration: number;
}

/**
 * Tool execution failed
 */
export interface ToolErrorEvent {
  type: 'tool_error';
  tool: string;
  error: string;
}

/**
 * Mid-execution progress update from a subagent tool
 */
export interface ToolProgressEvent {
  type: 'tool_progress';
  tool: string;
  message: string;
}

/**
 * Tool call warning due to approaching/exceeding suggested limits
 */
export interface ToolLimitEvent {
  type: 'tool_limit';
  tool: string;
  /** Warning message about tool usage limits */
  warning?: string;
  /** Whether the tool call was blocked (always false - we only warn, never block) */
  blocked: boolean;
}

/**
 * Tool approval decision event for sensitive tools.
 */
export interface ToolApprovalEvent {
  type: 'tool_approval';
  tool: string;
  args: Record<string, unknown>;
  approved: ApprovalDecision;
}

/**
 * Tool execution was denied by user approval flow.
 */
export interface ToolDeniedEvent {
  type: 'tool_denied';
  tool: string;
  args: Record<string, unknown>;
}

/**
 * Context was cleared due to exceeding token threshold (Anthropic-style)
 */
export interface ContextClearedEvent {
  type: 'context_cleared';
  /** Number of tool results that were cleared from context */
  clearedCount: number;
  /** Number of most recent tool results that were kept */
  keptCount: number;
}

/**
 * Local models only: which tools (full schema) and skills a call sees, why,
 * and where the prompt's tokens go. Emitted on a run's first call and again
 * whenever the set changes (design 2026-10-03 §5.8). Not shown or persisted.
 */
export interface ToolSelectionEvent {
  type: 'tool_selection';
  tools: string[];
  /** Registered tools listed by name only (still callable). */
  indexed: string[];
  skills: string[];
  reasons: Record<string, string>;
  /** True when keyword groups stood in for the embedder. */
  fallback: boolean;
  tokens: { fixed: number; tools: number; history: number; results: number; total: number; budget: number };
  /** Trim steps the planner took for this call. */
  trimmed: string[];
}

// Re-export TokenUsage from model types (single source of truth)
import type { TokenUsage } from '../model/types.js';
export type { TokenUsage };

/**
 * Agent completed with final result
 */
export interface DoneEvent {
  type: 'done';
  answer: string;
  toolCalls: Array<{ tool: string; args: Record<string, unknown>; result: string }>;
  iterations: number;
  totalTime: number;
  tokenUsage?: TokenUsage;
  tokensPerSecond?: number;
}

/**
 * Union type for all agent events
 */
export type AgentEvent =
  | ThinkingEvent
  | ToolStartEvent
  | ToolProgressEvent
  | ToolEndEvent
  | ToolErrorEvent
  | ToolApprovalEvent
  | ToolDeniedEvent
  | ToolLimitEvent
  | ContextClearedEvent
  | ToolSelectionEvent
  | DoneEvent;

/**
 * Aggregated event used by the CLI history renderer.
 * Combines lifecycle events (tool_start/tool_end/tool_error) into a single display row.
 */
export interface DisplayEvent {
  id: string;
  event: AgentEvent;
  completed?: boolean;
  endEvent?: AgentEvent;
  progressMessage?: string;
}
