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

import {
  CARD_COLUMN_GAP_PX,
  CARD_HOLD_MS,
  confirmationCardModel,
  fitCardCount,
  holdProgress,
  morePendingLabel,
  outcomeCopy,
  placeholderPxFor,
} from '../mcp/confirmation-card.js';
import {
  WILSON_MCP_SESSION_KEY,
  WILSON_OPEN_AGENT_PANEL_EVENT,
  WILSON_GRANTS_CHANGED_EVENT,
  WILSON_AGENT_STATE_CHANGED_EVENT,
  openAgentChannel,
  type AgentChannel,
} from './webmcp-session.js';
import {
  SESSION_HEADER,
  callServerTool,
  callServerToolAnswer,
  createOperationLedger,
  createReconcileScheduler,
  endChromeCall,
  executePageTool,
  executeServerTool,
  liveToolsSignature,
  registerLiveTools,
  type AgentCall,
  type ChromeCallEnd,
  type LiveToolDescriptor,
} from './webmcp-bridge-core.js';
import { getPageRegistry } from './webmcp-page-registry.js';
import { bridgeOwnedOperations, nextConfirmationPollDelay, nextToolSyncDelay } from './webmcp-polling.js';
import { THEME } from './webmcp-theme.js';
import {
  buildToolRows,
  formatAuditRow,
  statusDot,
  withPendingOperations,
  type AgentPendingOperation,
  type AgentState,
} from './agent-access-model.js';
import { ToolCallError } from './webmcp-tool-error.js';

export {}; // makes this a module so `declare global` below is valid

interface ToolAnnotations {
  readOnlyHint: boolean;
  consequentialHint: boolean;
  untrustedContentHint: boolean;
}

/** One pending card: the server's operation view (src/mcp/operation-view.ts). */
type McpOperation = AgentPendingOperation & { outcome_json?: string | null };

const AUTH_KEY = 'wilson_auth_token';
const SESSION_KEY = WILSON_MCP_SESSION_KEY;
const OPEN_PANEL_EVENT = WILSON_OPEN_AGENT_PANEL_EVENT;
const GRANTS_CHANGED_EVENT = WILSON_GRANTS_CHANGED_EVENT;
const STATE_CHANGED_EVENT = WILSON_AGENT_STATE_CHANGED_EVENT;
/**
 * Cadence. The only periodic driver is the tool-resync timer (scheduleToolSync, decided by nextToolSyncDelay in
 * webmcp-polling.ts): no timer while the tab is hidden, at most 5 retries 2 s apart in a browser without WebMCP, and a
 * 60 s re-check only while tools are live. Everything a person can see change is event-driven and immediate (visibility,
 * focus, the agent BroadcastChannel, `toolchange`, grant/panel events, and any grant/revoke/policy/kill-switch action
 * from this tab). The confirmation poll backs off on its own (nextConfirmationPollDelay): 1.5 s while a call of this
 * tab waits on a card or a card is showing, slower otherwise, none while the tab is hidden.
 *
 * The slow background cadence is safe because the kill switch and every policy are enforced by the server on each
 * call (/api/mcp/call re-checks them), not by what this tab has registered: a tool a stale tab still shows cannot
 * run once access is off or its policy is Off. The timer only tidies the registration up.
 */

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem(AUTH_KEY);
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** Every request names this tab by header (never in the URL), so the server can scope grants and operations to it. */
async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(),
      [SESSION_HEADER]: getSessionGeneration(),
      ...(init?.headers as Record<string, string>),
    },
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

// ── Forensic Noir, in constants ──────────────────────────────────────────────
//
// The bridge is vanilla DOM (no Tailwind), so it carries the dashboard's tokens
// itself (webmcp-theme.ts, pinned to app.css by a test). Green is for action and
// value, amber for permissions, red for danger only; square-ish, no emoji. Every
// string from the server goes in through `textContent`.

const T = THEME;
const FONT = `font-family:${T.sans};font-size:12px;line-height:1.4;color:${T.text};`;
const MONO = `font-family:${T.mono};`;

function el(tag: string, css: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.style.cssText = css;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label: string, tone: 'green' | 'red' | 'plain', onClick: () => void): HTMLButtonElement {
  const color = tone === 'green' ? T.green : tone === 'red' ? T.red : T.muted;
  const b = el(
    'button',
    `padding:6px 10px;border:1px solid ${tone === 'plain' ? T.border : color};border-radius:${T.radius};` +
      `background:${tone === 'plain' ? 'transparent' : `${color}26`};color:${tone === 'plain' ? T.text : color};` +
      `font:600 11px ${T.sans};cursor:pointer;`,
    label,
  ) as HTMLButtonElement;
  b.onclick = onClick;
  return b;
}

function setDisabled(b: HTMLButtonElement, disabled: boolean): void {
  b.disabled = disabled;
  b.style.opacity = disabled ? '0.45' : '1';
  b.style.cursor = disabled ? 'default' : 'pointer';
}

function localTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString();
}

const CHIP_COLOR = { green: T.green, red: T.red, amber: T.amber, muted: T.muted } as const;

// ── Shared state ─────────────────────────────────────────────────────────────
//
// One snapshot from `GET /api/mcp/state`, the same one Settings -> Agent access
// renders, refreshed by the sync scheduler below and at once when either
// surface (or another tab, over the BroadcastChannel) changes something. The
// server is the source of truth: this file never decides what is allowed.

let agentState: AgentState | null = null;
let onStateChange: (() => void) | null = null;
let channel: AgentChannel | null = null;

async function refreshState(): Promise<void> {
  try {
    agentState = await api<AgentState>('/api/mcp/state');
  } catch {
    return; // keep the last good snapshot; the next sync tries again
  }
  onStateChange?.();
}

/** Tell the Settings surface and the other tabs that something changed, so they refetch now rather than on their next scheduled sync. */
function announceStateChanged(): void {
  window.dispatchEvent(new CustomEvent(STATE_CHANGED_EVENT, { detail: { from: 'bridge' } }));
  window.dispatchEvent(new CustomEvent(GRANTS_CHANGED_EVENT, { detail: { from: 'bridge' } }));
  try {
    channel?.postMessage({ type: 'state-changed' });
  } catch {
    // A closed channel is not worth failing a click for.
  }
}

function tabIsVisible(): boolean {
  return typeof document.visibilityState === 'undefined' || document.visibilityState === 'visible';
}

// ── Confirmation card ────────────────────────────────────────────────────────
//
// One rendering surface for every confirmation, whatever raised it (a WebMCP tool
// call, the /mcp fallback). Chat-raised operations are answered by the Chat tab's
// inline card instead (one approval surface per operation). A change shows the
// structured before/after the server computed in `prepare`; a read the user set to
// Ask shows what will run. Never the agent's own prose. The content itself comes
// from the pure model in src/mcp/confirmation-card.ts; this file assembles DOM.
//
// Hardening (threat T16): Approve enables after 800 ms, only reacts to a trusted
// (real) pointer or key event, and must be HELD for 600 ms with a visible fill.
// The server refuses an approval younger than 1 s on its own.

interface CardHandle {
  node: HTMLElement;
  /** True while the user is in the middle of answering, so the sweep does not pull the card away. */
  busy: boolean;
}

const cards = new Map<string, CardHandle>();
/** Cards the user dismissed with the close button; the pending list in the panel brings one back. */
const dismissed = new Set<string>();
let cardHost: HTMLElement | null = null;

/** Marks the fixed-height space a removed card left while the pointer was over the column. */
const PLACEHOLDER_ATTR = 'data-card-placeholder';
const MORE_NOTE_ATTR = 'data-card-more';
/** Room reserved above the cards for the "N more pending" line. */
const MORE_NOTE_RESERVE_PX = 28;
/** Last pointer type seen over the column: touch leaves :hover stuck and may never fire pointerleave. */
let lastPointerType = 'mouse';

function getCardHost(): HTMLElement {
  if (!cardHost) {
    // No scrolling: a column that scrolls moves the card under the pointer. It caps instead (`layoutCards`).
    const host = el('div', 'position:fixed;bottom:16px;right:16px;z-index:2147483647;display:flex;flex-direction:column;gap:8px;max-height:90vh;overflow:hidden;');
    // The pointer left: the space held open for removed cards collapses and the column settles.
    host.addEventListener('pointerover', (e) => { lastPointerType = e.pointerType || 'mouse'; });
    host.addEventListener('pointerleave', () => {
      for (const ph of host.querySelectorAll(`[${PLACEHOLDER_ATTR}]`)) ph.remove();
      layoutCards();
    });
    cardHost = host;
    document.body.appendChild(host);
    window.addEventListener('resize', layoutCards);
  }
  return cardHost;
}

/**
 * Remove a card from the column. While the pointer is over the column the card's space is held open by a
 * fixed-height placeholder, so the cards below (and above) it do not slide under the cursor; it collapses on pointerleave.
 */
function removeCardNode(node: HTMLElement): void {
  const host = cardHost;
  if (host && node.parentElement === host) {
    const px = placeholderPxFor(lastPointerType !== 'touch' && host.matches(':hover'), node.offsetHeight);
    if (px !== null) {
      const ph = el('div', `flex:none;width:340px;height:${px}px;`);
      ph.setAttribute(PLACEHOLDER_ATTR, '1');
      ph.setAttribute('aria-hidden', 'true');
      host.replaceChild(ph, node);
    } else {
      host.removeChild(node);
    }
  } else {
    node.parentElement?.removeChild(node);
  }
  layoutCards();
}

/**
 * Cap the column at the viewport instead of letting it scroll: the oldest cards (the ones being read, at the bottom)
 * stay, newer ones that do not fit are hidden, and a "N more pending" line says so. They appear as room frees up.
 */
function layoutCards(): void {
  const host = cardHost;
  if (!host) return;
  const nodes = [...host.children].filter((c): c is HTMLElement => c instanceof HTMLElement && c.hasAttribute('data-card-id'));
  const placeholders = [...host.children].filter((c): c is HTMLElement => c instanceof HTMLElement && c.hasAttribute(PLACEHOLDER_ATTR));
  for (const n of nodes) n.style.display = '';
  let note = host.querySelector<HTMLElement>(`[${MORE_NOTE_ATTR}]`);
  if (nodes.length === 0) {
    note?.remove();
    return;
  }
  const held = placeholders.reduce((sum, p) => sum + p.offsetHeight + CARD_COLUMN_GAP_PX, 0);
  const maxPx = window.innerHeight * 0.9 - MORE_NOTE_RESERVE_PX - held;
  const oldestFirst = [...nodes].reverse();
  const fit = fitCardCount(oldestFirst.map((n) => n.offsetHeight), maxPx, CARD_COLUMN_GAP_PX);
  oldestFirst.slice(fit).forEach((n) => { n.style.display = 'none'; });
  const label = morePendingLabel(nodes.length - fit);
  if (label === null) {
    note?.remove();
    return;
  }
  if (!note) {
    note = el('div', `${FONT}font-size:12px;color:${T.muted};text-align:right;padding:2px 4px;flex:none;`);
    note.setAttribute(MORE_NOTE_ATTR, '1');
  }
  note.textContent = label;
  if (host.firstElementChild !== note) host.prepend(note);
}

function renderDelta(container: HTMLElement, model: ReturnType<typeof confirmationCardModel>): void {
  if (model.deltaRows === null) {
    container.textContent = 'No structured delta available for this action.';
    container.style.color = T.muted;
    return;
  }
  if (model.deltaRows.rows.length === 0) {
    container.textContent = 'No fields changed.';
    container.style.color = T.muted;
    return;
  }
  const table = document.createElement('table');
  table.style.cssText = 'width:100%;border-collapse:collapse;';
  for (const row of model.deltaRows.rows) {
    const tr = table.insertRow();
    const field = document.createElement('td');
    field.textContent = row.field;
    field.style.cssText = `padding:3px 8px 3px 0;color:${T.muted};white-space:nowrap;vertical-align:top;`;
    const from = document.createElement('td');
    from.textContent = row.from;
    from.style.cssText = `padding:3px 8px;color:${T.red};text-decoration:line-through;${MONO}word-break:break-word;`;
    const to = document.createElement('td');
    to.textContent = row.to;
    to.style.cssText = `padding:3px 0;color:${T.green};font-weight:600;${MONO}word-break:break-word;`;
    tr.append(field, from, to);
  }
  container.appendChild(table);
}

function renderRead(container: HTMLElement, model: ReturnType<typeof confirmationCardModel>): void {
  container.append(el('div', `color:${T.muted};margin-bottom:6px;`, 'This agent wants to read data from Wilson. It runs only if you allow it.'));
  if (model.filterRows && model.filterRows.length > 0) {
    container.append(el('div', `color:${T.muted};font-size:11px;margin-bottom:4px;`, 'Wilson understood the query as'));
    for (const row of model.filterRows) {
      const line = el('div', 'display:flex;gap:8px;padding:2px 0;');
      line.append(el('span', `color:${T.muted};min-width:96px;`, row.label), el('span', `${MONO}color:${T.text};word-break:break-word;`, row.value));
      container.append(line);
    }
  }
  if (model.argsBlock !== null) {
    container.append(el('div', `color:${T.muted};font-size:11px;margin:6px 0 4px;`, 'Full request'));
    container.append(
      el('pre', `${MONO}font-size:11px;margin:0;padding:8px;background:${T.surface};border:1px solid ${T.border};border-radius:4px;max-height:120px;overflow:auto;white-space:pre-wrap;word-break:break-word;`, model.argsBlock),
    );
  }
}

function showConfirmationCard(op: McpOperation, onResolved: () => void): void {
  if (cards.has(op.id)) return;
  dismissed.delete(op.id);

  const model = confirmationCardModel(op);
  const readCard = model.variant === 'read';
  const accent = readCard ? T.amber : T.green;

  const node = el('div', `${FONT}width:340px;box-sizing:border-box;background:${T.bg};border:1px solid ${readCard ? T.amber : T.border};border-radius:${T.radius};padding:14px;box-shadow:0 8px 24px rgba(0,0,0,.5);flex:none;max-height:calc(90vh - ${MORE_NOTE_RESERVE_PX}px);overflow-y:auto;`);
  // A card taller than the column scrolls inside itself, so its buttons stay reachable without moving other cards.
  node.setAttribute('data-card-id', op.id);
  const handle: CardHandle = { node, busy: false };
  cards.set(op.id, handle);

  const top = el('div', 'display:flex;justify-content:space-between;align-items:flex-start;gap:8px;margin-bottom:4px;');
  top.append(el('div', `font-weight:700;font-size:13px;color:${readCard ? T.amber : T.text};`, model.heading));
  const close = el('button', `background:transparent;border:none;color:${T.muted};cursor:pointer;font-size:16px;line-height:1;padding:0 2px;`, '×');
  close.onclick = () => {
    dismissed.add(op.id);
    cards.delete(op.id);
    removeCardNode(node);
  };
  top.append(close);

  const requested = el('div', `font-size:11px;color:${T.muted};margin-bottom:8px;`, model.requestedByLine);

  // The server-computed summary names the exact change in the server's own words. Bank text is NOT in it: it sits on
  // its own quoted, monospaced row below, so a description cannot read as part of the sentence above it.
  const summary = model.summary ? el('div', 'font-size:13px;font-weight:600;margin-bottom:8px;', model.summary) : null;
  const bank = model.bankDataRow
    ? el('div', `${MONO}font-size:12px;margin-bottom:8px;padding:6px 8px;background:${T.surface};border:1px solid ${T.border};border-radius:4px;word-break:break-word;`, model.bankDataRow)
    : null;

  const body = el('div', 'margin-bottom:12px;');
  if (readCard) renderRead(body, model);
  else renderDelta(body, model);

  const note = el('div', `font-size:11px;color:${T.amber};min-height:0;margin-bottom:8px;display:none;`);
  const buttons = el('div', 'display:flex;gap:8px;');

  const finish = async (action: 'approve' | 'reject') => {
    handle.busy = true;
    let outcome = 'unknown';
    try {
      const res = await api<{ outcome?: string }>(`/api/mcp/operations/${op.id}/${action}`, { method: 'POST' });
      outcome = res.outcome ?? 'unknown';
    } catch (err) {
      // 409 is either "approved too quickly" (still pending: try again) or "the window closed".
      if (err instanceof Error && err.message.startsWith('409')) outcome = err.message.includes('approval_too_fast') ? 'approval_too_fast' : 'expired';
    }
    if (outcome === 'approval_too_fast') {
      handle.busy = false;
      note.textContent = outcomeCopy(outcome);
      note.style.display = 'block';
      armApprove();
      layoutCards();
      return;
    }
    // Say how it ended, then clear the card.
    node.replaceChildren(el('div', 'font-size:13px;', outcomeCopy(outcome)));
    layoutCards();
    setTimeout(() => {
      removeCardNode(node);
      cards.delete(op.id);
      onResolved();
      void refreshState();
      announceStateChanged();
    }, 2500);
  };

  // Press-and-hold Approve with a progress fill. Trusted events only: a script's synthetic click or key cannot start it.
  const approve = el(
    'button',
    `position:relative;overflow:hidden;flex:1;padding:8px;border:1px solid ${accent};border-radius:${T.radius};background:transparent;color:${accent};font:600 12px ${T.sans};cursor:pointer;`,
  ) as HTMLButtonElement;
  const fill = el('span', `position:absolute;left:0;top:0;bottom:0;width:0%;background:${accent}33;`);
  const approveLabel = el('span', 'position:relative;', '');
  approve.append(fill, approveLabel);

  let holding: { startedAt: number } | null = null;
  const idleLabel = readCard ? 'Hold to allow' : 'Hold to approve';

  const resetHold = () => {
    holding = null;
    fill.style.width = '0%';
    approveLabel.textContent = approve.disabled ? 'Approve' : idleLabel;
  };

  function armApprove() {
    setDisabled(approve, true);
    approveLabel.textContent = 'Read the card…';
    setTimeout(() => {
      setDisabled(approve, false);
      resetHold();
    }, model.enableAfterMs);
  }

  const tickHold = (started: { startedAt: number }) => {
    if (holding !== started) return;
    const progress = holdProgress(started.startedAt, Date.now(), model.holdMs || CARD_HOLD_MS);
    fill.style.width = `${Math.round(progress * 100)}%`;
    if (progress >= 1) {
      holding = null;
      approveLabel.textContent = 'Working…';
      setDisabled(approve, true);
      void finish('approve');
      return;
    }
    setTimeout(() => tickHold(started), 30);
  };

  const startHold = (e: Event) => {
    if (approve.disabled || holding) return;
    if (!e.isTrusted) {
      note.textContent = 'Approval needs a real click or key press.';
      note.style.display = 'block';
      return;
    }
    holding = { startedAt: Date.now() };
    approveLabel.textContent = 'Keep holding…';
    tickHold(holding);
  };
  approve.addEventListener('pointerdown', startHold);
  approve.addEventListener('pointerup', resetHold);
  approve.addEventListener('pointerleave', resetHold);
  approve.addEventListener('pointercancel', resetHold);
  approve.addEventListener('keydown', (e: Event) => {
    const key = (e as KeyboardEvent).key;
    if ((key === 'Enter' || key === ' ') && !(e as KeyboardEvent).repeat) startHold(e);
  });
  approve.addEventListener('keyup', resetHold);
  armApprove();

  const reject = el(
    'button',
    `flex:1;padding:8px;border:1px solid ${T.red};border-radius:${T.radius};background:${T.red}1f;color:${T.red};font:600 12px ${T.sans};cursor:pointer;`,
    readCard ? "Don't allow" : 'Reject',
  );
  reject.onclick = () => void finish('reject');

  buttons.append(approve, reject);
  node.append(top, requested);
  if (summary) node.append(summary);
  if (bank) node.append(bank);
  node.append(body, note, buttons);
  // Prepend: the column is pinned to the bottom, so a new card grows it upward and every card already
  // on screen (the one the user is reading, with its Approve button) stays exactly where it was.
  getCardHost().prepend(node);
  layoutCards();
}

/** Show a card for every pending operation, and remove the card of one that was answered elsewhere (Settings, another tab). */
function reconcileCards(operations: McpOperation[]): void {
  const pendingIds = new Set(operations.map((o) => o.id));
  for (const [id, handle] of cards) {
    if (!pendingIds.has(id) && !handle.busy) {
      removeCardNode(handle.node);
      cards.delete(id);
    }
  }
  for (const id of dismissed) if (!pendingIds.has(id)) dismissed.delete(id);
  for (const op of operations) {
    if (!dismissed.has(op.id)) showConfirmationCard(op, () => {});
  }
}

/**
 * One answer of `/api/mcp/operations` drives BOTH the cards and the panel's pending count (L6): the panel used to show
 * the scheduled state snapshot ("2 pending") next to cards the 1.5 s poller already knew about (3). Cards are drawn only in a
 * visible tab (the poller is visibility-gated by design); the count is updated either way.
 */
function applyOperations(all: McpOperation[], options: { cards: boolean }): void {
  // source === 'chat' is approved by the React ChatTab's inline card; one approval surface per operation.
  const operations = bridgeOwnedOperations(all);
  lastPollHadPending = operations.length > 0;
  if (options.cards) reconcileCards(operations);
  const next = withPendingOperations(agentState, operations);
  if (next !== agentState) {
    agentState = next;
    onStateChange?.();
  }
}

/** One fetch of the pending operations, applied. A failed fetch keeps what is shown. */
async function refreshPending(options: { cards: boolean }): Promise<void> {
  try {
    const res = await api<{ operations: McpOperation[] }>('/api/mcp/operations');
    applyOperations(res.operations, options);
  } catch {
    // Keep the last good list; the next poll tries again.
  }
}

// The poll used to run every 1.5 s on every page load. Now it is a setTimeout chain whose cadence
// nextConfirmationPollDelay decides; it pauses while the tab is hidden and is kicked on visibility/focus and when a
// call starts waiting on the server.
let lastPollHadPending = false;
/** Server calls of this tab (an agent's or a person's agent-filled submit) waiting on an answer. */
let callsAwaitingServer = 0;
let confirmationTimer: ReturnType<typeof setTimeout> | undefined;

function scheduleConfirmationPoll(): void {
  clearTimeout(confirmationTimer);
  confirmationTimer = undefined;
  const delay = nextConfirmationPollDelay({
    hidden: !tabIsVisible(),
    hasLiveGrants: liveTools.length > 0,
    bridgePending: callsAwaitingServer > 0,
    lastPollHadPending,
  });
  if (delay === null) return; // Resumed by kickConfirmationPoller on visibility/focus.
  confirmationTimer = setTimeout(() => void pollConfirmations(), delay);
}

async function pollConfirmations(): Promise<void> {
  await refreshPending({ cards: true });
  scheduleConfirmationPoll();
}

/** Poll now (tab became visible, or a call just started waiting on the server). */
function kickConfirmationPoller(): void {
  clearTimeout(confirmationTimer);
  confirmationTimer = undefined;
  if (!tabIsVisible()) return;
  void pollConfirmations();
}

// ── WebMCP tool registration ─────────────────────────────────────────────────

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
// The grant id each tool name currently runs under. An agent's `execute` (and a
// declarative form's submit) reads this at call time, so a revoke-and-regrant never
// leaves a tool holding a dead grant id.
const grantIdByTool = new Map<string, string>();
/** What the page registry was last told, so a sync that changed nothing does not re-render every form. */
let publishedSignature: string | null = null;

/**
 * The server operations each AGENT call of this tab has created, by call identity (never by tool name). Chrome's
 * `toolcancel` (it names the tool) and a rejected `execute` end a call; the ledger withdraws the cards of THAT call only.
 * A person's submit, another call's card, and a card orphaned by anything else (form unmounted, `toolchange`, which names
 * no tool) are left alone and expire on their own (S2).
 */
const ledger = createOperationLedger();

/** What every server call (and every cancel) needs: the tab's session, the dashboard auth, and the ledger. */
function serverDeps() {
  return { fetch: (url: string, init?: RequestInit) => fetch(url, init), sessionGeneration: getSessionGeneration(), authHeaders, ledger };
}

/** Tab-session call into the server's one tool endpoint, with the live grant for `name`. */
function callWithGrant(name: string, args: Record<string, unknown>, transport: 'imperative' | 'declarative' | 'page', signal?: AbortSignal, agentCall?: AgentCall): Promise<unknown> {
  const grantId = grantIdByTool.get(name);
  if (!grantId) return Promise.reject(new ToolCallError('grant_invalid', `Access to ${name} was revoked. Ask the user to grant it again.`));
  callsAwaitingServer++;
  kickConfirmationPoller();
  return callServerTool(serverDeps(), { grantId, tool: name, args, transport, agentCall }, signal).finally(() => {
    callsAwaitingServer--;
  });
}

/**
 * Agent calls running right now, per tool. Chrome cancels a running call when its tool is unregistered or re-registered, so
 * a reconcile pass leaves a tool that is still live but out of view alone until its call settles (L3).
 */
const inFlight = new Map<string, number>();

function trackCall<T>(name: string, run: (call: AgentCall) => Promise<T>): Promise<T> {
  inFlight.set(name, (inFlight.get(name) ?? 0) + 1);
  const call = ledger.beginCall(name);
  return run(call)
    .catch((err: unknown) => {
      // This call's `execute` rejected (an abort, or Chrome gave up on it): withdraw what THIS call still has open. The
      // call's own operation was usually released when its wait ended; this is the safety net for one that was not. Other
      // calls of the tool, and a person's cards, have other identities and are never touched.
      void endChromeCall(serverDeps(), ledger, { type: 'execute-rejected', call });
      throw err;
    })
    .finally(() => {
      ledger.endCall(call);
      const left = (inFlight.get(name) ?? 1) - 1;
      if (left > 0) inFlight.set(name, left);
      else {
        inFlight.delete(name);
        // Whatever was deferred while the call ran can now be reconciled.
        scheduler.request();
      }
    });
}

function pageRegistry() {
  return getPageRegistry(window as unknown as Parameters<typeof getPageRegistry>[0]);
}

/**
 * What a registered tool does when the agent calls it. A page tool is authorized by the server first and then run by
 * the tab's own handler (a React component registered it in the page registry); every other tool is one server call.
 * The server's `classification` decides which: nothing here names a tool.
 */
function makeExecute(tool: LiveToolDescriptor): (args: Record<string, unknown>, options: { signal: AbortSignal }) => Promise<unknown> {
  // Every refusal and failure is RETURNED as `{ error: { code, message } }`: Chrome 154 replaces a thrown error with a
  // generic "Tool was executed but the invocation failed", so the agent would never read what to do next (L4).
  if (tool.classification !== 'page') {
    return (args, options) => trackCall(tool.name, (call) => executeServerTool(() => callWithGrant(tool.name, args, 'imperative', options?.signal, call)));
  }
  return (args, options) =>
    trackCall(tool.name, (call) =>
      executePageTool({
        tool,
        args,
        signal: options.signal,
        runtime: pageRegistry(),
        serverCall: (signal) => {
          const grantId = grantIdByTool.get(tool.name);
          if (!grantId) return Promise.reject(new ToolCallError('grant_invalid', `Access to ${tool.name} was revoked. Ask the user to grant it again.`));
          callsAwaitingServer++;
          kickConfirmationPoller();
          return callServerToolAnswer(
            serverDeps(),
            { grantId, tool: tool.name, args, transport: 'page', agentCall: call },
            signal,
            { pageMode: true }
          ).finally(() => {
            callsAwaitingServer--;
          });
        },
      })
    );
}

/** The tools the server last said this tab may use (granted, policy not Off, access on). Registrations are derived from it. */
let liveTools: LiveToolDescriptor[] = [];

/**
 * Make the registered tools match the live set for the tab that is showing: abort what is no longer wanted (a revoked
 * grant, the kill switch, the previous tab's tools), register what is new. Runs from `scheduler` only, one pass at a time.
 */
async function reconcileRegistrations(): Promise<void> {
  const modelContext = document.modelContext;
  if (!modelContext) return; // No WebMCP support in this browser — nothing to register.
  const registry = pageRegistry();
  await registerLiveTools({
    tools: liveTools,
    registered: registeredTools,
    activeTab: registry.activeTab(),
    hasHandler: (name) => registry.getHandler(name) !== undefined,
    isBusy: (name) => (inFlight.get(name) ?? 0) > 0,
    // Native, spec-level hints (read-only, consequential, untrusted content) ride in `annotations` — advice to the
    // agent, separate from and in addition to the server's own grant / policy / prepare / commit gate.
    registerTool: (tool, options) => modelContext.registerTool(tool as ModelContextTool, options),
    // One path for every call: the server decides whether it is a read (returns data), a read the user must allow,
    // or a change (returns an operation to wait on while the user answers the card). Nothing here classifies.
    makeExecute,
  });
}

/** A tab change (unmount, mount, active tab) lands as three registry notifications: one pass, 50 ms later. */
const scheduler = createReconcileScheduler({ run: reconcileRegistrations });

/**
 * Tell the React dashboard which tools are live, and give its declarative forms the one way to call the
 * server. The forms carry `toolname` only for a live tool, and an `agentInvoked` submit goes through
 * `callServerTool` below: the same endpoint, grant and approval card as an imperative tool.
 */
function publishLiveSet(tools: LiveToolDescriptor[]): void {
  const registry = pageRegistry();
  registry.callServerTool = (name, args, opts) => {
    const params = (args ?? {}) as Record<string, unknown>;
    // A person's submit of an agent-filled form is not an agent call: it is never registered, so nothing can withdraw it.
    if (opts.agentCall !== true) return callWithGrant(name, params, opts.transport, opts.signal);
    const call = ledger.beginCall(name);
    return callWithGrant(name, params, opts.transport, opts.signal, call).finally(() => ledger.endCall(call));
  };
  const signature = liveToolsSignature(tools);
  if (signature === publishedSignature) return;
  publishedSignature = signature;
  registry.setLiveTools(
    tools.map((t) => t.name),
    tools.map((t) => ({
      name: t.name,
      description: t.description,
      classification: t.classification,
      autosubmit: t.autosubmit,
      policy: t.policy,
      inputSchema: t.inputSchema,
      surface: t.surface,
      exposure: t.exposure,
    }))
  );
}

/** `api` throws `<status>: <body>`; a 401 or 403 means this tab is no longer authorized (logout, expired session). */
function isAuthFailure(err: unknown): boolean {
  return err instanceof Error && /^(401|403):/.test(err.message);
}

async function syncRegisteredTools(): Promise<void> {
  let tools: LiveToolDescriptor[];
  try {
    const res = await api<{ tools: LiveToolDescriptor[] }>('/api/mcp/tools');
    tools = res.tools;
  } catch (err) {
    // A transient failure (network, server restart) keeps what is live until the next sync. An authorization
    // failure does not: the live set is "granted, policy not Off, access on", and this tab can no longer say so,
    // so forms drop their tool attributes and imperative tools are unregistered until a sync succeeds.
    if (!isAuthFailure(err)) return;
    grantIdByTool.clear();
    liveTools = [];
    publishLiveSet([]);
    await scheduler.flush();
    return;
  }

  // The server already answers [] while agent access is off and leaves out a tool whose policy is Off,
  // so a kill switch or a policy change unregisters everything it covers on this sync.
  grantIdByTool.clear();
  for (const tool of tools) grantIdByTool.set(tool.name, tool.grantId);
  liveTools = tools;

  // Forms first: they need the live set even where the browser has no `modelContext` to register with.
  publishLiveSet(tools);

  // Only the tools the server marks imperative are registered, and a tab's tools only while the tab shows. A
  // declarative tool is exposed by its form alone, so no name is ever registered both ways.
  await scheduler.flush();
}

// ── The floating panel ───────────────────────────────────────────────────────
//
// Status, the kill switch, this tab's grants, what is waiting for you, and the
// last five calls. Policies, grant lifetime, client tokens and the full log live
// in Settings -> Agent access; the panel links there. Both read the same state.

function buildPanel(): void {
  const launcher = el(
    'button',
    `${FONT}position:fixed;bottom:16px;left:16px;z-index:2147483646;display:flex;align-items:center;gap:8px;padding:7px 12px;` +
      `border:1px solid ${T.border};border-radius:${T.radius};background:${T.bg};cursor:pointer;`,
  ) as HTMLButtonElement;
  const dot = el('span', `display:inline-block;width:8px;height:8px;border-radius:50%;background:${T.muted};`);
  const launcherLabel = el('span', `font:600 11px ${T.mono};letter-spacing:.08em;`, 'AGENT ACCESS');
  launcher.append(dot, launcherLabel);

  const panel = el(
    'div',
    `${FONT}position:fixed;bottom:56px;left:16px;z-index:2147483646;width:300px;max-height:70vh;overflow:auto;box-sizing:border-box;` +
      `background:${T.bg};border:1px solid ${T.border};border-radius:${T.radius};padding:14px;box-shadow:0 8px 24px rgba(0,0,0,.5);`,
  );
  panel.hidden = true;
  panel.style.display = 'none';

  let confirmingOff = false;
  let busy = false;
  /** Checkbox choices the user has not applied yet, so a background refresh does not erase them. */
  let draft: Set<string> | null = null;

  const isAdmin = () => !agentState || agentState.role === 'admin';

  function section(title: string): HTMLElement {
    const box = el('div', `border-top:1px solid ${T.border};padding-top:10px;margin-top:10px;`);
    box.append(el('div', `font:600 10px ${T.sans};letter-spacing:.08em;text-transform:uppercase;color:${T.muted};margin-bottom:6px;`, title));
    return box;
  }

  async function putSettings(body: unknown): Promise<void> {
    busy = true;
    try {
      await api('/api/mcp/settings', { method: 'PUT', body: JSON.stringify(body) });
    } catch {
      // A refused change (a viewer, a closed window) is shown by the refreshed state, which is unchanged.
    }
    busy = false;
    confirmingOff = false;
    await syncAndSchedule();
    announceStateChanged();
  }

  function renderPanel(): void {
    // Dot and launcher first: they must be right even while the panel is closed.
    const state = agentState;
    dot.style.background = state ? CHIP_COLOR[statusDot(state) === 'green' ? 'green' : statusDot(state) === 'red' ? 'red' : 'muted'] : T.muted;
    launcher.title = !state ? 'Agent access' : !state.enabled ? 'Agent access is off' : 'Agent access';
    if (panel.hidden) return;

    panel.replaceChildren();
    panel.style.borderColor = state && !state.enabled ? `${T.red}80` : T.border;

    panel.append(el('div', 'font-weight:700;font-size:13px;margin-bottom:2px;', document.modelContext ? 'Agent access for this tab' : 'WebMCP is not available in this browser'));
    if (!document.modelContext) panel.append(el('div', `color:${T.muted};font-size:11px;`, 'Chrome origin trial only. External MCP clients still work.'));

    if (!state) {
      panel.append(el('div', `color:${T.muted};margin-top:8px;`, 'Loading…'));
      return;
    }

    // Kill switch.
    const kill = el('div', `margin-top:10px;padding:8px 10px;border-radius:${T.radius};border:1px solid ${state.enabled ? T.border : `${T.red}80`};background:${state.enabled ? T.surface : `${T.red}1a`};`);
    const killRow = el('div', 'display:flex;align-items:center;justify-content:space-between;gap:8px;');
    killRow.append(el('div', 'font-weight:600;', 'Agent access (all profiles)'));
    const toggle = button(state.enabled ? 'ON' : 'OFF', state.enabled ? 'green' : 'red', () => {
      if (state.enabled) {
        confirmingOff = true;
        renderPanel();
      } else {
        void putSettings({ enabled: true });
      }
    });
    toggle.style.fontFamily = T.mono;
    setDisabled(toggle, busy || !isAdmin());
    if (!isAdmin()) toggle.title = 'Only an admin can change this';
    killRow.append(toggle);
    kill.append(killRow);
    if (!state.enabled) {
      kill.append(el('div', `color:${T.red};margin-top:6px;`, 'Agent access is off. No tools are exposed to any agent or MCP client.'));
    } else if (confirmingOff) {
      kill.append(el('div', `color:${T.muted};margin:6px 0;`, 'Turn off agent access? Every grant is revoked and pending approvals are rejected, in every profile.'));
      const row = el('div', 'display:flex;gap:8px;');
      row.append(button('Turn off', 'red', () => void putSettings({ enabled: false })), button('Cancel', 'plain', () => { confirmingOff = false; renderPanel(); }));
      kill.append(row);
    } else {
      const live = state.tools.filter((t) => t.grant).length;
      kill.append(el('div', `color:${live > 0 ? T.green : T.muted};margin-top:4px;`, `${live} tool${live === 1 ? '' : 's'} live in this tab · ${state.pending.length} pending`));
    }
    panel.append(kill);

    // This tab's grants.
    const rows = buildToolRows(state, state.role);
    const granted = new Set(rows.filter((r) => r.grantState.kind === 'granted').map((r) => r.name));
    const wanted = draft ?? new Set(granted);
    const grants = section('This tab');
    for (const row of rows) {
      const line = el('label', `display:flex;align-items:center;gap:8px;padding:3px 0;${row.grantable || granted.has(row.name) ? '' : 'opacity:.5;'}`);
      const box = document.createElement('input') as HTMLInputElement;
      box.type = 'checkbox';
      box.checked = wanted.has(row.name);
      box.disabled = busy || (!row.grantable && !granted.has(row.name));
      if (row.grantBlockedReason) box.title = row.grantBlockedReason;
      box.addEventListener('change', () => {
        draft = new Set(wanted);
        if (box.checked) draft.add(row.name);
        else draft.delete(row.name);
        renderPanel();
      });
      const name = el('span', `${MONO}font-size:11px;flex:1;word-break:break-all;`, row.name);
      line.append(box, name);
      if (row.classBadge.label === 'WRITE') line.append(el('span', `font:600 9px ${T.sans};letter-spacing:.08em;color:${T.amber};border:1px solid ${T.amber}66;border-radius:3px;padding:1px 4px;`, 'WRITE'));
      line.append(el('span', `font-size:10px;color:${row.policy === 'ask' ? T.amber : T.muted};`, row.policy));
      grants.append(line);
    }
    const dirty = rows.some((r) => wanted.has(r.name) !== granted.has(r.name));
    const actions = el('div', 'display:flex;gap:8px;margin-top:8px;');
    const apply = button('Apply', 'green', async () => {
      busy = true;
      renderPanel();
      const toGrant = rows.filter((r) => wanted.has(r.name) && !granted.has(r.name)).map((r) => r.name);
      const toRevoke = rows.filter((r) => !wanted.has(r.name) && r.grantState.kind === 'granted');
      if (toGrant.length > 0) await api('/api/mcp/grants', { method: 'POST', body: JSON.stringify({ tools: toGrant }) }).catch(() => {});
      for (const r of toRevoke) {
        if (r.grantState.kind === 'granted') await api(`/api/mcp/grants/${r.grantState.grantId}`, { method: 'DELETE' }).catch(() => {});
      }
      draft = null;
      busy = false;
      await syncAndSchedule();
      announceStateChanged();
    });
    setDisabled(apply, !dirty || busy);
    const revokeAll = button('Revoke all', 'red', async () => {
      busy = true;
      renderPanel();
      await api('/api/mcp/grants/revoke-session', { method: 'POST', body: JSON.stringify({}) }).catch(() => {});
      draft = null;
      busy = false;
      await syncAndSchedule();
      announceStateChanged();
    });
    setDisabled(revokeAll, granted.size === 0 || busy);
    actions.append(apply, revokeAll);
    grants.append(actions);
    const soonest = rows.flatMap((r) => (r.grantState.kind === 'granted' ? [r.grantState.expiresAt] : [])).sort()[0];
    if (soonest) grants.append(el('div', `color:${T.muted};font-size:11px;margin-top:6px;`, `Expires ${new Date(soonest).toLocaleTimeString()}`));
    panel.append(grants);

    // Pending approvals.
    if (state.pending.length > 0) {
      const pending = section(`${state.pending.length} pending`);
      for (const op of state.pending) {
        const model = confirmationCardModel(op);
        const row = el('button', `display:block;width:100%;text-align:left;background:${T.surface};border:1px solid ${T.border};border-radius:4px;padding:6px 8px;margin-bottom:4px;cursor:pointer;${FONT}`);
        row.append(el('div', `font-weight:600;color:${model.tone === 'amber' ? T.amber : T.text};`, model.heading), el('div', `color:${T.muted};font-size:11px;`, model.requestedByLine));
        row.onclick = () => {
          dismissed.delete(op.id);
          showConfirmationCard(op, () => {});
        };
        pending.append(row);
      }
      panel.append(pending);
    }

    // Last five calls.
    const activity = section('Activity');
    if (state.auditTail.length === 0) {
      activity.append(el('div', `color:${T.muted};`, 'No agent activity yet.'));
    }
    for (const entry of state.auditTail) {
      const row = formatAuditRow(entry);
      if (row.kind === 'notice') {
        activity.append(el('div', `color:${T.amber};font-size:11px;padding:3px 0;`, row.notice ?? ''));
        continue;
      }
      const line = el('div', 'display:flex;gap:6px;align-items:baseline;padding:2px 0;font-size:11px;');
      line.append(
        el('span', `${MONO}color:${T.muted};`, localTime(row.timeIso)),
        el('span', `${MONO}flex:1;word-break:break-all;`, row.count ? `${row.tool} ×${row.count}` : row.tool),
        el('span', `color:${CHIP_COLOR[row.chip]};`, row.decisionLabel),
      );
      activity.append(line);
    }
    panel.append(activity);

    const link = button('Policies, TTL & full log → Settings', 'plain', () => {
      if (typeof location !== 'undefined') location.hash = 'settings';
      panel.hidden = true;
      panel.style.display = 'none';
    });
    link.style.marginTop = '12px';
    link.style.width = '100%';
    panel.append(link);
  }

  function openPanel(): void {
    panel.hidden = false;
    panel.style.display = 'block';
    renderPanel();
    void refreshState();
  }

  launcher.onclick = () => {
    if (panel.hidden) openPanel();
    else {
      panel.hidden = true;
      panel.style.display = 'none';
    }
  };

  // Settings -> Agent access (or the demo) asks to open this panel.
  window.addEventListener(OPEN_PANEL_EVENT, openPanel);

  onStateChange = renderPanel;
  document.body.append(launcher, panel);
  renderPanel();
}

/**
 * `toolchange` is dispatched on `document.modelContext` (observed live in Chrome 154; `toolactivated` / `toolcancel` are
 * on `window`, not here): the registered set changed, so the panel's pending count and the live set are re-read at once.
 * `modelContext` can appear after this script ran (origin trial), so this is retried from every sync until it binds.
 */
let toolChangeBound = false;
function bindToolChange(): void {
  if (toolChangeBound) return;
  const modelContext = document.modelContext as (ModelContext & { addEventListener?: (type: string, listener: (e?: Event) => void) => void }) | undefined;
  if (!modelContext || typeof modelContext.addEventListener !== 'function') return;
  toolChangeBound = true;
  // Chrome's `toolchange` names no tool, so it cannot say which call (if any) it ended: it only refreshes state. An orphan it
  // may leave behind is not withdrawn (see `ChromeCallEnd`): the schema is kept stable during a call so nothing re-derives
  // it, and a card that was orphaned anyway expires on its own.
  modelContext.addEventListener('toolchange', () => {
    void refreshPending({ cards: tabIsVisible() });
    void refreshState();
  });
  // `toolcancel` is dispatched on window (like `toolactivated`): the agent gave up, so its card is withdrawn too.
  window.addEventListener('toolcancel', (e) => void withdrawOrphans({ type: 'toolcancel', tool: toolNameOf(e) }));
}

function toolNameOf(e: Event | undefined): string | undefined {
  const name = (e as (Event & { toolName?: unknown }) | undefined)?.toolName;
  return typeof name === 'string' ? name : undefined;
}

/**
 * The agent gave up (`toolcancel`, which names the tool): cancel the server operations of the agent call that is in flight
 * for it (S2), then refresh the pending list.
 */
async function withdrawOrphans(event: ChromeCallEnd): Promise<void> {
  const ids = await endChromeCall(serverDeps(), ledger, event);
  if (ids.length > 0) await refreshPending({ cards: tabIsVisible() });
}

/** One sync: refresh the shared state (panel, kill switch, agent state), then make the registered tools match it. */
async function syncOnce(): Promise<void> {
  bindToolChange();
  await refreshState();
  await syncRegisteredTools();
}

// The single periodic driver (see the cadence note at the top). Events call syncAndSchedule directly for an immediate
// sync; the timer below is only the safety net, and nextToolSyncDelay decides whether it exists at all.
let toolSyncTimer: ReturnType<typeof setTimeout> | undefined;
/** Consecutive timer-driven syncs that found no WebMCP (an origin trial can attach after this script, a few times). */
let lateAttempts = 0;

function scheduleToolSync(): void {
  clearTimeout(toolSyncTimer);
  toolSyncTimer = undefined;
  const delay = nextToolSyncDelay({
    hidden: !tabIsVisible(),
    webmcpAvailable: !!document.modelContext,
    // The server's live set, not only the imperative registrations: a form-only tab has no registered tool but still
    // shows tool attributes that must drop when a grant expires.
    registeredCount: liveTools.length,
    lateAttempts,
  });
  if (delay === null) return; // Hidden, or nothing to wait for: resumed by an event.
  toolSyncTimer = setTimeout(() => {
    if (!document.modelContext) lateAttempts++;
    void syncAndSchedule();
  }, delay);
}

async function syncAndSchedule(): Promise<void> {
  await syncOnce();
  scheduleToolSync();
  scheduleConfirmationPoll(); // live-grant status may have changed the cadence
}

function init(): void {
  buildPanel();
  kickConfirmationPoller();

  // The dashboard tells the registry which tab shows and which page handlers are mounted. Either changes which tools
  // this tab registers, so reconcile (debounced), without a round trip: the live set itself has not changed.
  const registry = pageRegistry();
  registry.subscribe(() => scheduler.request());
  registry.whenSettled = () => scheduler.flush();
  void syncAndSchedule();

  // Settings changed something in this tab, or another surface did: resync now rather than on the next timer.
  const onChanged = (e: Event) => {
    if ((e as CustomEvent<{ from?: string }>).detail?.from === 'bridge') return;
    // A grant or policy change usually changes what is pending: the count follows the same pass as the cards (L6).
    void refreshPending({ cards: tabIsVisible() });
    void syncAndSchedule();
  };
  window.addEventListener(GRANTS_CHANGED_EVENT, onChanged);
  window.addEventListener(STATE_CHANGED_EVENT, onChanged);

  // The kill switch and policies are process-wide: another tab flipping one reaches this tab at once.
  channel = openAgentChannel(() => void syncAndSchedule());

  // A backgrounded tab polls nothing and runs no timer; on return, catch up at once (grants may have changed elsewhere,
  // or an operation may be waiting) instead of on the next timer.
  const resume = () => {
    if (!tabIsVisible()) {
      clearTimeout(toolSyncTimer);
      toolSyncTimer = undefined;
      clearTimeout(confirmationTimer);
      confirmationTimer = undefined;
      return;
    }
    lateAttempts = 0;
    kickConfirmationPoller();
    void syncAndSchedule();
  };
  document.addEventListener('visibilitychange', resume);
  window.addEventListener('focus', resume);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
