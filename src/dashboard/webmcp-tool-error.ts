/**
 * Tool errors as RESULTS, free of node and DOM imports (the in-page bridge bundles it with Bun.build, the React
 * dashboard through vite, root tests import it directly).
 *
 * Chrome 154 replaces any error thrown by a page or imperative tool handler with a generic
 * "UnknownError: Tool was executed but the invocation failed", so an agent would never read the actionable text
 * ("Transaction #9 not found", "The Settings tab is not available to agents", the current rubric version). Every
 * refusal and failure therefore comes back as a normal result `{ error: { code, message } }`. REST status codes
 * are unchanged: the status stays on the HTTP response, the bridge only decides what the agent is handed.
 *
 * An `AbortError` is the one thing that still rejects: the agent gave up, so there is nobody to tell.
 */

/** The longest message an error result carries, so `{ error }` never outgrows the 1,500-character answer cap. */
export const ERROR_MESSAGE_MAX = 600;

export interface ToolErrorBody {
  code: string;
  message: string;
  hint?: string;
  /** Only for `rubric_changed`: what the agent must judge by now. */
  currentRubricVersion?: string;
}

export interface ToolErrorResult {
  error: ToolErrorBody;
}

/** An Error that remembers the server's machine-readable code (and the one extra field an agent may need). */
export class ToolCallError extends Error {
  readonly code: string;
  readonly hint?: string;
  readonly currentRubricVersion?: string;

  constructor(code: string, message: string, extra: { hint?: string; currentRubricVersion?: string } = {}) {
    super(message);
    this.name = 'ToolCallError';
    this.code = code;
    if (extra.hint) this.hint = extra.hint;
    if (extra.currentRubricVersion) this.currentRubricVersion = extra.currentRubricVersion;
  }
}

function clip(text: string): string {
  return text.length > ERROR_MESSAGE_MAX ? `${text.slice(0, ERROR_MESSAGE_MAX - 1)}…` : text;
}

/**
 * The server's `{ error: { code, message, hint } }` as one `ToolCallError`. The message is the same one line the
 * bridge always produced (`message (hint)`), the code is the server's.
 */
export function toolErrorFromResponse(status: number, body: unknown): ToolCallError {
  const error = (body as { error?: unknown } | null | undefined)?.error;
  if (error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string') {
    const e = error as { code?: unknown; message: string; hint?: unknown; currentRubricVersion?: unknown };
    const hint = typeof e.hint === 'string' && e.hint !== '' ? e.hint : undefined;
    const code = typeof e.code === 'string' && e.code !== '' ? e.code : `http_${status}`;
    return new ToolCallError(code, hint ? `${e.message} (${hint})` : e.message, {
      currentRubricVersion: typeof e.currentRubricVersion === 'string' ? e.currentRubricVersion : undefined,
    });
  }
  if (typeof error === 'string') return new ToolCallError(`http_${status}`, error);
  return new ToolCallError(`http_${status}`, `Request failed with status ${status}`);
}

/** Any thrown value as the result an agent is handed. */
export function errorResult(err: unknown): ToolErrorResult {
  if (err instanceof ToolCallError) {
    return {
      error: {
        code: err.code,
        message: clip(err.message),
        ...(err.currentRubricVersion ? { currentRubricVersion: err.currentRubricVersion } : {}),
      },
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  const code = typeof (err as { code?: unknown } | null)?.code === 'string' ? (err as { code: string }).code : 'tool_failed';
  return { error: { code, message: clip(message) } };
}

/** Whether `value` is the `{ error: { code, message } }` shape. */
export function isErrorResult(value: unknown): value is ToolErrorResult {
  if (value === null || typeof value !== 'object') return false;
  const error = (value as { error?: unknown }).error;
  return !!error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string' && typeof (error as { message?: unknown }).message === 'string';
}

export function isAbortError(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { name?: unknown }).name === 'AbortError';
}

/** Run a tool body: its throw becomes a returned error result; an abort still rejects. */
export async function runToolSafely<T>(body: () => Promise<T> | T): Promise<T | ToolErrorResult> {
  try {
    return await body();
  } catch (err) {
    if (isAbortError(err)) throw err;
    return errorResult(err);
  }
}
