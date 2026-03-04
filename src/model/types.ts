import { z } from 'zod';

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
}

export interface ToolInvokeConfig {
  metadata?: Record<string, unknown>;
  signal?: AbortSignal;
  /** Active model from the parent agent — tools like chains should inherit this. */
  model?: string;
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
  outputSchema?: z.ZodType;
  signal?: AbortSignal;
}
