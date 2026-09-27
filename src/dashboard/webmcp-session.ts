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