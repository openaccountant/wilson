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
import { looksLikeBareToolCall } from '../../../../model/tool-call-parse.js';
import { money } from '../format';
import type { LocalHandoffV1 } from '../../../../dashboard/local-handoff-format.js';

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

/**
 * Qwen3's documented soft switch: suppresses the <think> reasoning preamble,
 * which would otherwise eat most of the small local token budget. Models
 * without the switch just see an inert trailing token.
 */
export const NO_THINK_SWITCH = '/no_think';

/** User turn: the framed bundle followed by the question under the marker. */
export function buildLocalUserMessage(bundleText: string, question: string): string {
  return `${bundleText}\nQuestion: ${question} ${NO_THINK_SWITCH}`;
}

/**
 * Remove reasoning-model <think>…</think> blocks (Qwen3 emits an empty one
 * even under /no_think). An unterminated <think> — the token cap ran out
 * mid-reasoning — drops everything after it: that is no answer at all, and
 * must never be shown as one.
 */
export function stripThinking(text: string): string {
  const closed = text.replace(/<think>[\s\S]*?<\/think>/g, '');
  const open = closed.indexOf('<think>');
  return open === -1 ? closed : closed.slice(0, open);
}

// ── Hand-off detection ──────────────────────────────────────────────────────

/** Why bundle mode handed off (the original four, pinned by local-chat-handoff.test.ts). */
export type BundleHandoffReason = 'tool-call' | 'outside-bundle' | 'no-answer' | 'error';

/**
 * Every reason a local attempt can hand the turn to the server: the four bundle
 * reasons plus the subagent's (specs/browser-subagent.md section 4.2).
 * 'cancelled' is the odd one out: a cancelled run sends nothing to the server.
 */
export type HandoffReason =
  | BundleHandoffReason
  | 'mutation-intent' | 'non-data' | 'router-none' | 'router-invalid' | 'args-unfillable'
  | 'tool-unavailable' | 'mirror-unavailable' | 'mirror-stale' | 'step-limit' | 'ungrounded' | 'deadline' | 'cancelled'
  | 'empty-result';

export type LocalVerdict = { kind: 'answer'; text: string } | { kind: 'handoff'; reason: BundleHandoffReason };

/** One chip under a subagent answer. */
export interface ToolStepSummary {
  tool: string;
  ms: number;
}

/** Result of a local attempt — the UI treats {ok:false} as "use the server path", never as an error. */
export type HybridResult =
  | {
      ok: true;
      answer: string;
      sessionId: string | null;
      source: 'local';
      /** Absent for bundle mode (slice-1 shape); 'subagent' when on-device tool reads produced the answer. */
      mode?: 'subagent';
      /** Subagent mode only: which tools ran and how long each took. Never rows. */
      steps?: ToolStepSummary[];
    }
  | {
      ok: false;
      reason?: HandoffReason;
      /**
       * Subagent mode only: what the server agent should know about the
       * on-device work (bounded, untrusted-framed server-side; spec section 8).
       */
      handoff?: LocalHandoffV1;
      /**
       * Why the local model could not be used, when the local model itself
       * failed (load error, GPU lacks shader-f16, damaged cache, …). Absent
       * for ordinary hand-offs and for "no WebGPU" — those are expected and
       * not worth a notice. The UI shows it as a small, non-blocking note.
       */
      detail?: string;
    };

/** The small non-blocking note ChatTab renders when the local model was unavailable. */
export function localUnavailableNotice(detail: string | undefined | null, maxChars = 220): string | null {
  const text = detail?.trim();
  if (!text) return null;
  const clipped = text.length > maxChars ? `${text.slice(0, maxChars - 1).trimEnd()}…` : text;
  return `Local model unavailable: ${clipped}`;
}

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

const DATA_NOUN = '(?:data|information|info|details?|context|records?|results?)';
const MORE_ADJ = '(?:more|additional|further|extra|other|some|enough|sufficient|relevant)';

/** Strong "I cannot answer" paraphrases: a hit anywhere hands off (unless negated, see NEGATED_BEFORE). */
const STRONG_NEED_MORE: readonly RegExp[] = [
  // "(I) need(s/ed) (a bit) more data", "would need some additional details"
  new RegExp(`\\bneed(?:s|ed)?\\s+(?:a\\s+(?:bit|little|lot)\\s+)?(?:${MORE_ADJ}\\s+)+(?:(?:data|information|info|details?|context|records?)\\b|(?:data|information|info|details?|context)\\s+points?\\b)`),
  // "more data is needed / required / necessary"
  new RegExp(`\\b${MORE_ADJ}\\s+${DATA_NOUN}\\s+(?:is|are|will\\s+be|would\\s+be)\\s+(?:needed|required|necessary)\\b`),
  // "not enough data", "insufficient information", "inadequate context"
  new RegExp(`\\b(?:not\\s+enough|(?:is|are|was|were)n'?t\\s+enough|insufficient|inadequate)\\s+(?:of\\s+)?(?:the\\s+)?(?:data|information|info|details?|context)\\b`),
  // "the data is insufficient / missing / incomplete / unavailable / lacking"
  new RegExp(`\\b${DATA_NOUN}(?:\\s+(?:provided|available|given|shown))?\\s+(?:is|are|was|were)\\s+(?:insufficient|inadequate|missing|incomplete|unavailable|lacking|not\\s+(?:available|sufficient|enough|provided))\\b`),
  // "the results are missing the details needed"
  /\b(?:results?|data|lookups?)\s+(?:is|are)\s+missing\b/,
  // "no relevant / sufficient / such data"
  new RegExp(`\\bno\\s+(?:relevant|sufficient|enough|such|further|additional)\\s+(?:data|information|info|details?|context)\\b`),
  // "the results do not contain / include / show / specify / answer ..."
  new RegExp(
    `\\b${DATA_NOUN}(?:\\s+(?:provided|available|given))?\\s+(?:do(?:es)?\\s*n[o']?t|did\\s*n[o']?t|cannot|can't|can\\s+not)\\s+(?:contain|include|have|provide|show|specify|mention|say|answer|cover|indicate|tell|give)\\b`
  ),
  // "that information is not available", "data not available"
  new RegExp(`\\b${DATA_NOUN}\\s+(?:is\\s+|are\\s+)?not\\s+(?:available|provided|included)\\b`),
];

/** Weaker "cannot answer" paraphrases: anywhere when the reply has no figure, else only in its first sentence. */
const WEAK_CANNOT_ANSWER: readonly RegExp[] = [
  /\b(?:i\s+)?(?:can(?:'|no)t|cannot|can\s+not|couldn'?t|could\s+not|unable\s+to|am\s+unable\s+to|i'?m\s+unable\s+to|not\s+able\s+to)\s+(?:\w+\s+){0,3}?(?:answer|determine|tell|say|calculate|compute|find|provide|see|confirm|verify|conclude|judge|work\s+out)\b/,
  /\bnot\s+possible\s+to\s+(?:determine|tell|say|answer|calculate|know)\b/,
  /\bi\s+(?:do\s*n[o']?t|don't)\s+know\b/,
  /\bi'?m\s+not\s+(?:sure|certain)\b/,
  /\bunsure\b/,
  // ("no results found" is a negative claim, handled by the claim check, not a request for data)
  /\bno\s+(?:data|information|info|details?|context)\s+(?:is\s+|are\s+|was\s+|were\s+)?(?:available|provided|given)\b/,
];

/** A negation shortly before a strong match turns "need more data" into "you don't need more data". */
const NEGATED_BEFORE = /\b(?:don'?t|do\s+not|doesn'?t|does\s+not|didn'?t|did\s+not|won'?t|will\s+not|never|without|not|no|n't)\s+(?:\w+\s+){0,2}$/;

const FIGURE_IN_TEXT = /\$\s?\d|\d[\d,]*\.\d|\d+(?:\.\d+)?%|\b\d{1,3}(?:,\d{3})+\b/;

/** Lowercased, markdown stripped, `_`/`-` read as spaces, whitespace collapsed. */
function normaliseForPhrases(text: string): string {
  return text
    .toLowerCase()
    .replace(/[*`~]+/g, '')
    .replace(/[_]+/g, ' ')
    .replace(/(?<=[a-z])-(?=[a-z])/g, ' ')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function firstSentence(text: string): string {
  const m = /^.*?(?:[.!?](?=\s|$)|$)/.exec(text);
  return m ? m[0] : text;
}

/**
 * True when a reply is the model saying it cannot answer, whatever the wording:
 * the NEED_MORE_DATA sentinel (any case/spacing/markdown) or a paraphrase of it
 * ("I need more information", "not enough data", "the results don't include
 * that", "I can't determine that"). Conservative on real answers: a strong
 * phrase is ignored when negated ("you don't need more data"); the weaker
 * "can't / unable to" family only counts anywhere in a figure-free reply, or in
 * the first sentence of one that carries figures.
 */
export function looksLikeNeedMoreData(raw: string): boolean {
  const text = normaliseForPhrases(String(raw ?? ''));
  if (!text) return false;
  if (/\bneed more data\b/.test(text) && !/\b(?:not|no|never|without|n't)\s+(?:\w+\s+){0,2}need more data\b/.test(text)) return true;
  if (/^need more\W*$/.test(text) || /^i need more\W*$/.test(text)) return true;
  for (const re of STRONG_NEED_MORE) {
    const m = re.exec(text);
    if (!m) continue;
    // Only the need-verb pattern can be a negated statement ("you don't need more data").
    if (m[0].startsWith('need') && NEGATED_BEFORE.test(text.slice(Math.max(0, m.index - 30), m.index))) continue;
    return true;
  }
  const scope = FIGURE_IN_TEXT.test(text) ? firstSentence(text) : text;
  return WEAK_CANNOT_ANSWER.some((re) => re.test(scope));
}

// Tool-call marker detection. The tags are written as unicode escapes so they
// never appear literally in this file.
// Repo tool-call marker (the tagged form parseToolCall in src/model/tool-call-parse.ts accepts).
const TOOL_CALL_REPO = new RegExp('\x3ctool_call>[\\s\\S]*?\x3c/tool_call>');
// Qwen3's native tool-call form.
const TOOL_CALL_QWEN = new RegExp('\x3ctool_call>[\\s\\S]*?\x3ctool_response>');

/**
 * Decide whether local output is a usable answer or must hand off silently to
 * the server agent. Order matters and is pinned by tests: tool-call shapes
 * first, then the sentinel, then the fuzzy phrases, then empty output.
 */
export function classifyLocalOutput(raw: string): LocalVerdict {
  const text = stripThinking(raw);
  // Bare/fenced JSON calls (granite) share the server's balanced-brace scan, so
  // a call followed by invented text is still detected rather than shown raw.
  if (TOOL_CALL_REPO.test(text) || TOOL_CALL_QWEN.test(text) || looksLikeBareToolCall(text)) {
    return { kind: 'handoff', reason: 'tool-call' };
  }
  if (text.includes(NEED_MORE_SENTINEL)) {
    return { kind: 'handoff', reason: 'outside-bundle' };
  }
  const lower = text.toLowerCase();
  if (NEED_MORE_PHRASES.some((phrase) => lower.includes(phrase)) || looksLikeNeedMoreData(text)) {
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
export type ChatProvenance =
  | 'local-with-context' // bundle mode answered
  | 'local-tools' // subagent answered from on-device tool reads
  | 'server-continued' // subagent handed off WITH a payload; the server continued
  | 'server-fallback' // local layer present, server answered without a handoff payload
  | 'unavailable'; // hybrid layer absent / skipped

/** True when the answer was composed on-device (bundle or subagent), whatever its text says. */
export function isLocalProvenance(p: ChatProvenance | undefined): boolean {
  return p === 'local-with-context' || p === 'local-tools';
}

/**
 * True when a chat bubble must render links as plain text (label only, no href):
 * on-device answers (their text can carry attacker-controlled tool output) and
 * EVERY message reloaded from history, local or server (Round 3 "History links").
 * Only a live server answer in the current session keeps working links.
 */
export function linksRenderAsText(msg: { provenance?: ChatProvenance; fromHistory?: boolean }): boolean {
  return msg.fromHistory === true || isLocalProvenance(msg.provenance);
}

export const PROVENANCE_BADGES: Record<ChatProvenance, string> = {
  'local-with-context': 'answered locally · on-device',
  'local-tools': 'answered locally · on-device lookups',
  'server-continued': 'server · continued from on-device work',
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
  /** Which local mode answered; absent means bundle. */
  localMode?: 'bundle' | 'subagent';
  /**
   * The request to the server carried a handoff with at least one step, a
   * suggestedCall or a proposal (a priors-only handoff does not count).
   */
  handoffSent?: boolean;
}): ChatProvenance {
  if (outcome.localAnswered) return outcome.localMode === 'subagent' ? 'local-tools' : 'local-with-context';
  if (outcome.handoffSent) return 'server-continued';
  return outcome.hybridLayerPresent ? 'server-fallback' : 'unavailable';
}