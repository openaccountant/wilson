import type { LlmResponse } from '../model/types.js';
import type { ToolDef } from '../model/types.js';
import { callLlm, type LlmResult } from '../model/llm.js';
import { interactionStore } from '../utils/interaction-store.js';
import { getToolRegistry, type RegisteredTool } from '../tools/registry.js';
import { buildSystemPrompt, buildIterationPrompt, loadSoulDocument, buildBudgetContext, buildDataContext, buildGoalContext, buildMemoryContext, buildCustomPromptContext, buildProfileContext } from '../agent/prompts.js';
import { extractTextContent, hasToolCalls } from '../utils/ai-message.js';
import { InMemoryChatHistory } from '../utils/in-memory-chat-history.js';
import { buildHistoryContext } from '../utils/history-context.js';
import { estimateTokens, CONTEXT_THRESHOLD, KEEP_TOOL_USES } from '../utils/tokens.js';
import { formatUserFacingError, isContextOverflowError } from '../utils/errors.js';
import type { AgentConfig, AgentEvent, ContextClearedEvent, TokenUsage, ToolSelectionEvent } from '../agent/types.js';
import { createRunContext, type RunContext } from './run-context.js';
import { AgentToolExecutor } from './tool-executor.js';
import { logger } from '../utils/logger.js';
import { resolveProvider } from '../providers.js';
import { getSetting } from '../utils/config.js';
import { discoverSkills } from '../skills/index.js';
import { stripInjectedContext } from '../dashboard/local-handoff-format.js';
import { replayDetector } from '../training/handoff-tag.js';
import { getLocalTokenCounter, localPromptBudget } from '../model/providers/transformers.js';
import {
  CORE_TOOLS,
  LOCAL_TOOL_SELECTION_KEY,
  growSelection,
  rankToolsForText,
  selectTools,
  shouldSelectTools,
  toolsNamedIn,
  type ToolCandidate,
  type ToolSelection,
} from './tool-selection.js';
import { getCardEmbedder, skillCardText, toolCardText, toolSchemaTokens, type EmbedFn } from './tool-cards.js';
import { CPU_SOFT_PROMPT_BUDGET, planLocalPrompt } from './local-prompt-planner.js';
import { resolveLocalDateArgs } from './local-date-args.js';
import { isToolResultEcho, toolResultsFallback } from './local-answer-check.js';


const DEFAULT_MODEL = 'gpt-5.2';
const DEFAULT_MAX_ITERATIONS = 10;
const MAX_OVERFLOW_RETRIES = 2;
const OVERFLOW_KEEP_TOOL_USES = 3;

/**
 * Card embedding budget for local tool selection. The first call in a process
 * loads MiniLM (~180 ms cached) and embeds every card (~190 ms); later calls
 * embed only the query (~2 ms). On timeout the run falls back to keyword
 * groups while the load finishes in the background for the next run.
 */
const LOCAL_EMBED_TIMEOUT_MS = { cold: 3000, warm: 300 };
let localEmbedWarm = false;
let embedFailureLogged = false;

/** What a local run needs to rebuild its system prompt with a per-request skill selection. */
interface LocalPromptParts {
  soulContent: string | null;
  /** The DB contexts appended after the base prompt (data, budget, goals, memory, custom, profile). */
  contexts: string;
}

/** Run-scoped state of local tool selection: the selected set only grows (R5). */
interface LocalRun {
  selection: ToolSelection;
  candidates: ToolCandidate[];
  /** System prompt with the selected skills' descriptions, and with skill names only. */
  system: string;
  compactSystem: string;
  countTokens: (text: string) => number;
  budget: number;
  hardLimit: boolean;
  /** Tools the model called this run: never trimmed. */
  called: Set<string>;
  /** Tool list of the last tool_selection event, to emit only on change. */
  lastEmitted: string | null;
  /** Answer copied from the tool results: 'pending' re-prompts the next call, once per run. */
  echoRetry: 'none' | 'pending' | 'done';
}

/** A local call's prompt pieces, from the planner. */
interface LocalCall {
  prompt: string;
  systemPrompt: string;
  tools: ToolDef[];
  toolIndex: string[];
  /** Set when the tools or skills differ from the last call's. */
  event?: ToolSelectionEvent;
}

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
  private readonly registry: RegisteredTool[];
  /** Set only when this agent selects tools per request (local Transformers.js model). */
  private readonly localParts: LocalPromptParts | null;

  private constructor(
    config: AgentConfig,
    registry: RegisteredTool[],
    systemPrompt: string,
    localParts: LocalPromptParts | null,
  ) {
    this.model = config.model ?? DEFAULT_MODEL;
    this.maxIterations = config.maxIterations ?? DEFAULT_MAX_ITERATIONS;
    this.registry = registry;
    this.tools = registry.map(t => t.tool);
    this.toolMap = new Map(this.tools.map(t => [t.name, t]));
    this.toolExecutor = new AgentToolExecutor(this.toolMap, config.signal, config.requestToolApproval, config.sessionApprovedTools, this.model);
    this.systemPrompt = systemPrompt;
    this.signal = config.signal;
    this.localParts = localParts;
  }

  /**
   * Create a new Agent instance with tools.
   */
  static async create(config: AgentConfig = {}): Promise<Agent> {
    const model = config.model ?? DEFAULT_MODEL;
    const registry = await getToolRegistry(model);
    const tools = registry.map(t => t.tool);
    const soulContent = await loadSoulDocument();
    const basePrompt = await buildSystemPrompt(model, soulContent);
    let contexts = '';

    // Inject data context so the agent knows what's in the database
    const dataContext = buildDataContext();
    if (dataContext) {
      contexts += `\n\n${dataContext}`;
    }

    // Inject budget context if budgets are configured
    const budgetContext = buildBudgetContext();
    if (budgetContext) {
      contexts += `\n\n${budgetContext}`;
    }

    // Inject goal context if goals are active
    const goalContext = buildGoalContext();
    if (goalContext) {
      contexts += `\n\n${goalContext}`;
    }

    // Inject memory context if memories exist
    const memoryContext = buildMemoryContext();
    if (memoryContext) {
      contexts += `\n\n${memoryContext}`;
    }

    // Inject custom prompt context if set
    const customPromptContext = buildCustomPromptContext();
    if (customPromptContext) {
      contexts += `\n\n${customPromptContext}`;
    }

    // Inject profile context for multi-profile users
    const profileContext = buildProfileContext();
    if (profileContext) {
      contexts += `\n\n${profileContext}`;
    }

    const systemPrompt = basePrompt + contexts;
    const selectLocally = shouldSelectTools(resolveProvider(model).id, getSetting<unknown>(LOCAL_TOOL_SELECTION_KEY, 'auto'));

    const toolNames = tools.map(t => t.name);
    logger.info(`Agent created`, { model, toolCount: tools.length, tools: toolNames, localToolSelection: selectLocally });
    return new Agent(config, registry, systemPrompt, selectLocally ? { soulContent, contexts } : null);
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

    // Local models: pick this request's tools (and skills) up front.
    const local = this.localParts ? await this.startLocalRun(query, inMemoryHistory) : null;

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
      // Local models: the tools whose schema this call showed (undefined = all).
      let shownTools: ReadonlySet<string> | undefined;

      while (true) {
        try {
          // Local models: the planner assembles every call under the token
          // budget (history or tool results, selected tools, index).
          const localCall = local ? this.planLocalCall(local, ctx, query, inMemoryHistory) : undefined;
          shownTools = localCall ? new Set(localCall.tools.map((t) => t.name)) : undefined;
          if (localCall?.event) yield localCall.event;
          const result = await this.callModel(localCall?.prompt ?? currentPrompt, ctx, true, localCall);
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
        let answer = responseText ?? '';
        // Local models: an answer that copies the tool results gets one
        // re-prompt, then the latest result's own formatted summary.
        if (local && local.called.size > 0 && isToolResultEcho(answer, local.called)) {
          if (local.echoRetry === 'none' && ctx.iteration < this.maxIterations) {
            local.echoRetry = 'pending';
            logger.warn(`Local answer copied the tool results, re-prompting`, { preview: answer.slice(0, 120) });
            continue;
          }
          logger.warn(`Local answer copied the tool results again, using the formatted result`);
          answer = toolResultsFallback(ctx.scratchpad.getToolCallRecords());
        }
        const totalTime = Date.now() - startTime;
        const tokenUsage = ctx.tokenCounter.getUsage();
        logger.info(`Agent run completed (direct response)`, {
          iterations: ctx.iteration,
          totalTimeMs: totalTime,
          totalTokens: tokenUsage?.totalTokens,
          answerChars: answer.length,
        });
        yield* this.handleDirectResponse(answer, ctx);
        return;
      }

      // Local models: fill a month the user named into spending_summary,
      // which the model calls for the current month (and tidy
      // transaction_search's month + year, see local-date-args.ts).
      if (local) {
        const userQuery = stripInjectedContext(query, replayDetector());
        for (const call of response.toolCalls) call.args = resolveLocalDateArgs(userQuery, call.name, call.args);
      }

      // Execute tools and add results to scratchpad
      const recordsBefore = ctx.scratchpad.getToolCallRecords().length;
      for await (const event of this.toolExecutor.executeAll(response, ctx, lastInteractionId ?? undefined, { shownTools })) {
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

      // Remembered per turn so the next turn's local tool selection keeps them.
      const calledNow = toolRecords.slice(recordsBefore).map(t => t.tool);
      inMemoryHistory?.recordToolsUsed(calledNow);

      // Local models: the selected set only grows (R5) — called tools, the
      // tools that usually come next, and tools a skill's instructions need.
      if (local) {
        calledNow.forEach((t) => local.called.add(t));
        const skillTools = await this.skillTools(local, toolRecords.slice(recordsBefore));
        local.selection = growSelection(local.selection, { called: calledNow, skillTools }, local.candidates).selection;
      }

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
  private async callModel(
    prompt: string,
    ctx: RunContext,
    useTools: boolean = true,
    localCall?: LocalCall,
  ): Promise<{ response: LlmResponse; usage?: TokenUsage; interactionId?: number | null }> {
    ctx.sequenceNum++;
    const result = await callLlm(prompt, {
      model: this.model,
      systemPrompt: localCall?.systemPrompt ?? this.systemPrompt,
      tools: useTools ? (localCall?.tools ?? this.tools) : undefined,
      ...(useTools && localCall ? { toolIndex: localCall.toolIndex } : {}),
      signal: this.signal,
      runId: ctx.runId,
      sequenceNum: ctx.sequenceNum,
      callType: 'agent',
    });
    return { response: result.response, usage: result.usage, interactionId: result.interactionId };
  }

  /**
   * Select this request's tools and skills for a local model (design
   * 2026-10-03, approach E). Never throws: without the embedder the selector
   * falls back to core + keyword groups.
   */
  private async startLocalRun(query: string, history?: InMemoryChatHistory): Promise<LocalRun> {
    const parts = this.localParts!;
    const countTokens = await getLocalTokenCounter(this.model);
    const candidates: ToolCandidate[] = this.registry.map((entry) => ({
      name: entry.name,
      card: toolCardText(entry),
      schemaTokens: toolSchemaTokens(entry.tool, countTokens),
    }));
    const skills = discoverSkills().map((s) => ({ name: s.name, card: skillCardText(s) }));
    const turns = history?.getRecentTurns() ?? [];
    const prevQuery = [...turns].reverse().find((t) => t.role === 'user')?.content ?? null;

    const selection = await selectTools({
      query: stripInjectedContext(query, replayDetector()),
      prevQuery: prevQuery ? stripInjectedContext(prevQuery, replayDetector()) : null,
      tools: candidates,
      skills,
      stickyTools: history?.getRecentToolsUsed(2) ?? [],
      embed: withEmbedTimeout(getCardEmbedder()),
    });

    const [selectedSystem, compactSystem] = await Promise.all([
      buildSystemPrompt(this.model, parts.soulContent, { skillSelection: selection.skills }),
      buildSystemPrompt(this.model, parts.soulContent, { skillSelection: [] }),
    ]);
    const hardBudget = localPromptBudget(this.model);
    return {
      selection,
      candidates,
      system: selectedSystem + parts.contexts,
      compactSystem: compactSystem + parts.contexts,
      countTokens,
      budget: hardBudget ?? CPU_SOFT_PROMPT_BUDGET,
      hardLimit: hardBudget !== null,
      called: new Set(),
      lastEmitted: null,
      echoRetry: 'none',
    };
  }

  /**
   * Tools the instructions of skills invoked this iteration call for: those
   * they name, plus the top 3 by embedding (only a few SKILL.md files name
   * their tools).
   */
  private async skillTools(local: LocalRun, records: Array<{ tool: string; result: string }>): Promise<string[]> {
    const names = local.candidates.map((c) => c.name);
    const out: string[] = [];
    for (const r of records) {
      if (r.tool !== 'skill' || r.result.startsWith('Error')) continue;
      out.push(...toolsNamedIn(r.result, names));
      const exclude = new Set([...local.selection.tools, ...out]);
      out.push(...(await rankToolsForText(r.result.slice(0, 2000), local.candidates, withEmbedTimeout(getCardEmbedder()), 3, exclude)));
    }
    return out;
  }

  /** Plan one local call: first call carries chat history, later calls the tool results. */
  private planLocalCall(local: LocalRun, ctx: RunContext, query: string, history?: InMemoryChatHistory): LocalCall {
    const protectedTools = new Set([
      ...CORE_TOOLS,
      ...local.called,
      ...local.selection.tools.filter((t) => local.selection.reasons[t] === 'named' || local.selection.reasons[t] === 'called'),
    ]);
    const retry = local.echoRetry === 'pending';
    if (retry) local.echoRetry = 'done';
    const plan = planLocalPrompt({
      model: this.model,
      budget: local.budget,
      hardLimit: local.hardLimit,
      countTokens: local.countTokens,
      system: local.system,
      compactSystem: local.compactSystem,
      tools: local.selection.tools.map((name) => this.toolMap.get(name)).filter((t): t is ToolDef => !!t),
      protectedTools,
      toolIndex: local.selection.indexed,
      query,
      ...(ctx.iteration === 1
        ? { history: history?.hasMessages() ? history.getRecentTurns() : [] }
        : {
            results: {
              blocks: ctx.scratchpad.getToolResultBlocks(),
              render: (results: string) =>
                buildIterationPrompt(query, results, ctx.scratchpad.formatToolUsageForPrompt(), { local: true, retry }),
            },
          }),
    });
    if (plan.trimmed.length > 0) logger.debug(`Local prompt trimmed`, { trimmed: plan.trimmed, tokens: plan.tokens });

    const tools = plan.tools.map((t) => t.name);
    const skills = plan.systemPrompt === local.system ? local.selection.skills : [];
    const key = `${tools.join(',')}|${skills.join(',')}`;
    let event: ToolSelectionEvent | undefined;
    if (key !== local.lastEmitted) {
      local.lastEmitted = key;
      const { budget, template: _template, ...tokens } = plan.tokens;
      event = {
        type: 'tool_selection',
        tools,
        indexed: plan.toolIndex,
        skills,
        reasons: Object.fromEntries([...tools, ...skills].map((n) => [n, local.selection.reasons[n] ?? ''])),
        fallback: local.selection.fallback,
        tokens: { ...tokens, budget },
        trimmed: plan.trimmed,
      };
      logger.debug(`Local tool selection`, { ...event });
    }
    return { prompt: plan.userPrompt, systemPrompt: plan.systemPrompt, tools: plan.tools, toolIndex: plan.toolIndex, event };
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

/**
 * `embed` bounded by LOCAL_EMBED_TIMEOUT_MS: a slow or failing embedder makes
 * selection fall back to keyword groups instead of holding up the run. A
 * timed-out embed keeps running (and fills the card cache) in the background.
 */
function withEmbedTimeout(embed: EmbedFn): EmbedFn {
  return async (texts) => {
    const ms = localEmbedWarm ? LOCAL_EMBED_TIMEOUT_MS.warm : LOCAL_EMBED_TIMEOUT_MS.cold;
    const work = embed(texts);
    work.catch(() => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const vectors = await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`card embedding timed out after ${ms} ms`)), ms);
        }),
      ]);
      localEmbedWarm = true;
      return vectors;
    } catch (err) {
      if (!embedFailureLogged) {
        embedFailureLogged = true;
        logger.warn(`Local tool selection: embedder unavailable, using keyword groups`, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  };
}
