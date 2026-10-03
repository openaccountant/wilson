import type { LlmResponse, ToolDef } from '../model/types.js';
import { createProgressChannel } from '../utils/progress-channel.js';
import type {
  ApprovalDecision,
  ToolApprovalRequest,
  ToolApprovalEvent,
  ToolDeniedEvent,
  ToolEndEvent,
  ToolErrorEvent,
  ToolLimitEvent,
  ToolProgressEvent,
  ToolStartEvent,
} from './types.js';
import type { RunContext } from './run-context.js';
import { logger } from '../utils/logger.js';
import { interactionStore } from '../utils/interaction-store.js';
import { isMutatingCall, sessionApprovalScope } from '../tools/mutation.js';

type ToolExecutionEvent =
  | ToolStartEvent
  | ToolProgressEvent
  | ToolEndEvent
  | ToolErrorEvent
  | ToolApprovalEvent
  | ToolDeniedEvent
  | ToolLimitEvent;

/**
 * Executes tool calls and emits streaming tool lifecycle events.
 */
export class AgentToolExecutor {
  /** Session approval keys (SessionApprovalScope.key), shared across queries. */
  private readonly sessionApprovedTools: Set<string>;

  constructor(
    private readonly toolMap: Map<string, ToolDef>,
    private readonly signal?: AbortSignal,
    private readonly requestToolApproval?: (request: ToolApprovalRequest) => Promise<ApprovalDecision>,
    sessionApprovedTools?: Set<string>,
    private readonly model?: string,
  ) {
    this.sessionApprovedTools = sessionApprovedTools ?? new Set();
  }

  async *executeAll(
    response: LlmResponse,
    ctx: RunContext,
    parentInteractionId?: number,
  ): AsyncGenerator<ToolExecutionEvent, void> {
    for (const toolCall of response.toolCalls) {
      const toolName = toolCall.name;
      const toolArgs = toolCall.args;

      // Deduplicate skill calls - each skill can only run once per query
      if (toolName === 'skill') {
        const skillName = toolArgs.skill as string;
        if (ctx.scratchpad.hasExecutedSkill(skillName)) continue;
      }

      yield* this.executeSingle(toolName, toolArgs, toolCall.id, ctx, parentInteractionId);
    }
  }

  private async *executeSingle(
    toolName: string,
    toolArgs: Record<string, unknown>,
    toolCallId: string,
    ctx: RunContext,
    parentInteractionId?: number,
  ): AsyncGenerator<ToolExecutionEvent, void> {
    const toolQuery = this.extractQueryFromArgs(toolArgs);

    // Every call that writes (DB, files, external services) needs the user's
    // approval before it runs (#152). Which calls write is declared next to
    // each tool definition (`mutates`, see src/tools/mutation.ts). With no
    // approval handler the call is denied — fail closed.
    if (this.requiresApproval(toolName, toolArgs)) {
      const session = sessionApprovalScope(toolName, this.toolMap.get(toolName), toolArgs);
      if (!session || !this.sessionApprovedTools.has(session.key)) {
        const decision =
          (await this.requestToolApproval?.({ tool: toolName, args: toolArgs, session })) ?? 'deny';
        yield { type: 'tool_approval', tool: toolName, args: toolArgs, approved: decision };
        if (decision === 'deny') {
          yield { type: 'tool_denied', tool: toolName, args: toolArgs };
          return;
        }
        if (decision === 'allow-session' && session) {
          // Only this tool (or tool + action): approving bulk categorize for
          // the session must not also wave through delete_transaction, nor
          // memory_manage `add` allow `deactivate`. Chain/team calls have no
          // session scope, so 'allow-session' there counts as once.
          this.sessionApprovedTools.add(session.key);
        }
      }
    }

    const limitCheck = ctx.scratchpad.canCallTool(toolName, toolQuery);

    if (limitCheck.warning) {
      yield {
        type: 'tool_limit',
        tool: toolName,
        warning: limitCheck.warning,
        blocked: false,
      };
    }

    // Summarize args for logging (avoid huge payloads)
    const argsSummary: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(toolArgs)) {
      argsSummary[k] = typeof v === 'string' && v.length > 200 ? v.slice(0, 200) + '...' : v;
    }
    logger.info(`Tool started: ${toolName}`, { tool: toolName, args: argsSummary });
    yield { type: 'tool_start', tool: toolName, args: toolArgs };

    const toolStartTime = Date.now();

    try {
      const tool = this.toolMap.get(toolName);
      if (!tool) {
        logger.error(`Tool not found: ${toolName}`);
        throw new Error(`Tool '${toolName}' not found`);
      }

      // Create a progress channel so subagent tools can stream status updates
      const channel = createProgressChannel();
      const config = {
        metadata: { onProgress: channel.emit },
        ...(this.signal ? { signal: this.signal } : {}),
        ...(this.model ? { model: this.model } : {}),
      };

      // Launch tool invocation -- closes the channel when it settles
      const toolPromise = tool.func(toolArgs, config).then(
        (raw) => {
          channel.close();
          return raw;
        },
        (err) => {
          channel.close();
          throw err;
        }
      );

      // Drain progress events in real-time as the tool executes
      for await (const message of channel) {
        yield { type: 'tool_progress', tool: toolName, message } as ToolProgressEvent;
      }

      // Tool has finished -- collect the result
      const rawResult = await toolPromise;
      const result = typeof rawResult === 'string' ? rawResult : JSON.stringify(rawResult);
      const duration = Date.now() - toolStartTime;

      logger.info(`Tool completed: ${toolName}`, {
        tool: toolName,
        durationMs: duration,
        resultChars: result.length,
        resultPreview: result.slice(0, 200),
      });
      yield { type: 'tool_end', tool: toolName, args: toolArgs, result, duration };

      // Record tool result for interaction capture
      if (parentInteractionId) {
        interactionStore.recordToolResult({
          interactionId: parentInteractionId,
          toolCallId,
          toolName,
          toolArgs,
          toolResult: result,
          durationMs: duration,
        });
      }

      // Record the tool call for limit tracking
      ctx.scratchpad.recordToolCall(toolName, toolQuery);

      // Add full tool result to scratchpad (Anthropic-style: no inline summarization)
      ctx.scratchpad.addToolResult(toolName, toolArgs, result);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const duration = Date.now() - toolStartTime;
      logger.error(`Tool failed: ${toolName}`, { tool: toolName, durationMs: duration, error: errorMessage });
      yield { type: 'tool_error', tool: toolName, error: errorMessage };

      // Record error tool result for interaction capture
      if (parentInteractionId) {
        interactionStore.recordToolResult({
          interactionId: parentInteractionId,
          toolCallId,
          toolName,
          toolArgs,
          toolResult: `Error: ${errorMessage}`,
          durationMs: duration,
        });
      }

      // Still record the call even on error (counts toward limit)
      ctx.scratchpad.recordToolCall(toolName, toolQuery);

      // Add error to scratchpad
      ctx.scratchpad.addToolResult(toolName, toolArgs, `Error: ${errorMessage}`);
    }
  }

  private extractQueryFromArgs(args: Record<string, unknown>): string | undefined {
    const queryKeys = ['query', 'search', 'question', 'q', 'text', 'input'];

    for (const key of queryKeys) {
      if (typeof args[key] === 'string') {
        return args[key] as string;
      }
    }

    return undefined;
  }

  private requiresApproval(toolName: string, toolArgs: Record<string, unknown>): boolean {
    return isMutatingCall(this.toolMap.get(toolName), toolArgs);
  }
}
