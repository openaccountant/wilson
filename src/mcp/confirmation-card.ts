/**
 * Pure content model for the WebMCP confirmation card — the single visible
 * confirmation surface for every mutating call (WebMCP tool call, HTTP-MCP
 * fallback, dashboard chat). Imports only the pure tool-names.ts, browser-safe: the in-page bridge
 * (src/dashboard/webmcp-bridge.ts) assembles DOM from this model, and the
 * root test-suite pins the content without a browser.
 *
 * The card always renders what the SERVER computed in `prepare` — the tool's
 * human label, who requested it, the summary line naming the exact change
 * (which transaction, from/to), and the structured before/after delta. It
 * never renders agent-provided prose: the summary is the server's own
 * prepareMutation output, persisted on the operation row.
 */

import { currentNameFor } from './tool-names.js';

export interface ConfirmationCardOperation {
  source: string;
  tool_name: string;
  /** `mutation` (default), `read` (policy Ask) or `proposal`. */
  kind?: string;
  summary?: string | null;
  /** The quoted bank description the server split out of the summary. */
  bank_data?: string | null;
  /** For a read-ask: the full arguments and, for transaction_search, what the server parsed the query into. */
  read?: { args: Record<string, unknown>; filter?: Array<{ label: string; value: string }> } | null;
  before_json?: string | null;
  after_json?: string | null;
  /** Derived on the server from who really raised the operation. Preferred over `source`. */
  requestedBy?: { kind: string; label: string } | null;
}

export interface ConfirmationCardDeltaRow {
  field: string;
  from: string;
  to: string;
}

/** The card's button timings: Approve enables after `enableAfterMs`, and must then be held for `holdMs`. */
export const CARD_HOLD_MS = 600;
export const CARD_ENABLE_AFTER_MS = 800;

export interface ConfirmationCardModel {
  /** e.g. "Categorize Transaction" — human label, falling back to the raw tool name. */
  title: string;
  /** What the card says at the top: "Confirm: Categorize Transaction" for a change, "Allow read: Transaction Search" for a read. */
  heading: string;
  variant: 'change' | 'read';
  /** `amber` marks a permission (a read), `default` a change. */
  tone: 'default' | 'amber';
  /** "Requested by: this tab". */
  requestedByLine: string;
  /** The transaction's description on its own row (quoted, sanitized, at most 64 characters), or null. */
  bankDataRow: string | null;
  /** A read's parsed filter as label/value rows (transaction_search only), or null. */
  filterRows: Array<{ label: string; value: string }> | null;
  /** A read's full canonical arguments as pretty JSON for a scrollable mono block. Never truncated. Null for a change. */
  argsBlock: string | null;
  holdMs: number;
  enableAfterMs: number;
  /** Who proposed the mutation: the server-derived label ("this tab", "another tab (…ab12)", "external MCP client", "dashboard chat"), else a label from `source`. */
  sourceLabel: string;
  /** Server-computed summary line, or null when prepare produced none (chat-shaped ops). */
  summary: string | null;
  /**
   * Field-level from/to rows. Null means prepare produced no structured delta
   * at all ("No structured delta available for this action."); an empty array
   * means a delta existed but changed no fields ("No fields changed.").
   */
  deltaRows: ConfirmationCardRowSet | null;
}

export interface ConfirmationCardRowSet {
  rows: ConfirmationCardDeltaRow[];
}

/** Human label per catalog tool, keyed by the CURRENT catalog name (specs/webmcp-tool-naming.md §2.1). */
const TOOL_LABELS: Record<string, string> = {
  categorize_transaction: 'Categorize Transaction',
  update_transaction: 'Update Transaction',
  set_tax_flag: 'Set Tax Flag',
  resolve_review_item: 'Resolve Review',
  set_budget: 'Set Budget',
  update_goal: 'Update Goal',
  // Reads raise a card only when their policy is Ask ("Allow read: ...").
  get_tax_summary: 'Tax Summary',
  search_transactions: 'Search Transactions',
  get_spending_summary: 'Spending Summary',
  get_profit_loss: 'Profit & Loss',
  get_net_worth: 'Net Worth',
  get_cash_forecast: 'Cash Forecast',
  list_transactions: 'List Transactions',
  fill_forecast_inputs: 'Fill Forecast Inputs',
  open_tab: 'Open Tab',
  get_page_context: 'Get Page Context',
  open_transaction: 'Open Transaction',
  list_review_items: 'List Review Items',
  open_review_item: 'Open Review Item',
  open_interaction: 'Open Interaction',
  // The judge: reads raise a card only under Ask; a proposal card says how many inert judgments it would add.
  list_interactions: 'List Interactions',
  get_interaction: 'Get Interaction',
  get_judge_rubric: 'Get Judge Rubric',
  propose_judgments: 'Propose Judgments',
  propose_judgment: 'Propose Judgment',
};

/**
 * Chat cards share `mcp_operations` with the chat tool's own name. Five of those names equal retired catalog
 * names, so chat cards keep reading exactly as they did before the rename. Other chat names fall back to the raw name.
 */
const CHAT_TOOL_LABELS: Record<string, string> = {
  edit_transaction: 'Edit Transaction',
  tax_flag: 'Tax Flag',
  transaction_search: 'Transaction Search',
  spending_summary: 'Spending Summary',
  profit_loss: 'Profit & Loss',
  net_worth: 'Net Worth',
};

/** The title for an operation. Chat rows only ever use CHAT_TOOL_LABELS; other rows resolve a retired name (history) first. */
function labelFor(source: string, toolName: string): string {
  if (source === 'chat') return CHAT_TOOL_LABELS[toolName] ?? toolName;
  const canonical = currentNameFor(toolName) ?? toolName;
  return TOOL_LABELS[canonical] ?? toolName;
}

/** One line of plain copy for how an operation ended. Shown on the card after the user acts. */
export function outcomeCopy(outcome: string): string {
  switch (outcome) {
    case 'committed':
      return 'Done. The change was applied.';
    case 'rejected':
      return 'Rejected. Nothing was changed.';
    case 'stale':
      return 'The data changed after this was requested, so nothing was applied.';
    case 'expired':
      return 'This request expired before it was approved. Nothing was changed.';
    case 'cancelled':
      return 'The agent withdrew this request. Nothing was changed.';
    case 'approval_too_fast':
      return 'That was too quick. Wait a moment so you can read the card, then approve again.';
    default:
      return 'Could not confirm what happened. Check your data before retrying.';
  }
}

/**
 * Control, bidi and zero-width characters (the same classes as `stripHiddenChars` in output.ts,
 * inlined because this module is browser-safe and imports nothing). `before` values are raw
 * bank/database text, so they are cleaned here: a stored U+202E must not make a delta row read
 * differently from what is stored.
 */
const HIDDEN_RE = /[\u0000-\u001F\u007F-\u009F\u00ad\u061c\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2069\ufeff]/g;

/** Same display rules as the bridge's original renderDelta, plus hidden-character stripping on every string. */
export function formatValue(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'object') return JSON.stringify(v).replace(HIDDEN_RE, '');
  return String(v).replace(HIDDEN_RE, '');
}

/** Same classes minus the line break, for text that is meant to span lines (pretty-printed arguments). */
const HIDDEN_KEEP_NEWLINE_RE = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F\u00ad\u061c\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2069\ufeff]/g;

const BANK_DATA_MAX = 64;

function bankDataRowFor(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const clean = raw.replace(HIDDEN_RE, '');
  if (clean.length === 0) return null;
  return clean.length <= BANK_DATA_MAX ? clean : `${clean.slice(0, BANK_DATA_MAX - 1)}…`;
}

/** 0 to 1: how much of the press-and-hold is done. Pure, so the hold fill and the tests agree. */
export function holdProgress(pressedAt: number, now: number, holdMs: number): number {
  if (holdMs <= 0) return 1;
  return Math.max(0, Math.min(1, (now - pressedAt) / holdMs));
}

function sourceLabelFor(source: string): string {
  if (source === 'chat') return 'dashboard chat';
  if (source === 'http-mcp') return 'external MCP client';
  return 'this page (WebMCP)';
}

export function confirmationCardModel(op: ConfirmationCardOperation): ConfirmationCardModel {
  const title = labelFor(op.source, op.tool_name);
  const isRead = op.kind === 'read';

  let deltaRows: ConfirmationCardRowSet | null = null;
  const before: unknown = op.before_json ? JSON.parse(op.before_json) : null;
  const after: unknown = op.after_json ? JSON.parse(op.after_json) : null;
  if (!isRead && !(before === null && after === null)) {
    // Same fallback rules as the bridge's renderDelta: a null side contributes no keys.
    const beforeObj = (before ?? {}) as Record<string, unknown>;
    const afterObj = (after ?? {}) as Record<string, unknown>;
    const keys = [...new Set([...Object.keys(beforeObj), ...Object.keys(afterObj)])];
    deltaRows = {
      rows: keys.map((key) => ({
        field: key,
        from: formatValue(beforeObj[key]),
        to: formatValue(afterObj[key]),
      })),
    };
  }

  const sourceLabel = op.requestedBy?.label ?? sourceLabelFor(op.source);
  const read = isRead ? op.read ?? null : null;

  return {
    title,
    heading: isRead ? `Allow read: ${title}` : `Confirm: ${title}`,
    variant: isRead ? 'read' : 'change',
    tone: isRead ? 'amber' : 'default',
    sourceLabel,
    requestedByLine: `Requested by: ${sourceLabel}`,
    summary: op.summary ?? null,
    bankDataRow: bankDataRowFor(op.bank_data),
    filterRows: read?.filter ? read.filter.map((r) => ({ label: formatValue(r.label), value: formatValue(r.value) })) : null,
    argsBlock: read ? JSON.stringify(read.args ?? {}, null, 2).replace(HIDDEN_KEEP_NEWLINE_RE, '') : null,
    deltaRows,
    holdMs: CARD_HOLD_MS,
    enableAfterMs: CARD_ENABLE_AFTER_MS,
  };
}

// ── Stack layout (judge K3) ──────────────────────────────────────────────────
//
// A card must not move while the pointer is on it. Two things used to move it: an older card below it being removed
// (the column is pinned to the bottom, so everything slid down), and a column taller than the viewport scrolling.
// These rules are pure; the floating bridge (src/dashboard/webmcp-bridge.ts) and the Settings list
// (PendingApprovalsList.tsx) only apply them to their own DOM.

/** The gap between two stacked cards in the floating column. */
export const CARD_COLUMN_GAP_PX = 8;

/** How many cards fit a column of `maxPx`, oldest first (the oldest are the ones kept on screen). At least one if any exist. */
export function fitCardCount(heightsOldestFirst: number[], maxPx: number, gapPx: number = CARD_COLUMN_GAP_PX): number {
  if (heightsOldestFirst.length === 0) return 0;
  let used = 0;
  let count = 0;
  for (const h of heightsOldestFirst) {
    const next = used + (count > 0 ? gapPx : 0) + h;
    if (count > 0 && next > maxPx) break;
    used = next;
    count += 1;
  }
  return count;
}

/** The line shown in place of cards that did not fit, or null when all of them did. */
export function morePendingLabel(hidden: number): string | null {
  return hidden > 0 ? `${hidden} more pending` : null;
}

/** The height to hold open where a card was removed: only while the pointer is over the stack, and only if it took room. */
export function placeholderPxFor(pointerOver: boolean, cardHeightPx: number): number | null {
  return pointerOver && Number.isFinite(cardHeightPx) && cardHeightPx > 0 ? cardHeightPx : null;
}

/** One slot in a stack of cards: a live card, or (placeholderPx set) the space a removed card left. */
export interface StackEntry {
  id: string;
  placeholderPx: number | null;
}

/**
 * Bring a rendered stack in line with the ids now pending. Slots keep their order. A card that is gone becomes a
 * fixed-height placeholder while the pointer is over the stack (so nothing below it moves), and is dropped otherwise.
 * A card that is new goes at the end.
 */
export function reconcileStack(prev: StackEntry[], pendingIds: string[], pointerOver: boolean, heightOf: (id: string) => number): StackEntry[] {
  const pending = new Set(pendingIds);
  const next: StackEntry[] = [];
  for (const entry of prev) {
    if (pending.has(entry.id)) {
      next.push({ id: entry.id, placeholderPx: null });
    } else if (pointerOver) {
      const px = entry.placeholderPx ?? placeholderPxFor(true, heightOf(entry.id));
      if (px !== null) next.push({ id: entry.id, placeholderPx: px });
    }
  }
  const known = new Set(prev.map((e) => e.id));
  for (const id of pendingIds) if (!known.has(id)) next.push({ id, placeholderPx: null });
  return next;
}

/** The pointer left the stack: every placeholder collapses. */
export function releasePlaceholders(entries: StackEntry[]): StackEntry[] {
  return entries.filter((e) => e.placeholderPx === null);
}
