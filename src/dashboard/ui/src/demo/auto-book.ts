/**
 * Pure decision layer for the Demo tab's auto-book beat (issue #94) — no
 * React, no DOM, no fetch. The AgentTraceSection drives all network calls;
 * this module owns the grant lookup, candidate-choice rule, outcome→phase
 * mapping, and the exact honest copy strings the section renders (pinned by
 * the root test suite so the deny path always *says so*).
 *
 * Non-negotiables carried verbatim from spec-50:
 * 1. Every mutating call requires explicit visible confirmation — no silent
 *    autonomous writes. There is no "don't ask again": 'always' lives in the
 *    Agent access panel, and every prepared operation still waits for a card.
 * 2. Before granting, the attendee can see exactly which tools the agent
 *    session has access to, and revoke at any time.
 * 3. Default state is zero tools exposed — the attendee opts in.
 */

/** The one mutating tool auto-book uses — the catalog's existing categorize_transaction. */
export const AUTOBOOK_TOOL = 'categorize_transaction';

export const AUTOBOOK_CONFIRM_WINDOW_MS = 5 * 60 * 1000; // mirrors OPERATION_TTL_MS
export const AUTOBOOK_POLL_INTERVAL_MS = 800; // mirrors the bridge's per-op poll

export interface ExposedToolLike {
  name: string;
  grantId: string;
}

/** The grantId for the auto-book tool in this tab's exposed set, or null (zero tools / not granted). */
export function pickGrant(tools: ExposedToolLike[]): string | null {
  return tools.find((t) => t.name === AUTOBOOK_TOOL)?.grantId ?? null;
}

export interface AutoBookCandidateLike {
  id: number;
  date: string;
  description: string;
  amount: number;
  category: string | null;
}

/** More than one row matches the predicted description → the attendee picks one first. */
export function requiresChoice(candidates: AutoBookCandidateLike[]): boolean {
  return candidates.length > 1;
}

export type AutoBookPhase =
  | 'pending' // not requested
  | 'needs-grant' // zero tools exposed, or the server rejected the grant
  | 'choose' // multiple candidate rows — attendee picks one
  | 'awaiting' // pending operation exists; the confirmation card is the only approval surface
  | 'booked' // committed
  | 'denied' // rejected
  | 'stale' // row or grant moved between prepare and approve
  | 'error';

/**
 * Map an operation's durable status onto the node's phase.
 */
export function phaseFor(
  op: { status: string }
): Exclude<AutoBookPhase, 'pending' | 'needs-grant' | 'choose'> {
  switch (op.status) {
    case 'pending':
      return 'awaiting';
    case 'committed':
      return 'booked';
    case 'rejected':
      return 'denied';
    case 'stale':
      return 'stale';
    default:
      // 'expired' and anything unexpected: nothing was written either way —
      // the section renders the honest copy for it.
      return 'error';
  }
}

/** The exact status copy strings — honest about what did and did not change. */
export const AUTOBOOK_COPY = {
  pending: 'not requested — tap "Auto-book this" above',
  needsGrant: 'zero tools exposed — grant categorize_transaction to this tab\'s agent session',
  needsGrantAfterReject: 'the agent session lost access to categorize_transaction — grant it again to retry',
  awaiting: 'confirmation card open — approve or deny there',
  stillAwaiting: 'still awaiting your decision on the confirmation card',
  booked: 'booked — category written',
  denied: 'denied — nothing changed',
  stale: 'the row changed since you saw it — nothing was written',
  noCandidates: 'no imported transaction matches this description — nothing was prepared',
  noImportedRows: 'this run imported no rows (the statement was already imported) — drop it fresh to auto-book',
  expired: 'the confirmation window elapsed with no decision — nothing was written',
  error: 'something went wrong — nothing was written',
} as const;

export type AutoBookCopyKey = keyof typeof AUTOBOOK_COPY;

/** Copy key for a settled phase (the section composes the booked line with the change summary). */
export function copyFor(phase: Exclude<AutoBookPhase, 'pending' | 'needs-grant' | 'choose'>): AutoBookCopyKey {
  switch (phase) {
    case 'awaiting':
      return 'awaiting';
    case 'booked':
      return 'booked';
    case 'denied':
      return 'denied';
    case 'stale':
      return 'stale';
    case 'error':
      return 'error';
  }
}