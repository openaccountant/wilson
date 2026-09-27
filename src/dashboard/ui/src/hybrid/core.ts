/**
 * Hybrid (local-first WebGPU) chat — pure, DOM-free core.
 *
 * Shared by the legacy dashboard (src/dashboard/html.ts, via the prebuilt
 * /assets/hybrid-chat.js chunk) and the React ChatTab. Everything here is
 * plain TypeScript with no window/document/fetch access, so it can be unit
 * tested under bun and typechecked under both the root and the UI tsconfigs.
 *
 * Design contract: the bundle is a pre-fetched, bounded, projected view of the
 * user's own transactions framed in the repo's established injected-context
 * marker style (src/utils/history-context.ts); the local model must answer
 * only from it, and anything else classifies as a hand-off to the server agent.
 */

import { CURRENT_MESSAGE_MARKER } from '../../../../utils/history-context.js';

export { CURRENT_MESSAGE_MARKER };

// ── Context bundle ──────────────────────────────────────────────────────────

/** The narrow field subset the local model is allowed to see. */
export interface BundleTxn {
  date: string;
  description: string;
  amount: number;
  category: string | null;
}

/** API row shape — may carry extra fields that must NOT leak into the bundle. */
export interface BundleTxnInput {
  date: string;
  description: string;
  amount: number;
  category?: string | null;
  [extra: string]: unknown;
}

/** Narrowed weekly-summary shape (from GET /api/weekly-summary). */
export interface BundleWeekly {
  thisWeek: { total: number; topCategory: string | null };
  lastWeek: { total: number; topCategory: string | null };
  change: { amount: number; percent: number };
}

export interface BundleParams {
  days: number;
  limit: number;
  maxChars: number;
}

export interface ContextBundle {
  text: string;
  rowCount: number;
  totalRows: number;
  truncated: boolean;
}

/** Date `days` before `from` as YYYY-MM-DD (lexicographic-safe). */
export function isoDaysAgo(days: number, from: Date = new Date()): string {
  const d = new Date(from);
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

function money(n: number): string {
  return (n < 0 ? '-$' : '$') + Math.abs(n).toFixed(2);
}

/**
 * Narrow the API's transaction rows to the four fields the local model may
 * see, keep only the most recent `days` days, cap at `limit` rows, and return
 * them oldest-first (chronological) so the size guard can drop from the front
 * (oldest) when over budget.
 *
 * Contract: /api/transactions returns rows newest-first (ORDER BY date DESC).
 */
export function projectTransactions(
  rows: BundleTxnInput[],
  params: { days: number; limit: number },
): BundleTxn[] {
  const cutoff = isoDaysAgo(params.days);
  const projected = rows
    .filter((r) => typeof r.date === 'string' && r.date >= cutoff)
    .slice(0, params.limit)
    .map((r) => ({
      date: r.date,
      description: String(r.description ?? ''),
      amount: Number(r.amount) || 0,
      category: r.category ?? null,
    }));
  projected.reverse();
  return projected;
}

export const BUNDLE_START_MARKER = '[Pre-fetched transaction context]';
export const BUNDLE_END_MARKER = '[End of pre-fetched context]';

/**
 * Render the context bundle and size-guard it for a 0.6B-class context window.
 *
 * Framing mirrors the repo's injected-context marker style; the size guard
 * drops the OLDEST transaction rows first and never touches the weekly
 * summary, the framing markers, or the current-message marker. The rendered
 * text never exceeds `params.maxChars`.
 */
export function buildBundle(
  txns: BundleTxn[],
  weekly: BundleWeekly | null,
  params: BundleParams,
): ContextBundle {
  const totalRows = txns.length;
  const kept = [...txns];
  let truncated = false;

  const render = (): string => {
    const lines: string[] = [];
    lines.push(BUNDLE_START_MARKER);
    lines.push(
      `Period: ${isoDaysAgo(params.days)}..${isoDaysAgo(0)} (last ${params.days} days, ` +
        `${kept.length} of ${totalRows} transactions shown)`,
    );
    if (truncated) {
      lines.push('[Older transactions were dropped to fit the local context window.]');
    }
    if (weekly) {
      lines.push(
        `Weekly spending: this week ${money(weekly.thisWeek.total)} (top: ${weekly.thisWeek.topCategory ?? 'none'}), ` +
          `last week ${money(weekly.lastWeek.total)} (top: ${weekly.lastWeek.topCategory ?? 'none'}), ` +
          `change ${money(weekly.change.amount)} (${weekly.change.percent >= 0 ? '+' : ''}${weekly.change.percent}%)`,
      );
    }
    lines.push('Transactions (date | description | amount | category):');
    for (const t of kept) {
      lines.push(`${t.date} | ${t.description} | ${t.amount.toFixed(2)} | ${t.category ?? 'Uncategorized'}`);
    }
    lines.push(BUNDLE_END_MARKER);
    lines.push(CURRENT_MESSAGE_MARKER);
    return lines.join('\n');
  };

  let text = render();
  while (text.length > params.maxChars && kept.length > 0) {
    kept.shift(); // chronological order: front = oldest
    truncated = true;
    text = render();
  }
  if (text.length > params.maxChars) {
    // Pathological budget (markers alone exceed it) — enforce the hard cap.
    text = text.slice(0, params.maxChars);
  }
  return { text, rowCount: kept.length, totalRows, truncated };
}

// ── Local prompts ───────────────────────────────────────────────────────────

/**
 * The local system prompt carries the repo's honesty rules: answer only from
 * the bundle, never invent figures, no tool-calling, deterministic opt-out.
 * The bundle itself rides in the user turn (single copy in the 0.6B window),
 * directly under CURRENT_MESSAGE_MARKER.
 */
export const LOCAL_SYSTEM_PROMPT_TEMPLATE = `You are Open Accountant's local browser assistant. Today is {date}.
The user's message contains a pre-fetched snapshot of their own recent transactions. It is your only data source.

Rules:
- Answer ONLY from that pre-fetched context. Never invent, estimate, or extrapolate figures that are not derivable from it.
- Do not attempt tool calls; you have no tools.
- If the context does not contain what the question needs, reply with exactly NEED_MORE_DATA and nothing else — the app will route the question to the full agent.
- Keep answers short. Use $ amounts.`;

export function buildLocalSystemPrompt(today: string): string {
  return LOCAL_SYSTEM_PROMPT_TEMPLATE.replace('{date}', today);
}

/** User turn: the framed bundle followed by the question under the marker. */
export function buildLocalUserMessage(bundleText: string, question: string): string {
  return `${bundleText}\nQuestion: ${question}`;
}

// ── Hand-off detection ──────────────────────────────────────────────────────

export type HandoffReason = 'tool-call' | 'outside-bundle' | 'no-answer' | 'error';

export type LocalVerdict = { kind: 'answer'; text: string } | { kind: 'handoff'; reason: HandoffReason };

/** Result of a local attempt — the UI treats {ok:false} as "use the server path", never as an error. */
export type HybridResult =
  | { ok: true; answer: string; sessionId: string | null; source: 'local' }
  | { ok: false; reason?: HandoffReason };

/** Deterministic opt-out the local system prompt teaches the model. */
export const NEED_MORE_SENTINEL = 'NEED_MORE_DATA';

/**
 * Fuzzy backstop for models that never learned the sentinel. All lowercase,
 * multiword phrases to avoid false positives on innocuous answers.
 */
export const NEED_MORE_PHRASES: readonly string[] = [
  "i don't have access",
  'i do not have access',
  'need access to',
  'please provide me',
  'provide me with',
  'upload your',
  'import your',
  'connect your',
  'outside the provided',
  'beyond the provided',
  'not included in the provided',
  'i cannot see your',
  'no tools available',
];

// Tool-call marker detection. The tags are written as unicode escapes so they
// never appear literally in this file.
// Repo tool-call marker - mirrors parseToolCall in src/model/providers/transformers.ts.
const TOOL_CALL_REPO = new RegExp('\x3ctool_call>[\\s\\S]*?\x3c/tool_call>');
// Qwen3's native tool-call form.
const TOOL_CALL_QWEN = new RegExp('\x3ctool_call>[\\s\\S]*?\x3ctool_response>');

/**
 * Decide whether local output is a usable answer or must hand off silently to
 * the server agent. Order matters and is pinned by tests: tool-call shapes
 * first, then the sentinel, then the fuzzy phrases, then empty output.
 */
export function classifyLocalOutput(text: string): LocalVerdict {
  if (TOOL_CALL_REPO.test(text) || TOOL_CALL_QWEN.test(text)) {
    return { kind: 'handoff', reason: 'tool-call' };
  }
  if (text.includes(NEED_MORE_SENTINEL)) {
    return { kind: 'handoff', reason: 'outside-bundle' };
  }
  const lower = text.toLowerCase();
  if (NEED_MORE_PHRASES.some((phrase) => lower.includes(phrase))) {
    return { kind: 'handoff', reason: 'outside-bundle' };
  }
  const trimmed = text.trim();
  if (!trimmed) {
    return { kind: 'handoff', reason: 'no-answer' };
  }
  return { kind: 'answer', text: trimmed };
}

// ── Capability decision matrix ──────────────────────────────────────────────

export type HybridCapability = 'unknown' | 'ready' | 'unavailable' | 'failed';

/**
 * Whether the local path should be attempted at all, given the cached
 * capability verdict. Only 'unknown' (probe first) and 'ready' (proven this
 * session) allow a local attempt; 'unavailable' (no WebGPU) and 'failed'
 * (model load/generation broke) go straight to the server path for the rest
 * of the browser session.
 */
export function shouldAttemptLocal(state: HybridCapability): boolean {
  return state === 'unknown' || state === 'ready';
}

// ── Response provenance ─────────────────────────────────────────────────────

/**
 * Which path actually produced a live chat response. Carried on the live
 * message only — never persisted (no chat-history schema change), so
 * history-loaded messages render with no indicator.
 */
export type ChatProvenance = 'local-with-context' | 'server-fallback' | 'unavailable';

export const PROVENANCE_BADGES: Record<ChatProvenance, string> = {
  'local-with-context': 'answered locally · on-device',
  'server-fallback': 'server fallback',
  'unavailable': 'server agent',
};

/**
 * Single source of truth for the per-response indicator, pinned by
 * src/__tests__/local-chat-provenance.test.ts. `hybridLayerPresent` = the
 * prebuilt hybrid chunk was loadable at send time (window global defined /
 * hook status !== 'unavailable'). WebGPU-unavailable counts as present —
 * the local layer was in play and the server covered for it, which is a
 * fallback. Only when the hybrid layer itself is absent (chunk 404 /
 * window global undefined) was local inference skipped entirely, and the
 * neutral state applies. Deliberately NOT keyed off HybridResult.reason:
 * no-reason {ok:false} results are ambiguous by design, and layer presence
 * is what separates fallback from neutral.
 */
export function deriveChatProvenance(outcome: {
  localAnswered: boolean;
  hybridLayerPresent: boolean;
}): ChatProvenance {
  if (outcome.localAnswered) return 'local-with-context';
  return outcome.hybridLayerPresent ? 'server-fallback' : 'unavailable';
}