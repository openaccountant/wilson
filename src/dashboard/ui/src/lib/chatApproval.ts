/**
 * Pure helpers for the chat approval card. When the server chat agent calls a
 * tool gated behind approval (e.g. `categorize`), POST /api/chat blocks until
 * the pending operation is approved or rejected via /api/mcp/operations. These
 * helpers pick that operation out of the shared queue and render its args.
 */

/** The subset of the server's McpOperation (src/mcp/store.ts) the card reads. */
export interface ChatOperationLike {
  id: string;
  source: string;
  status: string;
  tool_name: string;
  args_json: string | null;
  summary?: string | null;
}

export const CHAT_APPROVAL_POLL_MS = 1500;
const MAX_VALUE_CHARS = 40;
const MAX_SUMMARY_CHARS = 160;

/**
 * The pending chat-originated operation, if any. Ignores ids the user already
 * answered (the server may keep returning one for a beat after the response).
 */
export function pickPendingChatOperation<T extends ChatOperationLike>(
  operations: readonly T[] | null | undefined,
  dismissed: ReadonlySet<string> = new Set(),
): T | null {
  if (!Array.isArray(operations)) return null;
  for (const op of operations) {
    if (op && op.source === 'chat' && op.status === 'pending' && !dismissed.has(op.id)) return op;
  }
  return null;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function formatValue(value: unknown): string {
  if (typeof value === 'string') return truncate(value, MAX_VALUE_CHARS);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    const allPrimitive = value.every((v) => ['string', 'number', 'boolean'].includes(typeof v));
    if (allPrimitive && value.length <= 3) return truncate(value.join(', '), MAX_VALUE_CHARS);
    return `${value.length} item${value.length === 1 ? '' : 's'}`;
  }
  try {
    return truncate(JSON.stringify(value), MAX_VALUE_CHARS);
  } catch {
    return '…';
  }
}

/**
 * Short human summary of a tool call's args, e.g. "limit: 5, category: Dining".
 * Empty string when there are no (non-null) args. Never throws.
 */
export function summarizeArgs(argsJson: string | null | undefined): string {
  if (!argsJson) return '';
  let parsed: unknown;
  try {
    parsed = JSON.parse(argsJson);
  } catch {
    return truncate(argsJson, MAX_SUMMARY_CHARS);
  }
  if (parsed === null || parsed === undefined) return '';
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    return truncate(formatValue(parsed), MAX_SUMMARY_CHARS);
  }
  const parts = Object.entries(parsed as Record<string, unknown>)
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => `${k}: ${formatValue(v)}`);
  return truncate(parts.join(', '), MAX_SUMMARY_CHARS);
}
