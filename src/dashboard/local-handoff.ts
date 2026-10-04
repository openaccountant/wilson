/**
 * Server side of the browser subagent's handoff (specs/browser-subagent.md
 * section 8, DECISIONS Q10 and Q11).
 *
 * When the on-device subagent can't answer, the dashboard sends what it did
 * as an optional `localHandoff` on POST /api/chat. Everything in it is
 * UNTRUSTED (it comes from a browser, and the strings in it can come from
 * attacker-controlled merchant descriptions or a 0.6B model):
 *
 *  - The payload is zod-strict validated, with each step's tool limited to the
 *    five catalog READ tools and its args re-validated against that tool's own
 *    zod shape (unknown keys rejected). Anything invalid is dropped silently:
 *    a handoff is advisory and must never fail the user's message.
 *  - Q11: the server RE-EXECUTES each validated `{tool, args}` (at most 4)
 *    through `executeRead`, the same tool functions the agent runs, and renders
 *    only those server-computed results. Client summaries, `ok` flags and their
 *    numbers are never rendered.
 *  - Q10: `priorLocalTurns` (on-device Q&A that never left the machine) are
 *    dropped unless the configured chat provider runs locally.
 *  - Every untrusted string is sanitised before it reaches the prompt: control
 *    characters stripped, `[`/`]` neutralised so nothing can forge the
 *    history/current-message markers or this block's own header and end,
 *    blank lines collapsed, and every content line indented.
 *
 * The rendered block rides the existing `contextBlock` seam of
 * handleChatMessage (after the mention block), so chat.ts is unchanged. History
 * replay strips it again (stripHandoffBlock in in-memory-chat-history.ts).
 */
import { z } from 'zod';
import type { Database } from '../db/compat-sqlite.js';
import { executeRead, getToolDef } from '../mcp/tool-catalog.js';
import { getProviderById, resolveProvider } from '../providers.js';
import { getConfiguredModel } from '../utils/config.js';
import {
  HANDOFF_BLOCK_END,
  HANDOFF_BLOCK_HEADER,
  HANDOFF_CAPS,
  HANDOFF_TO_CATALOG,
  type HandoffReadToolName,
  type LocalHandoffV1,
} from './local-handoff-format.js';

export { stripHandoffBlock, stripInjectedContext } from './local-handoff-format.js';

/** Server hard cap on `JSON.stringify(localHandoff).length`; larger payloads are dropped before parsing. */
export const LOCAL_HANDOFF_MAX_RAW_CHARS = 16_384;
/** At most this many steps are re-executed (Q11). */
export const REEXEC_MAX_STEPS = HANDOFF_CAPS.maxSteps;
/** Per-step re-execution bound; the read tools are fast local SQLite queries. */
const REEXEC_TIMEOUT_MS = 5_000;
/** Rendered args JSON per line. */
const ARGS_RENDER_CHARS = 600;
const ERROR_RENDER_CHARS = 200;

// ── Schema ───────────────────────────────────────────────────────────────────

const READ_TOOLS = ['transaction_search', 'spending_summary', 'profit_loss', 'net_worth', 'forecast'] as const;
const AGENT_READ_TOOLS = ['transaction_search', 'spending_summary', 'profit_loss', 'net_worth'] as const;
const PROPOSAL_TOOLS = ['edit_transaction', 'delete_transaction', 'tax_flag', 'categorize', 'other'] as const;
const REASONS = [
  'tool-call', 'outside-bundle', 'no-answer', 'error',
  'mutation-intent', 'non-data', 'router-none', 'router-invalid', 'args-unfillable',
  'tool-unavailable', 'mirror-unavailable', 'mirror-stale', 'step-limit', 'ungrounded', 'deadline',
  'empty-result',
] as const;

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?$/;
const argsRecord = z.record(z.string(), z.unknown());

const HandoffSchema = z.strictObject({
  v: z.literal(1),
  reason: z.enum(REASONS),
  mirror: z.strictObject({ syncedAt: z.string().max(40).regex(ISO_TIMESTAMP).nullable() }),
  steps: z
    .array(
      z.strictObject({
        tool: z.enum(READ_TOOLS),
        args: argsRecord,
        ok: z.boolean(),
        summary: z.string().max(HANDOFF_CAPS.summaryChars),
      }),
    )
    .max(HANDOFF_CAPS.maxSteps),
  suggestedCall: z.strictObject({ tool: z.enum(AGENT_READ_TOOLS), args: argsRecord }).optional(),
  proposal: z.strictObject({ tool: z.enum(PROPOSAL_TOOLS), userWords: z.string().max(HANDOFF_CAPS.userWordsChars) }).optional(),
  localNote: z.string().max(HANDOFF_CAPS.localNoteChars).optional(),
  priorLocalTurns: z
    .array(
      z.strictObject({
        q: z.string().max(HANDOFF_CAPS.priorQuestionChars),
        a: z.string().max(HANDOFF_CAPS.priorAnswerChars),
      }),
    )
    .max(HANDOFF_CAPS.priorTurns)
    .optional(),
});

/**
 * Re-validate one read tool's args against the catalog's zod shape, strictly
 * (spec C11; judge P0a's parseToolArgs replaces this when it lands). Returns the
 * PARSED args (nested unknown keys stripped) or null.
 */
function parseReadArgs(tool: string, args: Record<string, unknown>): Record<string, unknown> | null {
  // Mirror vocabulary -> catalog name through the one boundary map; never through the retired-name map.
  const catalogName = Object.prototype.hasOwnProperty.call(HANDOFF_TO_CATALOG, tool) ? HANDOFF_TO_CATALOG[tool as HandoffReadToolName] : undefined;
  const def = catalogName ? getToolDef(catalogName) : undefined;
  if (!def || def.classification !== 'read') return null;
  const parsed = z.object(def.zodShape).strict().safeParse(args);
  return parsed.success ? (parsed.data as Record<string, unknown>) : null;
}

// ── Provider policy (Q10) ────────────────────────────────────────────────────

/**
 * Does the dashboard chat agent run on this device? Local only when BOTH the
 * configured provider and the model it will actually call (routed by prefix)
 * are local providers; any mismatch counts as cloud.
 */
export function isChatProviderLocal(cfg: { model: string; provider: string }): boolean {
  const provider = getProviderById(cfg.provider);
  if (!provider?.isLocal) return false;
  return resolveProvider(cfg.model).isLocal === true;
}

function configuredProviderIsLocal(): boolean {
  try {
    return isChatProviderLocal(getConfiguredModel());
  } catch {
    return false; // no profile / unreadable settings: treat as cloud
  }
}

// ── Parse ────────────────────────────────────────────────────────────────────

export type ParseLocalHandoffResult = { ok: true; value: LocalHandoffV1 } | { ok: false };

export interface ParseLocalHandoffOptions {
  /** Whether the chat provider is local (Q10). Defaults to the configured chat model. */
  providerIsLocal?: boolean;
}

/**
 * Validate an untrusted `localHandoff`. Never throws; anything invalid is
 * `{ok:false}` (the caller drops it and the chat proceeds as before).
 */
export function parseLocalHandoff(raw: unknown, opts: ParseLocalHandoffOptions = {}): ParseLocalHandoffResult {
  try {
    if (raw === undefined || raw === null) return { ok: false };
    const size = JSON.stringify(raw)?.length ?? 0;
    if (size === 0 || size > LOCAL_HANDOFF_MAX_RAW_CHARS) return { ok: false };

    const parsed = HandoffSchema.safeParse(raw);
    if (!parsed.success) return { ok: false };
    const h = parsed.data;

    const steps: LocalHandoffV1['steps'] = [];
    for (const step of h.steps) {
      const args = parseReadArgs(step.tool, step.args);
      if (!args) return { ok: false };
      steps.push({ tool: step.tool, args, ok: step.ok, summary: step.summary });
    }

    const value: LocalHandoffV1 = { v: 1, reason: h.reason, mirror: { syncedAt: h.mirror.syncedAt }, steps };

    if (h.suggestedCall) {
      const args = parseReadArgs(h.suggestedCall.tool, h.suggestedCall.args);
      if (!args) return { ok: false };
      value.suggestedCall = { tool: h.suggestedCall.tool, args };
    }
    if (h.proposal) value.proposal = { tool: h.proposal.tool, userWords: h.proposal.userWords };
    // The draft answer only means something for a grounding failure.
    if (h.localNote !== undefined && h.reason === 'ungrounded') value.localNote = h.localNote;

    const providerIsLocal = opts.providerIsLocal ?? configuredProviderIsLocal();
    if (h.priorLocalTurns && h.priorLocalTurns.length > 0 && providerIsLocal) {
      value.priorLocalTurns = h.priorLocalTurns.map((t) => ({ q: t.q, a: t.a }));
    }
    return { ok: true, value };
  } catch {
    return { ok: false };
  }
}

// ── Sanitising ───────────────────────────────────────────────────────────────

/**
 * Make untrusted text safe to place in the prompt: CRLF/CR → LF, line and
 * paragraph separators → LF, tabs → space, other C0/C1 controls and DEL
 * removed, `[`/`]` → `(`/`)` (no marker forgery), runs of newlines collapsed.
 */
export function sanitizeUntrusted(text: string): string {
  return String(text ?? '')
    .replace(/\r\n?|[\u2028\u2029\u0085]/g, '\n')
    .replace(/\t/g, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/g, '')
    .replace(/\[/g, '(')
    .replace(/\]/g, ')')
    .replace(/\n{2,}/g, '\n');
}

/** One-line sanitised text. */
function sanitizeInline(text: string): string {
  return sanitizeUntrusted(text).replace(/\n/g, ' ');
}

/** Indent every non-empty line of untrusted text so none of it starts at column 0. */
function indented(text: string): string[] {
  return sanitizeUntrusted(text)
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => `  > ${line}`);
}

function capText(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

/** Sanitise every string leaf (and key), THEN stringify, so JSON arrays keep their brackets (spec C11). */
function sanitizeLeaves(value: unknown): unknown {
  if (typeof value === 'string') return sanitizeInline(value);
  if (Array.isArray(value)) return value.map(sanitizeLeaves);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[sanitizeInline(k)] = sanitizeLeaves(v);
    return out;
  }
  return value;
}

function renderArgs(args: Record<string, unknown>): string {
  return capText(JSON.stringify(sanitizeLeaves(args)) ?? '{}', ARGS_RENDER_CHARS);
}

// ── Server read summaries ────────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function money(amount: number): string {
  return amount < 0 ? `-$${Math.abs(amount).toFixed(2)}` : `+$${amount.toFixed(2)}`;
}

/** Keys that never leave a server read summary (spec 8.3: no notes, account numbers, masks, institution ids, account names). */
const DENY_KEYS = new Set([
  'id', 'name', 'institution', 'notes', 'note', 'mask', 'account_number', 'accountNumber', 'account_mask',
  'external_id', 'externalId', 'plaid_account_id', 'plaid_item_id', 'institution_id', 'routing_number',
]);

function scalar(v: unknown): string | null {
  if (typeof v === 'number') return Number.isFinite(v) ? String(Math.round(v * 100) / 100) : null;
  if (typeof v === 'boolean') return String(v);
  if (typeof v === 'string') return capText(v, 80);
  return null;
}

/** `key: value` lines for scalar leaves; arrays of objects become one `key: a=1, b=x` line per element. */
function flatten(data: Record<string, unknown>, maxRows = 24): string[] {
  const lines: string[] = [];
  for (const [key, v] of Object.entries(data)) {
    if (DENY_KEYS.has(key)) continue;
    const s = scalar(v);
    if (s !== null) {
      lines.push(`${key}: ${s}`);
    } else if (Array.isArray(v)) {
      for (const el of v.slice(0, maxRows)) {
        if (isRecord(el)) {
          const parts = Object.entries(el)
            .filter(([k]) => !DENY_KEYS.has(k))
            .map(([k, x]) => [k, scalar(x)] as const)
            .filter(([, x]) => x !== null)
            .map(([k, x]) => `${k}=${x}`);
          if (parts.length) lines.push(`${key}: ${parts.join(', ')}`);
        } else {
          const x = scalar(el);
          if (x !== null) lines.push(`${key}: ${x}`);
        }
      }
      if (v.length > maxRows) lines.push(`${key}: (+${v.length - maxRows} more)`);
    }
  }
  return lines;
}

/** net_worth: totals and per-SUBTYPE sums only; per-account rows never leave (spec 8.3). */
function summarizeNetWorth(data: Record<string, unknown>): string[] {
  const lines: string[] = [];
  if (typeof data.message === 'string') lines.push(data.message);
  for (const key of ['netWorth', 'totalAssets', 'totalLiabilities', 'months']) {
    const s = scalar(data[key]);
    if (s !== null && typeof data[key] === 'number') lines.push(`${key}: ${s}`);
  }
  for (const side of ['assets', 'liabilities']) {
    const rows = data[side];
    if (!Array.isArray(rows)) continue;
    const bySubtype = new Map<string, { total: number; count: number }>();
    for (const r of rows) {
      if (!isRecord(r)) continue;
      const subtype = typeof r.subtype === 'string' ? r.subtype : 'Other';
      const amount = typeof r.total === 'number' ? r.total : typeof r.balance === 'number' ? r.balance : 0;
      const count = typeof r.count === 'number' ? r.count : 1;
      const cur = bySubtype.get(subtype) ?? { total: 0, count: 0 };
      cur.total += amount;
      cur.count += count;
      bySubtype.set(subtype, cur);
    }
    for (const [subtype, t] of bySubtype) lines.push(`${side}: ${capText(subtype, 40)} ${scalar(t.total)} (${t.count})`);
  }
  if (Array.isArray(data.trend)) lines.push(...flatten({ trend: data.trend }));
  return lines;
}

/**
 * The text a re-executed read contributes to the handoff block: at most 1,200
 * chars. transaction_search is projected to at most 25 rows of id / date /
 * description (<= 80) / amount / category; spending_summary and profit_loss use
 * the tool's own formatted text; net_worth is totals and subtype sums; anything
 * else is a flat list of scalar fields without names, institutions or ids.
 * The caller sanitises it.
 */
export function summarizeServerRead(tool: HandoffReadToolName, data: unknown): string {
  const cap = HANDOFF_CAPS.summaryChars;
  if (typeof data === 'string') return capText(data, cap);
  if (!isRecord(data)) return capText(JSON.stringify(data) ?? 'No result.', cap);
  if (typeof data.error === 'string') return capText(`Tool error: ${data.error}`, cap);

  if (tool === 'transaction_search' && typeof data.count === 'number' && Array.isArray(data.transactions)) {
    const count = data.count;
    if (count === 0) return 'No transactions found matching your query.';
    const head = `Found ${count} transaction${count === 1 ? '' : 's'}.`;
    const lines: string[] = [head];
    let used = head.length;
    let shown = 0;
    for (const r of (data.transactions as unknown[]).slice(0, HANDOFF_CAPS.searchRows)) {
      if (!isRecord(r)) continue;
      const desc = capText(String(r.description ?? ''), HANDOFF_CAPS.searchDescriptionChars);
      const amount = typeof r.amount === 'number' ? money(r.amount) : '?';
      const category = typeof r.category === 'string' && r.category ? r.category : 'Uncategorized';
      const line = `#${String(r.id ?? '?')} ${String(r.date ?? '?')} ${amount} ${category} ${desc}`;
      if (used + line.length + 1 + 24 > cap) break;
      lines.push(line);
      used += line.length + 1;
      shown++;
    }
    if (count > shown) lines.push(`(+${count - shown} more)`);
    return capText(lines.join('\n'), cap);
  }

  if ((tool === 'spending_summary' || tool === 'profit_loss') && typeof data.formatted === 'string') {
    return capText(data.formatted, cap);
  }
  if (tool === 'net_worth') return capText(summarizeNetWorth(data).join('\n') || 'No result.', cap);
  return capText(flatten(data).join('\n') || 'No result.', cap);
}

// ── Re-execution (Q11) ───────────────────────────────────────────────────────

/** Runs one READ tool on the server (in production: `executeRead` on the active DB). */
export type ReadExecutor = (tool: HandoffReadToolName, args: Record<string, unknown>) => Promise<unknown>;

/** A step as re-run on the server: the only step content that is ever rendered. */
export interface VerifiedStep {
  tool: HandoffReadToolName;
  args: Record<string, unknown>;
  ok: boolean;
  summary: string;
}

/** The production executor: the same tool functions the dashboard agent runs. */
export function serverReadExecutor(db: Database): ReadExecutor {
  return (tool, args) => executeRead(db, HANDOFF_TO_CATALOG[tool], args);
}

async function runWithTimeout(exec: ReadExecutor, tool: HandoffReadToolName, args: Record<string, unknown>): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => exec(tool, args)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timed out')), REEXEC_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Re-run each validated step (at most 4) on the server. The client's `ok` and
 * `summary` are ignored; a failing re-run is reported as such. Never throws.
 * `suggestedCall` is a hint for the agent and is never executed here.
 */
export async function reexecuteSteps(value: LocalHandoffV1, exec: ReadExecutor): Promise<VerifiedStep[]> {
  const out: VerifiedStep[] = [];
  for (const step of value.steps.slice(0, REEXEC_MAX_STEPS)) {
    try {
      const data = await runWithTimeout(exec, step.tool, step.args);
      const failed = isRecord(data) && typeof data.error === 'string';
      out.push({ tool: step.tool, args: step.args, ok: !failed, summary: summarizeServerRead(step.tool, data) });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      out.push({ tool: step.tool, args: step.args, ok: false, summary: `re-run failed: ${capText(msg, ERROR_RENDER_CHARS)}` });
    }
  }
  return out;
}

// ── Render ───────────────────────────────────────────────────────────────────

/**
 * Render the framed, sanitised block. Steps come ONLY from `verified` (the
 * server re-run); the client's step summaries are never rendered. Ends with the
 * end marker and one blank line, and contains no blank line before that.
 */
export function renderHandoffBlock(value: LocalHandoffV1, verified: VerifiedStep[]): string {
  const lines: string[] = [HANDOFF_BLOCK_HEADER];
  lines.push(`Handoff reason: ${value.reason}. Mirror synced ${value.mirror.syncedAt ? sanitizeInline(value.mirror.syncedAt) : 'unknown'}.`);

  if (verified.length > 0) {
    lines.push('Lookups the on-device assistant ran, re-run on the server just now (results are server-computed):');
    for (const step of verified) {
      lines.push(`- ${step.tool} ${renderArgs(step.args)}`);
      lines.push(...indented(step.summary));
    }
  }
  if (value.suggestedCall) {
    lines.push(`Suggested next call: ${value.suggestedCall.tool} ${renderArgs(value.suggestedCall.args)}`);
  }
  if (value.proposal) {
    lines.push(`Change request (NOT executed; act only with your own tools and the normal approval flow): ${value.proposal.tool}`);
    lines.push(...indented(value.proposal.userWords));
  }
  if (value.localNote) {
    lines.push('On-device draft answer that FAILED the grounding check (do not trust its numbers):');
    lines.push(...indented(value.localNote));
  }
  if (value.priorLocalTurns && value.priorLocalTurns.length > 0) {
    lines.push('Earlier turns answered on-device in this session:');
    for (const t of value.priorLocalTurns) {
      lines.push(...indented(`Q: ${t.q}`));
      lines.push(...indented(`A: ${t.a}`));
    }
  }
  lines.push(HANDOFF_BLOCK_END);
  return `${lines.join('\n')}\n\n`;
}

// ── Route helper ─────────────────────────────────────────────────────────────

export interface BuildHandoffContextDeps {
  exec: ReadExecutor;
  /** Defaults to the configured chat model (Q10). */
  providerIsLocal?: boolean;
}

/**
 * Parse, re-execute and render an untrusted `localHandoff`; '' when there is
 * none or it is invalid. Never throws: the user's message must not fail
 * because of a handoff.
 */
export async function buildHandoffContext(raw: unknown, deps: BuildHandoffContextDeps): Promise<string> {
  try {
    const parsed = parseLocalHandoff(raw, { providerIsLocal: deps.providerIsLocal });
    if (!parsed.ok) return '';
    const verified = await reexecuteSteps(parsed.value, deps.exec);
    return renderHandoffBlock(parsed.value, verified);
  } catch {
    return '';
  }
}
