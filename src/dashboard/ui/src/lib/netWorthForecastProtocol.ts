// ── Worker message contract for the net-worth Monte Carlo forecast ──────────
//
// Pure, dependency-free (only TYPE imports from netWorthForecast.ts) so the
// supersession logic — the whole reason a fast slider drag doesn't pile up
// stale 20,000-path runs — is unit-testable from root `bun test`, with no
// worker, no DOM, and no timing (see net-worth-forecast-protocol.test.ts).
//
// Browser-side wiring around this contract lives in netWorthForecast.worker.ts
// (runs it), netWorthForecastClient.ts (posts to it) and
// hooks/useNetWorthForecast.ts (drag/release escalation policy); none of
// those are imported here.

import type { NetWorthForecast, NetWorthSimInput } from './netWorthForecast.js';

export type ForecastQuality = 'draft' | 'final';

/** main → worker */
export type ForecastRequest =
  | { type: 'run'; runId: number; input: NetWorthSimInput; quality: ForecastQuality }
  | { type: 'cancel'; runId: number };

/** worker → main */
export type ForecastResponse =
  | { type: 'result'; runId: number; quality: ForecastQuality; forecast: NetWorthForecast | null; elapsedMs: number }
  | { type: 'progress'; runId: number; fraction: number }
  | { type: 'cancelled'; runId: number }
  | { type: 'error'; runId: number; message: string };

const DRAFT_PATHS = 5_000;
const FINAL_PATHS = 20_000;

/**
 * 'draft' (while dragging) -> 5,000 paths, 'final' (on release) -> 20,000.
 * The single source of the issue's "5,000 while dragging / 20,000 on
 * release" rule — pinned by test against netWorthForecast.ts's
 * DRAG_PATHS / RELEASE_PATHS so the two never drift apart.
 */
export function pathsFor(quality: ForecastQuality): number {
  return quality === 'draft' ? DRAFT_PATHS : FINAL_PATHS;
}

/**
 * A request is accepted only if it is strictly newer than what the worker is
 * already running or has already run. Late/duplicate posts are dropped,
 * which is what makes out-of-order delivery during a fast drag harmless.
 */
export function shouldStart(runId: number, activeRunId: number): boolean {
  return runId > activeRunId;
}

/** An in-flight run aborts at its next chunk boundary once a newer run arrives. */
export function shouldAbort(myRunId: number, activeRunId: number): boolean {
  return myRunId !== activeRunId;
}
