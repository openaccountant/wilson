/**
 * The judge's read tools: `list_interactions`, `get_interaction`, `get_judge_rubric`.
 *
 * A judge agent reads recorded model calls (`llm_interactions`) to propose judgements. What it may see is
 * deliberately narrower than the Training tab shows a person (threat model T23, T24, T37):
 *
 *  - BLIND: no output here, or from `open_interaction`, ever carries a human rating, preference, notes, tags or
 *    whether a human rated the item. These queries read `interaction_annotations` for the caller's OWN judge rows
 *    only (`source='judge'` and its principal), never a human row;
 *  - the SYSTEM PROMPT (memories, custom prompt, data context) is never selected, and `tool_defs_json` neither;
 *  - TOOL RESULTS appear as previews only (80 characters, their size and row count) and are never paged, so a
 *    large `transaction_search` result from chat cannot be rebuilt through this surface. That includes the copy
 *    inside an agent iteration prompt ("Data retrieved from tool calls:") and a chain/team step prompt ("Tool results:"),
 *    which are replaced by a one-line note. A prompt of a call type whose format is not known (an older 'standalone'
 *    row, any new call type) is not paged at all: its overview shows an 80-character preview;
 *  - every text is `{untrusted_text}`: hidden characters stripped, PII masked (digit runs, emails, phone numbers)
 *    over the WHOLE text before it is cut into pages, so a card number split across a page boundary stays masked;
 *  - a browser-subagent handoff block inside a prompt is shown as a marked, truncated excerpt (see
 *    src/training/handoff-block.ts), never in full.
 *
 * Section pages go through the engine's read path, so each one spends from the daily read budget.
 */
import type { Database } from '../db/compat-sqlite.js';
import { CursorError, DEFAULT_OUTPUT_CAP, UNTRUSTED_NOTE, argsHash, capOutput, decodeCursor, encodeCursor, sanitizeUntrustedText } from './output.js';
import { NotFoundError, PrepareError } from './errors.js';
import { excerptHandoffBlocks, hasHandoffBlock, HANDOFF_BLOCK_HEADER_PREFIX } from '../training/handoff-block.js';
import { KNOWN_PROMPT_CALL_TYPES, omitIterationToolResults } from '../agent/iteration-prompt-format.js';
import { JUDGE_RUBRIC, JUDGE_RUBRIC_VERSION, JUDGE_TAGS } from '../training/judge-rubric.js';

/** Call types the Training tab has seen. A static list, so the tool's schema is fixed. */
export const OBSERVED_CALL_TYPES = ['agent', 'chain', 'team', 'categorization', 'entity-classification', 'summarize', 'relevance', 'demo-showdown'] as const;

/** An overview shows this much of a prompt whose format is unknown (a preview, like a tool result). */
const UNKNOWN_FORMAT_PROMPT_CHARS = 80;

export const LIST_DEFAULT_LIMIT = 5;
export const SECTION_PAGE_CHARS = 1200;
/** Longest source text a section is built from: bounds the sanitizer's work on a megabyte response. */
const SECTION_SOURCE_MAX = 100_000;
const PREVIEW_CHARS = 80;
/** A tool result up to this size is parsed to count its rows; a bigger one is only measured. */
const ROW_COUNT_PARSE_MAX = 200_000;

export interface ReadContext {
  /** The audit principal of the caller (tab hash or token id). Scopes "judged" to this agent's own proposals. */
  principalId?: string;
}

// ── list_interactions ────────────────────────────────────────────────────────

interface ListRow {
  id: number;
  run_id: string;
  call_type: string;
  model: string;
  status: string;
  created_at: string;
  open_proposal: number;
  handoff: number;
}

export function listInteractionsRead(db: Database, args: Record<string, unknown>, ctx: ReadContext, cap: number): unknown {
  const filter = (args.filter as 'unjudged' | 'judged' | 'all' | undefined) ?? 'unjudged';
  const limit = typeof args.limit === 'number' ? args.limit : LIST_DEFAULT_LIMIT;
  const conditions: string[] = [];
  const params: Record<string, unknown> = { principal: ctx.principalId ?? '', prefix: HANDOFF_BLOCK_HEADER_PREFIX };
  if (typeof args.callType === 'string') { conditions.push('i.call_type = @callType'); params.callType = args.callType; }
  if (typeof args.model === 'string') { conditions.push('i.model = @model'); params.model = args.model; }
  // "Judged" is about THIS agent's own judge rows. It says nothing about any human row.
  const mine = "SELECT 1 FROM interaction_annotations j WHERE j.interaction_id = i.id AND j.source = 'judge' AND j.principal_id = @principal";
  if (filter === 'unjudged') conditions.push(`NOT EXISTS (${mine})`);
  if (filter === 'judged') conditions.push(`EXISTS (${mine})`);

  const rows = db.prepare(`
    SELECT i.id, i.run_id, i.call_type, i.model, i.status, i.created_at,
      EXISTS (${mine} AND j.status = 'proposed') AS open_proposal,
      instr(i.user_prompt, @prefix) > 0 AS handoff
    FROM llm_interactions i
    ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
    ORDER BY i.id DESC
  `).all(params) as ListRow[];

  return capOutput(rows, {
    cap,
    limit,
    cursor: args.cursor as string | undefined,
    argsHash: argsHash(args),
    project: (r: ListRow) => ({
      id: r.id,
      run: sanitizeUntrustedText(r.run_id.slice(0, 8), 8),
      call_type: sanitizeUntrustedText(r.call_type, 30),
      model: sanitizeUntrustedText(r.model, 64),
      status: sanitizeUntrustedText(r.status, 20),
      created_at: r.created_at,
      openProposal: r.open_proposal === 1,
      ...(r.handoff === 1 ? { handoffNotes: true } : {}),
    }),
  }).body;
}

// ── get_interaction ──────────────────────────────────────────────────────────

interface InteractionRow {
  id: number;
  model: string;
  call_type: string;
  status: string;
  error: string | null;
  user_prompt: string;
  response_content: string | null;
  tool_calls_json: string | null;
}

/** The whole text, sanitized and masked, never cut: pages are slices of this string. */
function sanitizeWhole(text: string): string {
  return sanitizeUntrustedText(text.slice(0, SECTION_SOURCE_MAX), Number.MAX_SAFE_INTEGER);
}

function parseToolCalls(json: string | null): Array<{ name: string; args: unknown }> {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json) as Array<{ name?: unknown; args?: unknown }>;
    return Array.isArray(parsed) ? parsed.map((c) => ({ name: typeof c.name === 'string' ? c.name : '?', args: c.args ?? {} })) : [];
  } catch {
    return [];
  }
}

/** One text per section, plain text before sanitizing. The user prompt has its handoff blocks reduced to excerpts first. */
function sectionTexts(row: InteractionRow): { user_prompt: string; response: string; tool_calls: string; handoff: boolean } {
  // From the second agent iteration the prompt embeds every full tool result: cut that block first (preview-only rule).
  const prompt = excerptHandoffBlocks(omitIterationToolResults(row.user_prompt).text);
  const calls = parseToolCalls(row.tool_calls_json);
  return {
    user_prompt: prompt.text,
    response: row.response_content ?? '',
    tool_calls: calls.map((c) => `${c.name} ${JSON.stringify(c.args)}`).join('\n'),
    handoff: prompt.blocks > 0 || hasHandoffBlock(row.user_prompt),
  };
}

function toolResultPreviews(db: Database, id: number, count: number): Array<{ tool: string; chars: number; rows?: number; preview: string }> {
  const results = db.prepare(`
    SELECT tool_name, length(tool_result) AS chars,
      CASE WHEN length(tool_result) <= @parseMax THEN tool_result ELSE substr(tool_result, 1, 200) END AS body
    FROM llm_tool_results WHERE interaction_id = @id ORDER BY id LIMIT @count
  `).all({ id, count, parseMax: ROW_COUNT_PARSE_MAX }) as Array<{ tool_name: string; chars: number | null; body: string | null }>;
  return results.map((r) => {
    const chars = r.chars ?? 0;
    let rows: number | undefined;
    if (r.body !== null && chars <= ROW_COUNT_PARSE_MAX) {
      try {
        const parsed = JSON.parse(r.body) as unknown;
        if (Array.isArray(parsed)) rows = parsed.length;
        else if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { items?: unknown }).items)) rows = (parsed as { items: unknown[] }).items.length;
      } catch {
        // Not JSON: the size and the preview are all there is.
      }
    }
    return {
      tool: sanitizeUntrustedText(r.tool_name, 40),
      chars,
      ...(rows === undefined ? {} : { rows }),
      preview: sanitizeUntrustedText(r.body ?? '', PREVIEW_CHARS),
    };
  });
}

function loadInteraction(db: Database, id: number): InteractionRow {
  // Explicit columns: never `system_prompt`, never `tool_defs_json`.
  const row = db
    .prepare('SELECT id, model, call_type, status, error, user_prompt, response_content, tool_calls_json FROM llm_interactions WHERE id = @id')
    .get({ id }) as InteractionRow | undefined;
  if (!row) throw new NotFoundError(`Interaction #${id} not found — use list_interactions.`);
  return row;
}

export function getInteractionRead(db: Database, args: Record<string, unknown>, cap: number): unknown {
  const id = args.id as number;
  const section = (args.section as 'overview' | 'user_prompt' | 'response' | 'tool_calls' | undefined) ?? 'overview';
  const row = loadInteraction(db, id);
  const texts = sectionTexts(row);
  // Defence in depth: the cut above knows three prompt formats. Another call type may embed raw tool results in a
  // shape it does not know, so its prompt is not paged (the other sections are unaffected).
  const knownFormat = KNOWN_PROMPT_CALL_TYPES.includes(row.call_type);

  if (section === 'user_prompt' && !knownFormat) {
    throw new PrepareError(`The prompt of a '${sanitizeUntrustedText(row.call_type, 30)}' interaction is not paged: its format is not known, so tool results in it cannot be cut. The overview shows a preview.`);
  }

  if (section !== 'overview') {
    const whole = sanitizeWhole(texts[section]);
    const hash = argsHash(args);
    let offset = 0;
    if (typeof args.cursor === 'string') {
      const decoded = decodeCursor(args.cursor);
      if (decoded.h !== hash) throw new CursorError();
      offset = decoded.o;
    }
    const handoff = section === 'user_prompt' && texts.handoff ? { handoff_block: true } : {};
    // Shrink the page until the serialized answer fits: quotes and backslashes cost two characters each in JSON.
    let size = Math.min(SECTION_PAGE_CHARS, Math.max(0, whole.length - offset));
    const build = (n: number) => {
      const next = offset + n;
      return {
        section,
        untrusted_text: whole.slice(offset, next),
        ...(next < whole.length ? { nextCursor: encodeCursor(next, hash) } : {}),
        ...handoff,
        note: UNTRUSTED_NOTE,
      };
    };
    let body = build(size);
    while (size > 0 && JSON.stringify(body).length > cap) {
      size = Math.max(0, size - Math.max(10, Math.ceil((JSON.stringify(body).length - cap) / 2)));
      body = build(size);
    }
    return body;
  }

  const sectionSizes = {
    user_prompt: sanitizeWhole(texts.user_prompt).length,
    response: sanitizeWhole(texts.response).length,
    tool_calls: sanitizeWhole(texts.tool_calls).length,
  };
  const calls = parseToolCalls(row.tool_calls_json).map((c) => ({ name: sanitizeUntrustedText(c.name, 40), args: sanitizeUntrustedText(JSON.stringify(c.args), 80) }));
  const results = toolResultPreviews(db, id, 5);

  // Defaults first, then give back room in a fixed order until the answer fits: results and calls to two,
  // response and prompt shorter, then the rest.
  const steps: Array<Partial<{ results: number; calls: number; response: number; user: number }>> = [
    {},
    { results: 3 },
    { results: 2, calls: 3 },
    { results: 2, calls: 2, response: 350 },
    { results: 2, calls: 2, response: 250, user: 220 },
    { results: 1, calls: 1, response: 180, user: 160 },
    { results: 0, calls: 0, response: 120, user: 120 },
  ];
  let body: Record<string, unknown> = {};
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    body = {
      id: row.id,
      model: sanitizeUntrustedText(row.model, 64),
      call_type: sanitizeUntrustedText(row.call_type, 30),
      status: sanitizeUntrustedText(row.status, 20),
      ...(row.error ? { error: sanitizeUntrustedText(row.error, 120) } : {}),
      user_prompt: { untrusted_text: sanitizeUntrustedText(texts.user_prompt, knownFormat ? (s.user ?? 300) : Math.min(s.user ?? 300, UNKNOWN_FORMAT_PROMPT_CHARS)), ...(texts.handoff ? { handoff_block: true } : {}) },
      response: { untrusted_text: sanitizeUntrustedText(texts.response, s.response ?? 500) },
      tool_calls: calls.slice(0, s.calls ?? 5),
      tool_results: results.slice(0, s.results ?? 5),
      sectionSizes,
      ...(i > 0 ? { truncated: true } : {}),
      note: UNTRUSTED_NOTE,
    };
    if (JSON.stringify(body).length <= cap) break;
  }
  return body;
}

// ── get_judge_rubric ─────────────────────────────────────────────────────────

export function judgeRubricRead(): unknown {
  return {
    version: JUDGE_RUBRIC_VERSION,
    scale: JUDGE_RUBRIC.scale,
    criteria: JUDGE_RUBRIC.criteria.map((c) => ({ id: c.id, weight: c.weight, description: c.description })),
    rules: [...JUDGE_RUBRIC.rules],
    tags: [...JUDGE_TAGS],
  };
}

export { DEFAULT_OUTPUT_CAP };
