/**
 * Export annotated LLM interactions as HuggingFace TRL-compatible training data.
 * Supports SFT (Supervised Fine-Tuning) and DPO (Direct Preference Optimization) formats.
 */

import type { Database } from '../db/compat-sqlite.js';

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

interface AnnotationRow {
  interaction_id: number;
  rating: number | null;
  preference: string | null;
  pair_id: string | null;
}

interface SftMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

export interface SftExportOptions {
  minRating?: number;
  callTypes?: string[];
  includeToolCalls?: boolean;
  model?: string;
}

/**
 * Export interactions as SFT JSONL — one line per run (full conversation).
 * Format: {"messages": [{"role": "system", ...}, {"role": "user", ...}, ...]}
 */
export function exportSftJsonl(db: Database, options: SftExportOptions = {}): string {
  const { minRating = 4, callTypes = ['agent'], includeToolCalls = true, model } = options;

  // Get qualifying interactions (rated >= minRating)
  let sql = `
    SELECT DISTINCT i.run_id
    FROM llm_interactions i
    JOIN interaction_annotations a ON a.interaction_id = i.id
    WHERE a.rating >= @minRating
  `;
  const params: Record<string, unknown> = { minRating };

  if (callTypes.length > 0) {
    sql += ` AND i.call_type IN (${callTypes.map((_, idx) => `@ct${idx}`).join(',')})`;
    callTypes.forEach((ct, idx) => { params[`ct${idx}`] = ct; });
  }
  if (model) {
    sql += ' AND i.model = @model';
    params.model = model;
  }

  const runIds = db.prepare(sql).all(params) as { run_id: string }[];
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
export function exportDpoJsonl(db: Database): string {
  // Find all unique pair_ids that have both chosen and rejected
  const pairs = db.prepare(`
    SELECT DISTINCT a1.pair_id
    FROM interaction_annotations a1
    JOIN interaction_annotations a2 ON a1.pair_id = a2.pair_id
    WHERE a1.preference = 'chosen' AND a2.preference = 'rejected'
      AND a1.pair_id IS NOT NULL
  `).all() as { pair_id: string }[];

  const lines: string[] = [];

  for (const { pair_id } of pairs) {
    const annotations = db.prepare(`
      SELECT a.preference, i.*
      FROM interaction_annotations a
      JOIN llm_interactions i ON i.id = a.interaction_id
      WHERE a.pair_id = @pair_id AND a.preference IN ('chosen', 'rejected')
    `).all({ pair_id }) as (InteractionRow & { preference: string })[];

    const chosen = annotations.find(a => a.preference === 'chosen');
    const rejected = annotations.find(a => a.preference === 'rejected');

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
 * Get training data statistics.
 */
export function getTrainingStats(db: Database) {
  try {
    const total = (db.prepare('SELECT COUNT(*) AS c FROM llm_interactions').get() as { c: number })?.c ?? 0;
    const annotated = (db.prepare('SELECT COUNT(DISTINCT interaction_id) AS c FROM interaction_annotations').get() as { c: number })?.c ?? 0;
    const sftReady = (db.prepare('SELECT COUNT(*) AS c FROM interaction_annotations WHERE rating >= 4').get() as { c: number })?.c ?? 0;
    const dpoPairs = (db.prepare(`
      SELECT COUNT(DISTINCT pair_id) AS c FROM interaction_annotations WHERE pair_id IS NOT NULL
    `).get() as { c: number })?.c ?? 0;

    return { totalInteractions: total, annotated, sftReady, dpoPairs };
  } catch {
    return { totalInteractions: 0, annotated: 0, sftReady: 0, dpoPairs: 0 };
  }
}
