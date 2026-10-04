/**
 * Export annotated LLM interactions as HuggingFace TRL-compatible training data.
 * Supports SFT (Supervised Fine-Tuning) and DPO (Direct Preference Optimization) formats.
 */

import type { Database } from '../db/compat-sqlite.js';
import {
  qualifyingDpoPairs,
  qualifyingSftRuns,
  trainingReadiness,
  type QualifyOptions,
} from './annotations.js';

interface InteractionRow {
  id: number;
  run_id: string;
  sequence_num: number;
  call_type: string;
  model: string;
  system_prompt: string | null;
  user_prompt: string;
  response_content: string | null;
  tool_calls_json: string | null;
  status: string;
}

interface ToolResultRow {
  tool_call_id: string;
  tool_name: string;
  tool_args_json: string | null;
  tool_result: string | null;
}

interface SftMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

/**
 * Which labels an export may use. The default is HUMAN labels only; each flag is a separate, explicit per-export
 * opt-in (see src/training/annotations.ts for the rules and why).
 */
export type ExportQualifyOptions = QualifyOptions;

export interface SftExportOptions extends ExportQualifyOptions {
  minRating?: number;
  callTypes?: string[];
  includeToolCalls?: boolean;
  model?: string;
}

/** The `X-Wilson-Export-Provenance` value for an export: what kinds of rows it may contain. */
export function exportProvenance(opts: ExportQualifyOptions = {}): string {
  const parts = ['human'];
  if (opts.includeJudge) parts.push('judge');
  if (opts.includeAgentPresent) parts.push('agent-present');
  if (opts.includeHandoff) parts.push('handoff');
  return parts.join('+');
}

/**
 * Export interactions as SFT JSONL — one line per run (full conversation).
 * Format: {"messages": [{"role": "system", ...}, {"role": "user", ...}, ...]}
 */
export function exportSftJsonl(db: Database, options: SftExportOptions = {}): string {
  const { includeToolCalls = true } = options;

  // The same selection the readiness count uses, so "SFT ready" is exactly the number of lines below.
  const { runIds: selected } = qualifyingSftRuns(db, options);
  const runIds = selected.map((run_id) => ({ run_id }));
  const lines: string[] = [];

  for (const { run_id } of runIds) {
    const interactions = db.prepare(`
      SELECT * FROM llm_interactions
      WHERE run_id = @run_id ORDER BY sequence_num
    `).all({ run_id }) as InteractionRow[];

    if (interactions.length === 0) continue;

    const messages: SftMessage[] = [];

    for (const interaction of interactions) {
      // System prompt (only add once, from first interaction)
      if (messages.length === 0 && interaction.system_prompt) {
        messages.push({ role: 'system', content: interaction.system_prompt });
      }

      // User message
      messages.push({ role: 'user', content: interaction.user_prompt });

      // Assistant response
      const assistantMsg: SftMessage = {
        role: 'assistant',
        content: interaction.response_content ?? '',
      };

      // Tool calls
      if (includeToolCalls && interaction.tool_calls_json) {
        try {
          const toolCalls = JSON.parse(interaction.tool_calls_json) as { id: string; name: string; args: Record<string, unknown> }[];
          if (toolCalls.length > 0) {
            assistantMsg.tool_calls = toolCalls.map(tc => ({
              id: tc.id,
              type: 'function' as const,
              function: { name: tc.name, arguments: JSON.stringify(tc.args) },
            }));
          }
        } catch { /* skip malformed tool calls */ }
      }

      messages.push(assistantMsg);

      // Tool results
      if (includeToolCalls) {
        const toolResults = db.prepare(`
          SELECT tool_call_id, tool_name, tool_args_json, tool_result
          FROM llm_tool_results WHERE interaction_id = @id ORDER BY id
        `).all({ id: interaction.id }) as ToolResultRow[];

        for (const tr of toolResults) {
          messages.push({
            role: 'tool',
            content: tr.tool_result ?? '',
            tool_call_id: tr.tool_call_id,
          });
        }
      }
    }

    if (messages.length > 1) {
      lines.push(JSON.stringify({ messages }));
    }
  }

  return lines.join('\n');
}

/**
 * Export preference pairs as DPO JSONL.
 * Format: {"prompt": "...", "chosen": [messages...], "rejected": [messages...]}
 */
export function exportDpoJsonl(db: Database, options: ExportQualifyOptions = {}): string {
  // Complete pairs only: both the chosen and the rejected side must qualify.
  const { pairs } = qualifyingDpoPairs(db, options);

  const lines: string[] = [];

  for (const pair of pairs) {
    const load = (id: number) => db.prepare('SELECT * FROM llm_interactions WHERE id = @id').get({ id }) as InteractionRow | undefined;
    const chosen = load(pair.chosenInteractionId);
    const rejected = load(pair.rejectedInteractionId);

    if (!chosen || !rejected) continue;

    const prompt = chosen.user_prompt;

    const buildMessages = (interaction: InteractionRow): SftMessage[] => {
      const msgs: SftMessage[] = [];
      if (interaction.system_prompt) {
        msgs.push({ role: 'system', content: interaction.system_prompt });
      }
      msgs.push({ role: 'assistant', content: interaction.response_content ?? '' });

      // Include tool results
      const toolResults = db.prepare(`
        SELECT tool_call_id, tool_name, tool_result
        FROM llm_tool_results WHERE interaction_id = @id ORDER BY id
      `).all({ id: interaction.id }) as ToolResultRow[];

      for (const tr of toolResults) {
        msgs.push({ role: 'tool', content: tr.tool_result ?? '', tool_call_id: tr.tool_call_id });
      }

      return msgs;
    };

    lines.push(JSON.stringify({
      prompt,
      chosen: buildMessages(chosen),
      rejected: buildMessages(rejected),
    }));
  }

  return lines.join('\n');
}

/**
 * Get training data statistics, counted with the export's own qualifying rules: `sftReady` is the number of
 * runs (SFT lines) an export emits and `dpoPairs` the number of complete pairs, not annotation rows.
 */
export function getTrainingStats(db: Database, options: ExportQualifyOptions = {}) {
  return trainingReadiness(db, options);
}
