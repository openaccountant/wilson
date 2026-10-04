import { z } from 'zod';
import type { ApprovalDecision, ToolApprovalRequest } from '../agent/types.js';

/**
 * Open Accountant's own LLM response type — replaces LangChain's AIMessage.
 * Every provider adapter returns this, eliminating all `typeof response === 'string'` branching.
 */
export interface LlmResponse {
  content: string;
  toolCalls: ToolCall[];
  usage?: TokenUsage;
  /** Parsed JSON when outputSchema is provided */
  structured?: unknown;
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

/**
 * Open Accountant's tool definition — replaces LangChain's DynamicStructuredTool / StructuredToolInterface.
 */
export interface ToolDef<TSchema extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  schema: TSchema;
  func: (args: z.infer<TSchema>, config?: ToolInvokeConfig) => Promise<string>;
  /**
   * Whether a call writes to the DB, the filesystem, or an external service.
   * `true` for every call, or a predicate over the (unvalidated) call args for
   * tools that mix reads and writes. The agent executor asks the user to
   * approve every mutating call before it runs (#152). Read-only tools declare
   * `false`; omitted = treated as mutating (fail closed).
   * Helpers: src/tools/mutation.ts.
   */
  mutates?: MutationFlag;
  /**
   * Orchestration (chain/team) tools only: the tool names their steps or
   * members may call. The registry flags the orchestration tool as mutating
   * when any of them is.
   */
  usesTools?: readonly string[];
}

export type MutationFlag = boolean | ((args: Record<string, unknown>) => boolean);

export interface ToolInvokeConfig {
  metadata?: Record<string, unknown>;
  signal?: AbortSignal;
  /** Active model from the parent agent — tools like chains should inherit this. */
  model?: string;
  /**
   * The parent agent's approval handler. Chains and teams pass every tool call
   * their steps/members make through the approval gate with it
   * (src/agent/approval-gate.ts); absent = mutating inner calls are denied.
   */
  requestToolApproval?: (request: ToolApprovalRequest) => Promise<ApprovalDecision>;
  /** The parent agent's session approvals (SessionApprovalScope.key), shared with inner calls. */
  sessionApprovedTools?: Set<string>;
}

/**
 * Provider adapter interface — each provider (OpenAI, Anthropic, Google) implements this.
 */
export interface ProviderAdapter {
  call(options: ProviderCallOptions): Promise<LlmResponse>;
}

export interface ProviderCallOptions {
  model: string;
  systemPrompt: string;
  userPrompt: string;
  tools?: ToolDef[];
  /**
   * Registered tools whose schemas are not in `tools` (local tool selection):
   * listed by name and still callable. Only the Transformers adapter reads it.
   */
  toolIndex?: string[];
  outputSchema?: z.ZodType;
  signal?: AbortSignal;
  /** Generation cap. Honored by the Transformers adapter; other adapters ignore it in this slice. */
  maxTokens?: number;
}
