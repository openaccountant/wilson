/**
 * In-page WebMCP bridge, bundled for the browser and served at
 * /webmcp-bridge.js (see buildWebMcpBridgeScript in server.ts). Injected
 * into the dashboard HTML unconditionally — it no-ops everywhere except
 * Chrome behind the WebMCP origin trial, and it never registers a single
 * tool until a human explicitly grants access from the panel this file
 * renders.
 *
 * This is the PRIMARY transport per issue #50's decision: it registers
 * real `document.modelContext.registerTool()` tools, same-origin, using
 * the dashboard's own fetch/auth — no network hop, no separate server.
 * The Streamable-HTTP `/mcp` fallback (src/mcp/http-server.ts) is a
 * completely separate code path for non-browser MCP clients; this file
 * has nothing to do with it.
 */

export {}; // makes this a module so `declare global` below is valid

interface ToolAnnotations {
  readOnlyHint: boolean;
  consequentialHint: boolean;
}

interface CatalogTool {
  name: string;
  description: string;
  classification: 'read' | 'mutating';
  inputSchema: unknown;
  annotations: ToolAnnotations;
}

interface Grant {
  id: string;
  tool_name: string;
  expires_at: string;
}

interface McpOperation {
  id: string;
  source: string;
  tool_name: string;
  before_json: string | null;
  after_json: string | null;
  status: string;
  outcome_json: string | null;
}

const AUTH_KEY = 'wilson_auth_token';
const SESSION_KEY = 'wilson_mcp_session_generation';
const POLL_INTERVAL_MS = 1500;
const PREPARE_POLL_TIMEOUT_MS = 5 * 60 * 1000;

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem(AUTH_KEY);
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...authHeaders(), ...(init?.headers as Record<string, string>) },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${res.status}: ${body}`);
  }
  return res.json() as Promise<T>;
}

/**
 * Fresh per browser tab: sessionStorage is never shared across tabs, even
 * same-origin ones, so two tabs naturally get independent grants without
 * any extra bookkeeping — this alone satisfies the "two tabs, different
 * grants" acceptance case.
 */
function getSessionGeneration(): string {
  let id = sessionStorage.getItem(SESSION_KEY);
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem(SESSION_KEY, id);
  }
  return id;
}

// ── Confirmation card ────────────────────────────────────────────────────────
//
// One rendering surface for every mutation confirmation, whatever proposed
// it (a WebMCP tool call, the HTTP-MCP fallback, or the dashboard chat's
// 'categorize' tool). Always renders the structured before/after delta the
// server computed in `prepare` — never the agent's own prose.

const shownOperations = new Set<string>();

function formatValue(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function renderDelta(container: HTMLElement, before: unknown, after: unknown): void {
  if (before === null && after === null) {
    container.textContent = 'No structured delta available for this action.';
    return;
  }
  const beforeObj = (before ?? {}) as Record<string, unknown>;
  const afterObj = (after ?? {}) as Record<string, unknown>;
  const keys = new Set([...Object.keys(beforeObj), ...Object.keys(afterObj)]);
  if (keys.size === 0) {
    container.textContent = 'No fields changed.';
    return;
  }
  const table = document.createElement('table');
  table.style.cssText = 'width:100%;border-collapse:collapse;font-size:12px;';
  for (const key of keys) {
    const row = table.insertRow();
    row.innerHTML = '';
    const th = document.createElement('td');
    th.textContent = key;
    th.style.cssText = 'padding:4px 8px 4px 0;color:#888;white-space:nowrap;';
    const from = document.createElement('td');
    from.textContent = formatValue(beforeObj[key]);
    from.style.cssText = 'padding:4px 8px;color:#c0392b;text-decoration:line-through;';
    const to = document.createElement('td');
    to.textContent = formatValue(afterObj[key]);
    to.style.cssText = 'padding:4px 0;color:#27ae60;font-weight:600;';
    row.append(th, from, to);
  }
  container.appendChild(table);
}

function showConfirmationCard(op: McpOperation, onResolved: () => void): void {
  if (shownOperations.has(op.id)) return;
  shownOperations.add(op.id);

  const overlay = document.createElement('div');
  overlay.style.cssText =
    'position:fixed;bottom:16px;right:16px;z-index:2147483647;width:340px;' +
    'background:#1c1c1e;color:#f2f2f2;border-radius:12px;padding:16px;' +
    'box-shadow:0 8px 24px rgba(0,0,0,.4);font-family:system-ui,sans-serif;';

  const title = document.createElement('div');
  title.textContent = `Confirm: ${op.tool_name}`;
  title.style.cssText = 'font-weight:700;font-size:14px;margin-bottom:4px;';

  const sourceLine = document.createElement('div');
  sourceLine.textContent = `Requested by: ${op.source === 'chat' ? 'dashboard chat' : op.source === 'http-mcp' ? 'external MCP client' : 'this page (WebMCP)'}`;
  sourceLine.style.cssText = 'font-size:11px;color:#999;margin-bottom:10px;';

  const deltaBox = document.createElement('div');
  deltaBox.style.cssText = 'margin-bottom:12px;';
  renderDelta(deltaBox, op.before_json ? JSON.parse(op.before_json) : null, op.after_json ? JSON.parse(op.after_json) : null);

  const buttons = document.createElement('div');
  buttons.style.cssText = 'display:flex;gap:8px;';

  const finish = async (action: 'approve' | 'reject') => {
    overlay.remove();
    shownOperations.delete(op.id);
    try {
      await api(`/api/mcp/operations/${op.id}/${action}`, { method: 'POST' });
    } finally {
      onResolved();
    }
  };

  const approveBtn = document.createElement('button');
  approveBtn.textContent = 'Approve';
  approveBtn.style.cssText = 'flex:1;padding:8px;border:none;border-radius:8px;background:#27ae60;color:#fff;font-weight:600;cursor:pointer;';
  approveBtn.onclick = () => void finish('approve');

  const rejectBtn = document.createElement('button');
  rejectBtn.textContent = 'Reject';
  rejectBtn.style.cssText = 'flex:1;padding:8px;border:none;border-radius:8px;background:#3a3a3c;color:#fff;font-weight:600;cursor:pointer;';
  rejectBtn.onclick = () => void finish('reject');

  buttons.append(approveBtn, rejectBtn);
  overlay.append(title, sourceLine, deltaBox, buttons);
  document.body.appendChild(overlay);
}

function startConfirmationPoller(): void {
  setInterval(async () => {
    let operations: McpOperation[];
    try {
      const res = await api<{ operations: McpOperation[] }>('/api/mcp/operations');
      operations = res.operations;
    } catch {
      return;
    }
    for (const op of operations) {
      showConfirmationCard(op, () => {});
    }
  }, POLL_INTERVAL_MS);
}

// ── WebMCP tool registration ─────────────────────────────────────────────────

async function pollOperationUntilResolved(id: string): Promise<McpOperation | null> {
  const deadline = Date.now() + PREPARE_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await api<{ operation: McpOperation }>(`/api/mcp/operations/${id}`);
      if (res.operation.status !== 'pending') return res.operation;
    } catch {
      // Transport hiccup mid-poll: keep polling — the row is durable server-side,
      // so we reconcile by operation id rather than assuming failure.
    }
    await new Promise((r) => setTimeout(r, 800));
  }
  return null;
}

async function executeReadTool(sessionGeneration: string, grantId: string, name: string, args: Record<string, unknown>): Promise<unknown> {
  const res = await api<{ data: unknown }>('/api/mcp/read', {
    method: 'POST',
    body: JSON.stringify({ sessionGeneration, grantId, tool: name, args }),
  });
  return res.data;
}

async function executeMutatingTool(sessionGeneration: string, grantId: string, name: string, args: Record<string, unknown>): Promise<unknown> {
  const prepared = await api<{ operation: McpOperation }>('/api/mcp/prepare', {
    method: 'POST',
    body: JSON.stringify({ sessionGeneration, grantId, tool: name, args }),
  });
  const resolved = await pollOperationUntilResolved(prepared.operation.id);
  if (!resolved) {
    return { outcome: 'unknown', operationId: prepared.operation.id, reason: 'No response within the approval window.' };
  }
  return {
    outcome: resolved.status,
    operationId: resolved.id,
    result: resolved.outcome_json ? JSON.parse(resolved.outcome_json) : undefined,
  };
}

// Matches the WICG WebMCP spec (webmachinelearning/webmcp index.bs) as of
// this writing: `execute` is a two-argument callback — `(inputObject,
// { signal })` — and `registerTool()` resolves `Promise<undefined>`, not a
// handle. Unregistration is exclusively via the AbortSignal passed in
// `options`; there is no `.remove()` or similar returned from registerTool.
interface ModelContextTool {
  name: string;
  description: string;
  inputSchema?: unknown;
  annotations?: ToolAnnotations;
  execute: (inputObject: Record<string, unknown>, options: { signal: AbortSignal }) => Promise<unknown>;
}

interface ModelContextRegisterToolOptions {
  exposedTo?: string[];
  signal?: AbortSignal;
}

interface ModelContext {
  registerTool(tool: ModelContextTool, options?: ModelContextRegisterToolOptions): Promise<undefined>;
}

declare global {
  interface Document {
    modelContext?: ModelContext;
  }
}

// One AbortController per currently-registered tool name — aborting it is
// the *only* spec-defined way to unregister (see the index.bs example under
// "tool execute steps": unregister via ac.abort(), then re-register fresh).
const registeredTools = new Map<string, AbortController>();

async function syncRegisteredTools(): Promise<void> {
  if (!document.modelContext) return; // No WebMCP support in this browser — nothing to do.

  const sessionGeneration = getSessionGeneration();
  let tools: CatalogTool[] & Array<{ grantId: string }>;
  try {
    const res = await api<{ tools: typeof tools }>(`/api/mcp/tools?sessionGeneration=${encodeURIComponent(sessionGeneration)}`);
    tools = res.tools;
  } catch {
    return;
  }

  const currentNames = new Set(tools.map((t) => t.name));
  for (const [name, controller] of registeredTools) {
    if (!currentNames.has(name)) {
      controller.abort();
      registeredTools.delete(name);
    }
  }

  for (const tool of tools) {
    if (registeredTools.has(tool.name)) continue;
    const controller = new AbortController();
    registeredTools.set(tool.name, controller);

    await document.modelContext.registerTool(
      {
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        // Native, spec-level signal for "this needs a confirmation" —
        // separate from, and in addition to, our own prepare/commit gate.
        annotations: tool.annotations,
        execute: async (args: Record<string, unknown>) => {
          // Reads execute immediately once granted; mutations always go
          // through prepare + a human confirmation before anything commits.
          const isRead = !['categorize_transaction', 'edit_transaction'].includes(tool.name) &&
            !(tool.name === 'tax_flag' && (args.action === 'flag' || args.action === 'unflag'));
          return isRead
            ? executeReadTool(sessionGeneration, tool.grantId, tool.name, args)
            : executeMutatingTool(sessionGeneration, tool.grantId, tool.name, args);
        },
      },
      { signal: controller.signal }
    ).catch(() => {
      // NotAllowedError (permissions policy) or similar — leave unregistered.
      registeredTools.delete(tool.name);
    });
  }
}

// ── Minimal grant-management panel ──────────────────────────────────────────
//
// No dependency on the React dashboard build: this is the actual UI a human
// uses to grant/revoke WebMCP tool access for the current tab, so the
// feature works even before anyone runs the Vite build.

function buildPanel(): void {
  const button = document.createElement('button');
  button.textContent = '🤖 Agent access';
  button.style.cssText =
    'position:fixed;bottom:16px;left:16px;z-index:2147483646;padding:8px 12px;border:none;' +
    'border-radius:20px;background:#2c2c2e;color:#fff;font-size:12px;cursor:pointer;font-family:system-ui,sans-serif;';

  const panel = document.createElement('div');
  panel.hidden = true;
  panel.style.cssText =
    'position:fixed;bottom:56px;left:16px;z-index:2147483646;width:300px;max-height:70vh;overflow:auto;' +
    'background:#1c1c1e;color:#f2f2f2;border-radius:12px;padding:14px;font-family:system-ui,sans-serif;font-size:12px;' +
    'box-shadow:0 8px 24px rgba(0,0,0,.4);';

  async function render(): Promise<void> {
    panel.innerHTML = '';
    const sessionGeneration = getSessionGeneration();

    const heading = document.createElement('div');
    heading.textContent = document.modelContext
      ? 'WebMCP tool access for this tab'
      : 'WebMCP is not available in this browser (Chrome origin trial only)';
    heading.style.cssText = 'font-weight:700;margin-bottom:10px;';
    panel.appendChild(heading);

    let catalog: CatalogTool[] = [];
    let grants: Grant[] = [];
    try {
      const [catalogRes, grantsRes] = await Promise.all([
        api<{ tools: CatalogTool[] }>('/api/mcp/catalog'),
        api<{ grants: Grant[] }>(`/api/mcp/grants?sessionGeneration=${encodeURIComponent(sessionGeneration)}`),
      ]);
      catalog = catalogRes.tools;
      grants = grantsRes.grants;
    } catch {
      panel.appendChild(document.createTextNode('Failed to load tool catalog.'));
      return;
    }

    const grantedNames = new Set(grants.map((g) => g.tool_name));
    const checkboxes: Record<string, HTMLInputElement> = {};

    for (const tool of catalog) {
      const row = document.createElement('label');
      row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:4px 0;';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = grantedNames.has(tool.name);
      checkboxes[tool.name] = checkbox;
      const label = document.createElement('span');
      label.textContent = `${tool.name}${tool.classification === 'mutating' ? ' (needs confirmation)' : ''}`;
      row.append(checkbox, label);
      panel.appendChild(row);
    }

    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:8px;margin-top:12px;';

    const applyBtn = document.createElement('button');
    applyBtn.textContent = 'Apply';
    applyBtn.style.cssText = 'flex:1;padding:6px;border:none;border-radius:8px;background:#0a84ff;color:#fff;cursor:pointer;';
    applyBtn.onclick = async () => {
      const toGrant = Object.entries(checkboxes).filter(([name, cb]) => cb.checked && !grantedNames.has(name)).map(([name]) => name);
      const toRevoke = grants.filter((g) => !checkboxes[g.tool_name]?.checked);
      if (toGrant.length > 0) {
        await api('/api/mcp/grants', { method: 'POST', body: JSON.stringify({ sessionGeneration, tools: toGrant }) }).catch(() => {});
      }
      for (const g of toRevoke) {
        await api(`/api/mcp/grants/${g.id}`, { method: 'DELETE' }).catch(() => {});
      }
      await syncRegisteredTools();
      await render();
    };

    const revokeAllBtn = document.createElement('button');
    revokeAllBtn.textContent = 'Revoke all';
    revokeAllBtn.style.cssText = 'flex:1;padding:6px;border:none;border-radius:8px;background:#3a3a3c;color:#fff;cursor:pointer;';
    revokeAllBtn.onclick = async () => {
      await api('/api/mcp/grants/revoke-session', { method: 'POST', body: JSON.stringify({ sessionGeneration }) }).catch(() => {});
      await syncRegisteredTools();
      await render();
    };

    actions.append(applyBtn, revokeAllBtn);
    panel.appendChild(actions);
  }

  button.onclick = () => {
    panel.hidden = !panel.hidden;
    if (!panel.hidden) void render();
  };

  document.body.append(button, panel);
}

function init(): void {
  buildPanel();
  startConfirmationPoller();
  void syncRegisteredTools();
  // Origin-trial support can register after this script runs, or a grant
  // change elsewhere (another tab, revoke) means the tool set can drift —
  // resync periodically rather than only once at load.
  setInterval(() => void syncRegisteredTools(), 10_000);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
