/**
 * Pure scheduling/filtering decisions for the in-page WebMCP bridge
 * (src/dashboard/webmcp-bridge.ts). Zero imports, browser-safe, so the root
 * test-suite can pin the cadence without a DOM.
 *
 * The bridge used to run two unconditional timers (1.5s operations poll,
 * 10s tool resync) on every page load. These functions decide whether a
 * timer should exist at all and how long to wait; the bridge owns the
 * setTimeout chain and kicks it on visibilitychange/focus/grant events.
 */

/** A bridge-prepared mutation is awaiting approval: keep the card responsive. */
export const CONFIRMATION_FAST_MS = 1500;
/** Live grants exist, so an agent may prepare something from another surface. */
export const CONFIRMATION_GRANTED_MS = 5000;
/** Nothing granted: only an external HTTP-MCP client could create a pending op. */
export const CONFIRMATION_IDLE_MS = 15_000;

/** Registered tools can outlive their grant (expiry/revoke elsewhere): slow re-check. */
export const TOOL_SYNC_LIVE_MS = 60_000;
/** Origin-trial support can attach after our script runs: a few early retries. */
export const TOOL_SYNC_LATE_REGISTRATION_MS = 2000;
export const TOOL_SYNC_LATE_ATTEMPTS = 5;

/**
 * Chat-sourced operations are approved by the React ChatTab's inline card
 * (usePendingChatApproval / ChatApprovalCard) — the bridge must not render a
 * second surface for them.
 */
export function bridgeOwnedOperations<T extends { source: string }>(ops: T[]): T[] {
  return ops.filter((op) => op.source !== 'chat');
}

export interface ConfirmationPollState {
  hidden: boolean;
  hasLiveGrants: boolean;
  /** This tab's WebMCP tool call is waiting on a prepared operation. */
  bridgePending: boolean;
  /** The previous poll returned at least one bridge-owned pending operation. */
  lastPollHadPending: boolean;
}

/** Delay until the next operations poll, or null to pause (resumed by a visibility/focus kick). */
export function nextConfirmationPollDelay(s: ConfirmationPollState): number | null {
  if (s.hidden) return null;
  if (s.bridgePending || s.lastPollHadPending) return CONFIRMATION_FAST_MS;
  return s.hasLiveGrants ? CONFIRMATION_GRANTED_MS : CONFIRMATION_IDLE_MS;
}

export interface ToolSyncState {
  hidden: boolean;
  webmcpAvailable: boolean;
  registeredCount: number;
  /** Consecutive timer-driven syncs that found no WebMCP. */
  lateAttempts: number;
}

/** Delay until the next timer-driven tool resync, or null for none (events still trigger one). */
export function nextToolSyncDelay(s: ToolSyncState): number | null {
  if (s.hidden) return null;
  if (!s.webmcpAvailable) {
    return s.lateAttempts < TOOL_SYNC_LATE_ATTEMPTS ? TOOL_SYNC_LATE_REGISTRATION_MS : null;
  }
  return s.registeredCount > 0 ? TOOL_SYNC_LIVE_MS : null;
}
