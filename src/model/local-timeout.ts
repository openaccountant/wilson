/**
 * Explicit client-side timeout for local LLM calls (Ollama).
 *
 * Without one a local call has no client-side limit at all: neither Bun's
 * fetch nor the AI SDK cuts off a slow response (checked on Bun 1.4.2 with a
 * 330 s hold). The limit is long on purpose: local models on busy hardware
 * are slow, but a call must not hang forever either (#209).
 *
 * Override with OA_LOCAL_LLM_TIMEOUT_MS (milliseconds); 0 disables the limit.
 */
export const DEFAULT_LOCAL_LLM_TIMEOUT_MS = 15 * 60_000;

/**
 * A local attempt that fails after running this long is not retried, whatever
 * the error says: quick failures (model still loading, server just started)
 * are worth a retry, a request that tied up the server for minutes is not.
 */
export const LOCAL_NO_RETRY_AFTER_MS = 60_000;

export function getLocalLlmTimeoutMs(): number | undefined {
  const raw = process.env.OA_LOCAL_LLM_TIMEOUT_MS?.trim();
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return n === 0 ? undefined : n;
  }
  return DEFAULT_LOCAL_LLM_TIMEOUT_MS;
}

/** Thrown when our own timeout fires, so callers can tell it from a caller abort. */
export class LlmTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`LLM call timed out after ${Math.round(timeoutMs / 1000)}s`);
    this.name = 'LlmTimeoutError';
  }
}
