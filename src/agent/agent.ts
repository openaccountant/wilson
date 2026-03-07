import type { LlmResponse } from '../model/types.js';
import type { ToolDef } from '../model/types.js';
import { callLlm, type LlmResult } from '../model/llm.js';
import { interactionStore } from '../utils/interaction-store.js';
import { getTools } from '../tools/registry.js';
import { buildSystemPrompt, buildIterationPrompt, loadSoulDocument, buildBudgetContext, buildDataContext, buildGoalContext, buildMemoryContext, buildCustomPromptContext, buildProfileContext } from '../agent/prompts.js';
import { extractTextContent, hasToolCalls } from '../utils/ai-message.js';
import { InMemoryChatHistory } from '../utils/in-memory-chat-history.js';
import { buildHistoryContext } from '../utils/history-context.js';
import { estimateTokens, CONTEXT_THRESHOLD, KEEP_TOOL_USES } from '../utils/tokens.js';
import { formatUserFacingError, isContextOverflowError } from '../utils/errors.js';
import type { AgentConfig, AgentEvent, ContextClearedEvent, TokenUsage } from '../agent/types.js';
import { createRunContext, type RunContext } from './run-context.js';
import { AgentToolExecutor } from './tool-executor.js';
import { logger } from '../utils/logger.js';


const DEFAULT_MODEL = 'gpt-5.2';
const DEFAULT_MAX_ITERATIONS = 10;
const MAX_OVERFLOW_RETRIES = 2;
const OVERFLOW_KEEP_TOOL_USES = 3;

/**
 * The core agent class that handles the agent loop and tool execution.
 */
export class Agent {
  private readonly model: string;
  private readonly maxIterations: number;
  private readonly tools: ToolDef[];
  private readonly toolMap: Map<string, ToolDef>;
  private readonly toolExecutor: AgentToolExecutor;
  private readonly systemPrompt: string;
  private readonly signal?: AbortSignal;

  private constructor(
    config: AgentConfig,
    tools: ToolDef[],
    systemPrompt: string
  ) {
    this.model = config.model ?? DEFAULT_MODEL;
    this.maxIterations = config.maxIterations ?? DEFAULT_MAX_ITERATIONS;
    this.tools = tools;
    this.toolMap = new Map(tools.map(t => [t.name, t]));
    this.toolExecutor = new AgentToolExecutor(this.toolMap, config.signal, config.requestToolApproval, config.sessionApprovedTools, this.model);
    this.systemPrompt = systemPrompt;
    this.signal = config.signal;
  }

  /**
   * Create a new Agent instance with tools.
   */
  static async create(config: AgentConfig = {}): Promise<Agent> {
    const model = config.model ?? DEFAULT_MODEL;
    const tools = await getTools(model);
    const soulContent = await loadSoulDocument();
    let systemPrompt = await buildSystemPrompt(model, soulContent);

    // Inject data context so the agent knows what's in the database
    const dataContext = buildDataContext();
    if (dataContext) {
      systemPrompt += `\n\n${dataContext}`;
    }

    // Inject budget context if budgets are configured
    const budgetContext = buildBudgetContext();
    if (budgetContext) {
      systemPrompt += `\n\n${budgetContext}`;
    }

    // Inject goal context if goals are active
    const goalContext = buildGoalContext();
    if (goalContext) {
      systemPrompt += `\n\n${goalContext}`;
    }

    // Inject memory context if memories exist
    const memoryContext = buildMemoryContext();
    if (memoryContext) {
      systemPrompt += `\n\n${memoryContext}`;
    }

    // Inject custom prompt context if set
    const customPromptContext = buildCustomPromptContext();
    if (customPromptContext) {
      systemPrompt += `\n\n${customPromptContext}`;
    }

    // Inject profile context for multi-profile users
    const profileContext = buildProfileContext();
    if (profileContext) {
      systemPrompt += `\n\n${profileContext}`;
    }

    const toolNames = tools.map(t => t.name);
    logger.info(`Agent created`, { model, toolCount: tools.length, tools: toolNames });
    return new Agent(config, tools, systemPrompt);
  }

  /**
   * Run the agent and yield events for real-time UI updates.
   * Anthropic-style context management: full tool results during iteration,
   * with threshold-based clearing of oldest results when context exceeds limit.
   */
  async *run(query: string, inMemoryHistory?: InMemoryChatHistory): AsyncGenerator<AgentEvent> {
    const startTime = Date.now();
    logger.info(`Agent run started`, { query: query.slice(0, 200), model: this.model, maxIterations: this.maxIterations });

    if (this.tools.length === 0) {
      logger.warn(`Agent run aborted: no tools available`);
      yield { type: 'done', answer: 'No tools available. Please check your API key configuration.', toolCalls: [], iterations: 0, totalTime: Date.now() - startTime };
      return;
    }

    const ctx = createRunContext(query);

    // Build initial prompt with conversation history context
    let currentPrompt = this.buildInitialPrompt(query, inMemoryHistory);
    const hasHistory = inMemoryHistory?.hasMessages() ?? false;
    logger.debug(`Initial prompt built`, { promptChars: currentPrompt.length, hasHistory });

    // Main agent loop
    let overflowRetries = 0;
    while (ctx.iteration < this.maxIterations) {
      ctx.iteration++;
      logger.debug(`Iteration ${ctx.iteration}/${this.maxIterations} starting`);

      let response: LlmResponse;
      let usage: TokenUsage | undefined;
      let lastInteractionId: number | null | undefined;

      while (true) {
        try {
          const result = await this.callModel(currentPrompt, ctx);
          response = result.response;
          usage = result.usage;
          lastInteractionId = result.interactionId;
          overflowRetries = 0;
          break;
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);

          if (isContextOverflowError(errorMessage) && overflowRetries < MAX_OVERFLOW_RETRIES) {
            overflowRetries++;
            const clearedCount = ctx.scratchpad.clearOldestToolResults(OVERFLOW_KEEP_TOOL_USES);
            logger.warn(`Context overflow, cleared ${clearedCount} tool results (retry ${overflowRetries}/${MAX_OVERFLOW_RETRIES})`);

            if (clearedCount > 0) {
              yield { type: 'context_cleared', clearedCount, keptCount: OVERFLOW_KEEP_TOOL_USES };
              currentPrompt = buildIterationPrompt(
                query,
                ctx.scratchpad.getToolResults(),
                ctx.scratchpad.formatToolUsageForPrompt()
              );
              continue;
            }
          }

          const totalTime = Date.now() - ctx.startTime;
          yield {
            type: 'done',
            answer: `Error: ${formatUserFacingError(errorMessage)}`,
            toolCalls: ctx.scratchpad.getToolCallRecords(),
            iterations: ctx.iteration,
            totalTime,
            tokenUsage: ctx.tokenCounter.getUsage(),
            tokensPerSecond: ctx.tokenCounter.getTokensPerSecond(totalTime),
          };
          return;
        }
      }

      ctx.tokenCounter.add(usage);
      const responseText = extractTextContent(response);

      // Emit thinking if there are also tool calls (skip whitespace-only responses)
      if (responseText?.trim() && hasToolCalls(response)) {
        const trimmedText = responseText.trim();
        ctx.scratchpad.addThinking(trimmedText);
        logger.debug(`Agent thinking`, { preview: trimmedText.slice(0, 150) });
        yield { type: 'thinking', message: trimmedText };
      }

      // No tool calls = final answer is in this response
      if (!hasToolCalls(response)) {
        const totalTime = Date.now() - startTime;
        const tokenUsage = ctx.tokenCounter.getUsage();
        logger.info(`Agent run completed (direct response)`, {
          iterations: ctx.iteration,
          totalTimeMs: totalTime,
          totalTokens: tokenUsage?.totalTokens,
          answerChars: (responseText ?? '').length,
        });
        yield* this.handleDirectResponse(responseText ?? '', ctx);
        return;
      }

      // Execute tools and add results to scratchpad
      for await (const event of this.toolExecutor.executeAll(response, ctx, lastInteractionId ?? undefined)) {
        yield event;
        if (event.type === 'tool_denied') {
          const totalTime = Date.now() - ctx.startTime;
          yield {
            type: 'done',
            answer: '',
            toolCalls: ctx.scratchpad.getToolCallRecords(),
            iterations: ctx.iteration,
            totalTime,
            tokenUsage: ctx.tokenCounter.getUsage(),
            tokensPerSecond: ctx.tokenCounter.getTokensPerSecond(totalTime),
          };
          return;
        }
      }
      const toolRecords = ctx.scratchpad.getToolCallRecords();
      const lastTools = toolRecords.slice(-10).map(t => t.tool);
      logger.info(`Iteration ${ctx.iteration} completed`, { toolsCalled: lastTools, totalToolCalls: toolRecords.length });

      yield* this.manageContextThreshold(ctx);

      // Build iteration prompt with full tool results (Anthropic-style)
      currentPrompt = buildIterationPrompt(
        query,
        ctx.scratchpad.getToolResults(),
        ctx.scratchpad.formatToolUsageForPrompt()
      );
    }

    // Max iterations reached with no final response
    const totalTime = Date.now() - ctx.startTime;
    const tokenUsage = ctx.tokenCounter.getUsage();
    logger.warn(`Agent run hit max iterations`, {
      maxIterations: this.maxIterations,
      totalTimeMs: totalTime,
      totalTokens: tokenUsage?.totalTokens,
      toolCalls: ctx.scratchpad.getToolCallRecords().length,
    });
    yield {
      type: 'done',
      answer: `Reached maximum iterations (${this.maxIterations}). I was unable to complete the research in the allotted steps.`,
      toolCalls: ctx.scratchpad.getToolCallRecords(),
      iterations: ctx.iteration,
      totalTime,
      tokenUsage,
      tokensPerSecond: ctx.tokenCounter.getTokensPerSecond(totalTime),
    };
  }

  /**
   * Call the LLM with the current prompt.
   */
  private async callModel(prompt: string, ctx: RunContext, useTools: boolean = true): Promise<{ response: LlmResponse; usage?: TokenUsage; interactionId?: number | null }> {
    ctx.sequenceNum++;
    const result = await callLlm(prompt, {
      model: this.model,
      systemPrompt: this.systemPrompt,
      tools: useTools ? this.tools : undefined,
      signal: this.signal,
      runId: ctx.runId,
      sequenceNum: ctx.sequenceNum,
      callType: 'agent',
    });
    return { response: result.response, usage: result.usage, interactionId: result.interactionId };
  }

  /**
   * Emit the response text as the final answer.
   */
  private async *handleDirectResponse(
    responseText: string,
    ctx: RunContext
  ): AsyncGenerator<AgentEvent, void> {
    const totalTime = Date.now() - ctx.startTime;
    yield {
      type: 'done',
      answer: responseText,
      toolCalls: ctx.scratchpad.getToolCallRecords(),
      iterations: ctx.iteration,
      totalTime,
      tokenUsage: ctx.tokenCounter.getUsage(),
      tokensPerSecond: ctx.tokenCounter.getTokensPerSecond(totalTime),
    };
  }

  /**
   * Clear oldest tool results if context size exceeds threshold.
   */
  private *manageContextThreshold(ctx: RunContext): Generator<ContextClearedEvent, void> {
    const fullToolResults = ctx.scratchpad.getToolResults();
    const estimatedContextTokens = estimateTokens(this.systemPrompt + ctx.query + fullToolResults);

    if (estimatedContextTokens > CONTEXT_THRESHOLD) {
      const clearedCount = ctx.scratchpad.clearOldestToolResults(KEEP_TOOL_USES);
      if (clearedCount > 0) {
        yield { type: 'context_cleared', clearedCount, keptCount: KEEP_TOOL_USES };
      }
    }
  }

  /**
   * Build initial prompt with conversation history context if available
   */
  private buildInitialPrompt(
    query: string,
    inMemoryChatHistory?: InMemoryChatHistory
  ): string {
    if (!inMemoryChatHistory?.hasMessages()) {
      return query;
    }

    const recentTurns = inMemoryChatHistory.getRecentTurns();
    if (recentTurns.length === 0) {
      return query;
    }

    return buildHistoryContext({
      entries: recentTurns,
      currentMessage: query,
    });
  }
}
