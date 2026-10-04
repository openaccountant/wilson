/**
 * Shared browser-side constants for the WebMCP gate — deliberately the only
 * file both the in-page bridge (src/dashboard/webmcp-bridge.ts) and the React
 * dashboard build (via the @webmcp-session alias) import, so the sessionStorage
 * key and the panel-open event name can never drift between the two bundles.
 * Zero imports; safe to bundle for the browser and to import from root tests.
 */

/** Per-tab agent-session key: sessionStorage is never shared across tabs, so two tabs get independent grants. */
export const WILSON_MCP_SESSION_KEY = 'wilson_mcp_session_generation';

/** CustomEvent the React UI dispatches to ask the bridge to open its Agent access (grant) panel. */
export const WILSON_OPEN_AGENT_PANEL_EVENT = 'wilson:open-agent-panel';
/** Window event either grant surface (bridge panel, Settings → Agent access) fires after changing this tab's grants, so the other resyncs immediately. */
export const WILSON_GRANTS_CHANGED_EVENT = 'wilson:agent-grants-changed';

/** Window event fired when the kill switch, a policy or the grant TTL changes, so every surface in this tab refetches `/api/mcp/state`. */
export const WILSON_AGENT_STATE_CHANGED_EVENT = 'wilson:agent-state-changed';
/** BroadcastChannel that carries the same news to the dashboard's other tabs (kill switch and policy changes). */
export const WILSON_AGENT_CHANNEL = 'wilson-agent-access';

/** The slice of `BroadcastChannel` the dashboard uses, so a test can stand in a fake one. */
export interface AgentChannel {
  postMessage(message: unknown): void;
  close(): void;
  onmessage: ((event: unknown) => void) | null;
}
export type AgentChannelCtor = new (name: string) => AgentChannel;

function defaultChannelCtor(): AgentChannelCtor | undefined {
  return (globalThis as { BroadcastChannel?: AgentChannelCtor }).BroadcastChannel;
}

/**
 * Open the agent-state channel and call `onChange` for every message another tab posts on it (a kill-switch, policy
 * or grant change). Returns the channel (the caller may post on it and must `close()` it) or null where
 * `BroadcastChannel` is missing or blocked. Used by the bridge and by the React UI, so both resync the same way.
 */
export function openAgentChannel(onChange: () => void, Ctor: AgentChannelCtor | undefined = defaultChannelCtor()): AgentChannel | null {
  if (!Ctor) return null;
  try {
    const channel = new Ctor(WILSON_AGENT_CHANNEL);
    channel.onmessage = () => onChange();
    return channel;
  } catch {
    return null;
  }
}

/** Tell the dashboard's other tabs that agent state changed, over a short-lived channel. Never throws. */
export function postAgentStateChanged(Ctor: AgentChannelCtor | undefined = defaultChannelCtor()): void {
  if (!Ctor) return;
  try {
    const channel = new Ctor(WILSON_AGENT_CHANNEL);
    channel.postMessage({ type: 'state-changed' });
    channel.close();
  } catch {
    // A blocked channel is not worth failing a click for.
  }
}

/** Header carrying the tab's session generation. Mirrors `SESSION_HEADER` in src/mcp/schemas.ts. */
export const WILSON_AGENT_SESSION_HEADER = 'X-Wilson-Agent-Session';

/**
 * The dashboard's tabs, in tab-bar order. The one list: the tab bar, the app's hash router and the server's
 * tab-scoped tool surfaces (`surface: { tab }` in the tool catalog) all read it. A test fails if a source
 * grows its own copy.
 */
export const TAB_IDS = ['overview', 'transactions', 'review', 'accounts', 'goals', 'forecast', 'chat', 'llm', 'logs', 'settings'] as const;
export type TabId = (typeof TAB_IDS)[number];

/**
 * The tabs an agent may open with `navigate_to_tab`. Not `settings`: that is the Agent Access Center (grants,
 * policies, the kill switch, client tokens, pending approvals), and no agent task needs its own control surface on
 * screen (least privilege). The user opens it themselves.
 */
export const AGENT_TAB_IDS = TAB_IDS.filter((t): t is Exclude<TabId, 'settings'> => t !== 'settings');
