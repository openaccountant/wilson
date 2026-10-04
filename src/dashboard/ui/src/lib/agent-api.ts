// Thin wrapper over api() for the agent-access surfaces: it adds this tab's session header (the server scopes
// grants and operations to it) and turns the server's `{ error: { message, hint } }` into text a person can read.
// No raw fetch here: auth, the mirror seam and error handling all stay in api().
import { api } from '@/api';
import {
  WILSON_AGENT_SESSION_HEADER,
  WILSON_AGENT_STATE_CHANGED_EVENT,
  WILSON_GRANTS_CHANGED_EVENT,
  WILSON_MCP_SESSION_KEY,
  openAgentChannel,
  postAgentStateChanged,
} from '@webmcp-session';

/** This tab's agent session id, the same one the in-page bridge uses (sessionStorage is per tab). */
export function agentSessionGeneration(): string {
  let id = sessionStorage.getItem(WILSON_MCP_SESSION_KEY);
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem(WILSON_MCP_SESSION_KEY, id);
  }
  return id;
}

/** `init` for `useApi`, so a GET carries the session header too. */
export function agentSessionInit(): RequestInit {
  return { headers: { [WILSON_AGENT_SESSION_HEADER]: agentSessionGeneration() } };
}

export function agentApi<T>(path: string, init?: RequestInit): Promise<T> {
  return api<T>(path, {
    ...init,
    headers: { ...(init?.headers as Record<string, string> | undefined), [WILSON_AGENT_SESSION_HEADER]: agentSessionGeneration() },
  });
}

/** `API 403: {"error":{"message":"...","hint":"..."}}` as the message alone. Anything else passes through. */
export function agentErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const brace = raw.indexOf('{');
  if (brace !== -1) {
    try {
      const body = JSON.parse(raw.slice(brace)) as { error?: string | { message?: string; hint?: string } };
      const error = body.error;
      if (typeof error === 'string') return error;
      if (error?.message) return error.hint ? `${error.message} (${error.hint})` : error.message;
    } catch {
      // Not JSON: fall through to the raw text.
    }
  }
  return raw;
}

/**
 * Something changed (a policy, the kill switch, a grant): tell the bridge panel in this tab (window events)
 * and the dashboard's other tabs (BroadcastChannel) to refetch `/api/mcp/state` now rather than at the next 5 s poll.
 */
export function announceAgentStateChanged(from: string): void {
  window.dispatchEvent(new CustomEvent(WILSON_AGENT_STATE_CHANGED_EVENT, { detail: { from } }));
  window.dispatchEvent(new CustomEvent(WILSON_GRANTS_CHANGED_EVENT, { detail: { from } }));
  postAgentStateChanged();
}

/** Subscribe to every way another surface can say "refetch": the two window events and the BroadcastChannel. Returns an unsubscribe. */
export function onAgentStateChanged(listener: () => void, ownName: string): () => void {
  const onEvent = (e: Event) => {
    if ((e as CustomEvent<{ from?: string }>).detail?.from !== ownName) listener();
  };
  window.addEventListener(WILSON_AGENT_STATE_CHANGED_EVENT, onEvent);
  window.addEventListener(WILSON_GRANTS_CHANGED_EVENT, onEvent);
  const channel = openAgentChannel(listener);
  return () => {
    window.removeEventListener(WILSON_AGENT_STATE_CHANGED_EVENT, onEvent);
    window.removeEventListener(WILSON_GRANTS_CHANGED_EVENT, onEvent);
    channel?.close();
  };
}
