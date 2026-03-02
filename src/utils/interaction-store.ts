/**
 * Singleton store for recording full LLM interaction content.
 * Follows the same setDatabase() + prepared statement pattern as trace-store.ts.
 * Captures prompts, responses, tool calls, and tool results for
 * annotation and fine-tuning data export.
 */

import type { Database } from '../db/compat-sqlite.js';
import type { ToolCall } from '../model/types.js';

export interface InteractionRecord {
  runId: string;
  sequenceNum: number;
  callType: string;
  model: string;
  provider: string;
  systemPrompt: string;
  userPrompt: string;
  responseContent: string;
  toolCalls: ToolCall[];
  toolDefs: string[];
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
  durationMs: number;
  status: 'ok' | 'error';
  error?: string;
}

export interface ToolResultRecord {
  interactionId: number;
  toolCallId: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  toolResult: string;
  durationMs: number;
}

class InteractionStore {
  private db: Database | null = null;
  private insertInteraction: ReturnType<Database['prepare']> | null = null;
  private insertToolResult: ReturnType<Database['prepare']> | null = null;

  setDatabase(db: Database): void {
    this.db = db;
    this.insertInteraction = db.prepare(`
      INSERT INTO llm_interactions (
        run_id, sequence_num, call_type, model, provider,
        system_prompt, user_prompt, response_content,
        tool_calls_json, tool_defs_json,
        input_tokens, output_tokens, total_tokens,
        duration_ms, status, error
      ) VALUES (
        @run_id, @sequence_num, @call_type, @model, @provider,
        @system_prompt, @user_prompt, @response_content,
        @tool_calls_json, @tool_defs_json,
        @input_tokens, @output_tokens, @total_tokens,
        @duration_ms, @status, @error
      )
    `);
    this.insertToolResult = db.prepare(`
      INSERT INTO llm_tool_results (
        interaction_id, tool_call_id, tool_name,
        tool_args_json, tool_result, duration_ms
      ) VALUES (
        @interaction_id, @tool_call_id, @tool_name,
        @tool_args_json, @tool_result, @duration_ms
      )
    `);
  }

  recordInteraction(data: InteractionRecord): number | null {
    if (!this.insertInteraction || !this.db) return null;
    try {
      const result = this.insertInteraction.run({
        run_id: data.runId,
        sequence_num: data.sequenceNum,
        call_type: data.callType,
        model: data.model,
        provider: data.provider,
        system_prompt: data.systemPrompt,
        user_prompt: data.userPrompt,
        response_content: data.responseContent,
        tool_calls_json: data.toolCalls.length > 0
          ? JSON.stringify(data.toolCalls.map(tc => ({ id: tc.id, name: tc.name, args: tc.args })))
          : null,
        tool_defs_json: data.toolDefs.length > 0
          ? JSON.stringify(data.toolDefs)
          : null,
        input_tokens: data.usage.inputTokens,
        output_tokens: data.usage.outputTokens,
        total_tokens: data.usage.totalTokens,
        duration_ms: data.durationMs,
        status: data.status,
        error: data.error ?? null,
      });
      return Number(result.lastInsertRowid);
    } catch {
      return null;
    }
  }

  recordToolResult(data: ToolResultRecord): void {
    if (!this.insertToolResult) return;
    try {
      this.insertToolResult.run({
        interaction_id: data.interactionId,
        tool_call_id: data.toolCallId,
        tool_name: data.toolName,
        tool_args_json: JSON.stringify(data.toolArgs),
        tool_result: data.toolResult,
        duration_ms: data.durationMs,
      });
    } catch { /* don't let DB errors break execution */ }
  }
}

// Singleton
export const interactionStore = new InteractionStore();
