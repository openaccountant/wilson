// ── Offline fetch seam helpers ───────────────────────────────────────────────
//
// Pure decision logic for the single fetch seam (src/dashboard/ui/src/api.ts):
// GETs fall back to the read-only mirror on connection-level failures; writes
// never touch the mirror — they surface an explicit requires-connection state.
// HTTP errors (401/403/404/5xx) mean the server ANSWERED, so they never trigger
// fallback and never claim "requires connection".

/** Thrown when a write cannot reach the server. Never thrown for HTTP errors. */
export class RequiresConnectionError extends Error {
  constructor(message = 'This action requires a connection to the Wilson server.') {
    super(message);
    this.name = 'RequiresConnectionError';
  }
}

/**
 * True for connection-level failures only — what fetch throws when the server
 * is unreachable (Chrome: "Failed to fetch", bun/node: "fetch failed",
 * Safari: "Load failed"). HTTP status errors are NOT network errors.
 */
export function isNetworkError(err: unknown): boolean {
  if (err instanceof TypeError) return true;
  const name = (err as { name?: unknown } | null)?.name;
  if (name === 'NetworkError') return true;
  const message = err instanceof Error ? err.message : String(err);
  return /failed to fetch|fetch failed|load failed|network error|network request failed/i.test(message);
}

export type WriteFailureKind = 'requires-connection' | 'failed';

/**
 * Classify a failed entity-assignment (or any write) for the transactions tab:
 * unreachable server → "requires connection"; anything the server rejected
 * (401/403/400/500) or a client bug → plain "failed".
 */
export function classifyWriteError(err: unknown): WriteFailureKind {
  if (err instanceof RequiresConnectionError || isNetworkError(err)) {
    return 'requires-connection';
  }
  return 'failed';
}

export type FetchOutcome = 'return-mirror' | 'throw-requires-connection' | 'rethrow';

export interface FetchOutcomeInput {
  /** True for non-GET requests (only GETs are ever served from the mirror). */
  isWrite: boolean;
  /** True when the fetch failed at the connection level. */
  networkError: boolean;
  /** Result of tryMirror(path): rows, or null when the mirror cannot serve. */
  mirrored: unknown | null;
}

/**
 * Decide what the fetch seam does after a failed fetch. Writes always require a
 * connection (the mirror is read-only); reads return the mirror's rows only
 * when the mirror actually has an answer for that path.
 */
export function resolveFetchOutcome({
  isWrite,
  networkError,
  mirrored,
}: FetchOutcomeInput): FetchOutcome {
  if (!networkError) return 'rethrow';
  if (isWrite) return 'throw-requires-connection';
  if (mirrored !== null) return 'return-mirror';
  return 'rethrow';
}