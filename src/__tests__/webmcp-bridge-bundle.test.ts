import { describe, expect, test, afterEach } from 'bun:test';
import { runInNewContext } from 'node:vm';
import { createTestDb, seedTestData } from './helpers.js';
import { bfetch } from './mcp-helpers.js';
import { startDashboardServer, stopDashboardServer } from '../dashboard/server.js';
import { setInitialProfile, closeAll } from '../dashboard/db-manager.js';
import { TOOL_SYNC_LIVE_MS, TOOL_SYNC_LATE_REGISTRATION_MS, TOOL_SYNC_LATE_ATTEMPTS } from '../dashboard/webmcp-polling.js';
import { WILSON_AGENT_CHANNEL, WILSON_MCP_SESSION_KEY, WILSON_GRANTS_CHANGED_EVENT, WILSON_AGENT_STATE_CHANGED_EVENT } from '../dashboard/webmcp-session.js';
import { SESSION_HEADER } from '../dashboard/webmcp-bridge-core.js';

/**
 * Runs the real bundle the server serves at /webmcp-bridge.js against a stub
 * DOM and `document.modelContext`, with the real dashboard server behind it.
 * Proves the bridge actually registers the granted tools and routes every
 * `execute` through the single /api/mcp/call endpoint.
 */

const servers: Awaited<ReturnType<typeof startDashboardServer>>['server'][] = [];
afterEach(() => {
  for (const s of servers) {
    try { stopDashboardServer(s); } catch { /* */ }
  }
  servers.length = 0;
  closeAll();
});

interface RegisteredTool {
  name: string;
  description: string;
  annotations: Record<string, boolean>;
  execute: (args: Record<string, unknown>, options: { signal: AbortSignal }) => Promise<unknown>;
}

function stubElement(): any {
  const el: any = {
    style: {}, hidden: false, textContent: '', children: [],
    append() {}, appendChild() {}, replaceChildren() {}, remove() {}, addEventListener() {}, insertRow: () => stubElement(),
  };
  return el;
}

/** A minimal in-memory BroadcastChannel: same-name channels in other objects hear a post, the poster does not. */
class FakeChannel {
  static all: FakeChannel[] = [];
  onmessage: ((event: unknown) => void) | null = null;
  closed = false;
  constructor(readonly name: string) {
    FakeChannel.all.push(this);
  }
  postMessage(message: unknown): void {
    for (const other of FakeChannel.all) {
      if (other !== this && other.name === this.name && !other.closed) other.onmessage?.({ data: message });
    }
  }
  close(): void {
    this.closed = true;
  }
}

interface BootOptions {
  tools?: string[];
  expectRegistered?: number;
  broadcastChannel?: typeof FakeChannel;
  /** Boot with the tab hidden (document.hidden / visibilityState). */
  hidden?: boolean;
  /** A browser without WebMCP: no document.modelContext. */
  noModelContext?: boolean;
}

/**
 * Takes over only the tool-resync timer (the two delays webmcp-polling.ts hands out: TOOL_SYNC_LIVE_MS and
 * TOOL_SYNC_LATE_REGISTRATION_MS) so a test can see which timer exists and fire it on demand. Every other timer
 * (the 50 ms reconcile debounce, the confirmation poll's 1.5/5/15 s, registerTool's guard) stays real.
 */
function syncTimerHarness() {
  let nextId = 1_000_000;
  const entries = new Map<number, { fn: () => void; delay: number }>();
  const isSyncDelay = (ms: unknown) => ms === TOOL_SYNC_LIVE_MS || ms === TOOL_SYNC_LATE_REGISTRATION_MS;
  return {
    setTimeout: (fn: () => void, ms?: number) => {
      if (!isSyncDelay(ms)) return setTimeout(fn, ms);
      const id = nextId++;
      entries.set(id, { fn, delay: ms as number });
      return id;
    },
    clearTimeout: (id: unknown) => {
      if (typeof id === 'number' && entries.delete(id)) return;
      clearTimeout(id as ReturnType<typeof setTimeout>);
    },
    /** Delays of the sync timers currently waiting. */
    pending: () => [...entries.values()].map((e) => e.delay),
    /** Fire the (single) waiting sync timer and let the sync it starts finish. */
    fire: async () => {
      const [id, entry] = [...entries.entries()][0] ?? [];
      if (id === undefined || !entry) throw new Error('no sync timer is waiting');
      entries.delete(id);
      entry.fn();
      await new Promise((r) => setTimeout(r, 120));
    },
  };
}

async function bootBridge(options: BootOptions = {}) {
  const db = createTestDb();
  seedTestData(db);
  setInitialProfile('test', db);
  const { server } = await startDashboardServer(db, 0);
  servers.push(server);
  const base = `http://localhost:${server.port}`;
  const session = crypto.randomUUID();
  const seen: Array<{ url: string; method: string; headers: Record<string, string> }> = [];

  const post = (path: string, body: unknown) =>
    bfetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', [SESSION_HEADER]: session }, body: JSON.stringify(body) });
  const toolNames = options.tools ?? ['transaction_search', 'edit_transaction'];
  const granted = await (await post('/api/mcp/grants', { tools: toolNames })).json() as any;
  expect(granted.grants).toHaveLength(toolNames.length);

  const script = await (await fetch(base + '/webmcp-bridge.js')).text();
  expect(script.length).toBeGreaterThan(1000);

  const registered = new Map<string, RegisteredTool>();
  /** When each registration change was observed, for the "within 100 ms" tab-switch check. */
  const changeLog: Array<{ at: number; name: string; change: 'registered' | 'unregistered' }> = [];
  const store = new Map<string, string>([[WILSON_MCP_SESSION_KEY, session]]);
  const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
  const tab = { hidden: options.hidden ?? false };
  const docListeners = new Map<string, Array<(e: unknown) => void>>();
  const modelContextListeners = new Map<string, Array<(e: unknown) => void>>();
  const sync = syncTimerHarness();
  let intervals = 0;
  const doc: any = {
    readyState: 'complete',
    get hidden() { return tab.hidden; },
    get visibilityState() { return tab.hidden ? 'hidden' : 'visible'; },
    body: stubElement(),
    createElement: () => stubElement(),
    addEventListener(type: string, fn: (e: unknown) => void) {
      docListeners.set(type, [...(docListeners.get(type) ?? []), fn]);
    },
    modelContext: options.noModelContext ? undefined : {
      addEventListener(type: string, fn: (e: unknown) => void) {
        modelContextListeners.set(type, [...(modelContextListeners.get(type) ?? []), fn]);
      },
      registerTool: async (tool: RegisteredTool, opts?: { signal?: AbortSignal }) => {
        if (registered.has(tool.name)) throw new Error(`InvalidStateError: ${tool.name} is already registered`);
        registered.set(tool.name, tool);
        changeLog.push({ at: performance.now(), name: tool.name, change: 'registered' });
        opts?.signal?.addEventListener('abort', () => {
          if (registered.get(tool.name) === tool) {
            registered.delete(tool.name);
            changeLog.push({ at: performance.now(), name: tool.name, change: 'unregistered' });
          }
        });
      },
    },
  };
  const listeners = new Map<string, Array<(e: unknown) => void>>();
  const win: Record<string, unknown> = {
    addEventListener(type: string, fn: (e: unknown) => void) {
      listeners.set(type, [...(listeners.get(type) ?? []), fn]);
    },
    dispatchEvent() {},
  };
  const failTools = { status: 0 };
  const stubFetch = (url: string, init?: RequestInit) => {
    if (failTools.status && url === '/api/mcp/tools') return Promise.resolve(new Response('{"error":"nope"}', { status: failTools.status }));
    seen.push({ url, method: init?.method ?? 'GET', headers: (init?.headers ?? {}) as Record<string, string> });
    // The page sends its own Origin / Sec-Fetch-Site; bfetch adds the same pair for this stand-in.
    return bfetch(base + url, init);
  };
  // The bundle is our own build output (served above), run in an isolated context with only these globals.
  runInNewContext(script, {
    document: doc,
    window: win,
    sessionStorage: storage,
    localStorage: storage,
    fetch: stubFetch,
    setInterval: () => { intervals += 1; return 0; },
    setTimeout: sync.setTimeout,
    clearTimeout: sync.clearTimeout,
    CustomEvent: class {},
    performance,
    AbortController,
    crypto,
    console,
    ...(options.broadcastChannel ? { BroadcastChannel: options.broadcastChannel } : {}),
  });
  const expectRegistered = options.expectRegistered ?? 2;
  for (let i = 0; i < 100 && registered.size < expectRegistered; i++) await new Promise((r) => setTimeout(r, 20));
  const resync = async () => {
    for (const fn of listeners.get(WILSON_GRANTS_CHANGED_EVENT) ?? []) fn({ detail: { from: 'test' } });
    await new Promise((r) => setTimeout(r, 100));
  };
  /** Fire a window event (focus, ...) or a document event (visibilitychange) the bundle listens for. */
  const emit = (target: 'window' | 'document' | 'modelContext', type: string) => {
    const map = target === 'window' ? listeners : target === 'document' ? docListeners : modelContextListeners;
    for (const fn of map.get(type) ?? []) fn({});
  };
  const setHidden = (hidden: boolean) => { tab.hidden = hidden; };
  const toolsFetches = () => seen.filter((c) => c.url === '/api/mcp/tools').length;
  const stateFetches = () => seen.filter((c) => c.url === '/api/mcp/state').length;
  return { db, base, session, registered, seen, win, failTools, resync, changeLog, sync, emit, setHidden, toolsFetches, stateFetches, intervals: () => intervals };
}

describe('the served bridge bundle', () => {
  test('a sync that fails with 401 or 403 drops the live set, so forms lose their tool attributes and calls lose their grant', async () => {
    for (const status of [401, 403]) {
      const { registered, win, failTools, resync } = await bootBridge();
      const registry = (win as any).__wilsonPageTools;
      expect(registry).toBeDefined();
      const tool = registered.get('transaction_search')!;
      expect([...registry.liveTools()].length).toBeGreaterThan(0);

      failTools.status = status;
      await resync();

      expect([...registry.liveTools()]).toEqual([]);
      // A refusal is a RESULT (Chrome 154 hides the text of a thrown error from the agent).
      const out = (await tool.execute({ query: 'groceries' }, { signal: new AbortController().signal })) as { error: { code: string; message: string } };
      expect(out.error.code).toBe('grant_invalid');
      expect(out.error.message).toContain('revoked');
    }
  });

  test('a message from another tab on the agent channel makes the bridge resync (it refetches the live set)', async () => {
    FakeChannel.all = [];
    const { seen, registered } = await bootBridge({ broadcastChannel: FakeChannel });
    const bridgeChannel = FakeChannel.all.find((c) => c.name === WILSON_AGENT_CHANNEL && c.onmessage);
    expect(bridgeChannel).toBeDefined(); // the bridge opened the channel and listens on it
    const toolsFetches = () => seen.filter((c) => c.url === '/api/mcp/tools').length;
    const stateFetches = () => seen.filter((c) => c.url === '/api/mcp/state').length;
    const before = { tools: toolsFetches(), state: stateFetches() };

    // Another tab (a different channel object, same name) announces a kill-switch / policy / grant change.
    new FakeChannel(WILSON_AGENT_CHANNEL).postMessage({ type: 'state-changed' });
    for (let i = 0; i < 50 && toolsFetches() === before.tools; i++) await new Promise((r) => setTimeout(r, 20));

    expect(toolsFetches()).toBeGreaterThan(before.tools);
    expect(stateFetches()).toBeGreaterThan(before.state);
    expect([...registered.keys()].sort()).toEqual(['edit_transaction', 'transaction_search']); // nothing lost by the resync

    // A message on some other channel is ignored.
    const quiet = toolsFetches();
    new FakeChannel('unrelated').postMessage({ type: 'state-changed' });
    await new Promise((r) => setTimeout(r, 150));
    expect(toolsFetches()).toBe(quiet);
  });

  test('registers exactly the granted tools, with the spec annotations and the session in a header', async () => {
    const { registered, seen, session } = await bootBridge();
    expect([...registered.keys()].sort()).toEqual(['edit_transaction', 'transaction_search']);
    expect(registered.get('transaction_search')!.annotations).toEqual({ readOnlyHint: true, consequentialHint: false, untrustedContentHint: true });
    expect(registered.get('edit_transaction')!.annotations).toEqual({ readOnlyHint: false, consequentialHint: true, untrustedContentHint: false });
    const toolsCall = seen.find((c) => c.url === '/api/mcp/tools');
    expect(toolsCall).toBeDefined();
    expect(toolsCall!.headers[SESSION_HEADER]).toBe(session);
    expect(seen.some((c) => c.url.includes(session))).toBe(false); // never in a URL
  });

  test('a read tool goes through /api/mcp/call and returns data', async () => {
    const { registered, seen } = await bootBridge();
    const out = (await registered.get('transaction_search')!.execute({ query: 'groceries' }, { signal: new AbortController().signal })) as any;
    expect(out.total).toBe(2);
    expect(seen.filter((c) => c.url === '/api/mcp/call')).toHaveLength(1);
    // The two retired wrapper routes are never called (spelled in pieces so this file stays out of the source grep).
    expect(seen.some((c) => c.url === ['/api/mcp/', 'read'].join('') || c.url === ['/api/mcp/', 'prepare'].join(''))).toBe(false);
  });

  test('a change waits for the approval card, then returns the committed outcome', async () => {
    const { db, base, registered } = await bootBridge();
    const txn = db.prepare('SELECT id FROM transactions LIMIT 1').get() as { id: number };
    const pending = registered.get('edit_transaction')!.execute({ id: txn.id, notes: 'from the bundle' }, { signal: new AbortController().signal });

    let opId: string | undefined;
    for (let i = 0; i < 100 && !opId; i++) {
      const list = (await (await fetch(base + '/api/mcp/operations')).json()) as any;
      opId = list.operations[0]?.id;
      if (!opId) await new Promise((r) => setTimeout(r, 20));
    }
    expect(opId).toBeDefined();
    expect((db.prepare('SELECT notes FROM transactions WHERE id=@id').get({ id: txn.id }) as any).notes).toBeNull();
    await bfetch(`${base}/api/mcp/operations/${opId}/approve`, { method: 'POST' });

    const out = (await pending) as any;
    expect(out.outcome).toBe('committed');
    expect(out.operationId).toBe(opId);
    expect(out.result).toMatchObject({ id: txn.id });
    expect((db.prepare('SELECT notes FROM transactions WHERE id=@id').get({ id: txn.id }) as any).notes).toBe('from the bundle');
  });

  test('aborting execute withdraws the pending operation', async () => {
    const { db, base, registered } = await bootBridge();
    const txn = db.prepare('SELECT id FROM transactions LIMIT 1').get() as { id: number };
    const controller = new AbortController();
    const pending = registered.get('edit_transaction')!.execute({ id: txn.id, notes: 'abandoned' }, { signal: controller.signal });
    pending.catch(() => {});

    let opId: string | undefined;
    for (let i = 0; i < 100 && !opId; i++) {
      const list = (await (await fetch(base + '/api/mcp/operations')).json()) as any;
      opId = list.operations[0]?.id;
      if (!opId) await new Promise((r) => setTimeout(r, 20));
    }
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    const row = db.prepare('SELECT status, outcome_json FROM mcp_operations WHERE id=@id').get({ id: opId }) as any;
    expect(row.status).toBe('rejected');
    expect(JSON.parse(row.outcome_json)).toEqual({ reason: 'cancelled_by_agent' });
    expect((db.prepare('SELECT notes FROM transactions WHERE id=@id').get({ id: txn.id }) as any).notes).toBeNull();
  });

  test('a validation failure comes back as an {error:{code,message}} RESULT with the actionable message (Chrome hides a thrown one)', async () => {
    const { registered } = await bootBridge();
    const out = (await registered.get('edit_transaction')!.execute({ id: 1, amount: '12abc' }, { signal: new AbortController().signal })) as { error: { code: string; message: string } };
    expect(out.error.code).toBe('invalid_args');
    expect(out.error.message).toContain('amount must be a number');
  });
});

/** What React does on mount: a handler under an AbortController, in the page registry the bundle publishes on window. */
function mountHandler(registry: any, name: string, tab: string, handler: (args: any, ctx: any) => Promise<unknown>) {
  const controller = new AbortController();
  registry.registerHandler(name, tab, handler, controller.signal);
  return controller;
}

async function until(predicate: () => boolean, ms = 1000) {
  const start = performance.now();
  while (!predicate() && performance.now() - start < ms) await new Promise((r) => setTimeout(r, 5));
}

describe('page tools through the served bridge bundle', () => {
  const GRANT = ['navigate_to_tab', 'open_transaction', 'list_review_queue', 'transaction_search'];

  test('a tab tool is registered only while its tab shows and its handler is mounted; a global tool needs just its handler', async () => {
    const { registered, win } = await bootBridge({ tools: GRANT, expectRegistered: 1 });
    const registry = (win as any).__wilsonPageTools;
    // The server read is global-surface: registered at once. The page tools wait for React.
    expect([...registered.keys()].sort()).toEqual(['transaction_search']);

    registry.setActiveTab('overview');
    mountHandler(registry, 'navigate_to_tab', 'global', async () => ({ tab: 'x' }));
    await until(() => registered.has('navigate_to_tab'));
    expect([...registered.keys()].sort()).toEqual(['navigate_to_tab', 'transaction_search']);

    // open_transaction belongs to the Transactions tab: no handler, wrong tab, nothing.
    registry.setActiveTab('transactions');
    const txn = mountHandler(registry, 'open_transaction', 'transactions', async () => ({ highlighted: true }));
    await until(() => registered.has('open_transaction'));
    // list_review_queue is a server read of the Review tab: not registered while Transactions shows.
    expect([...registered.keys()].sort()).toEqual(['navigate_to_tab', 'open_transaction', 'transaction_search']);
    txn.abort();
  });

  test('switching tabs changes the registered set within 100 ms', async () => {
    const { registered, win, changeLog } = await bootBridge({ tools: GRANT, expectRegistered: 1 });
    const registry = (win as any).__wilsonPageTools;
    registry.setActiveTab('transactions');
    const mount = mountHandler(registry, 'open_transaction', 'transactions', async () => ({}));
    await until(() => registered.has('open_transaction'));
    expect(registered.has('open_transaction')).toBe(true);
    expect(registered.has('list_review_queue')).toBe(false);

    // The tab changes: the old tab's component unmounts, then the provider says which tab shows.
    const started = performance.now();
    mount.abort();
    registry.setActiveTab('review');
    await until(() => registered.has('list_review_queue') && !registered.has('open_transaction'));
    const settled = changeLog.filter((c) => c.at >= started);
    expect(registered.has('open_transaction')).toBe(false);
    expect(registered.has('list_review_queue')).toBe(true);
    const lastChange = Math.max(...settled.map((c) => c.at));
    expect(lastChange - started).toBeLessThan(100);
    // One pass: the old tool left and the new one arrived, nothing else moved.
    expect(settled.map((c) => `${c.change}:${c.name}`).sort()).toEqual(['registered:list_review_queue', 'unregistered:open_transaction']);
  });

  test('executing a page tool authorizes on the server (audited as page), then runs the handler with the server row', async () => {
    const { db, registered, win } = await bootBridge({ tools: GRANT, expectRegistered: 1 });
    const registry = (win as any).__wilsonPageTools;
    registry.setActiveTab('transactions');
    const txn = db.prepare('SELECT id, description FROM transactions LIMIT 1').get() as { id: number; description: string };
    let seen: any;
    mountHandler(registry, 'open_transaction', 'transactions', async (args, ctx) => {
      seen = { args, pageData: ctx.pageData };
      return { ...ctx.pageData, highlighted: true };
    });
    await until(() => registered.has('open_transaction'));
    const tool = registered.get('open_transaction')!;
    expect(tool.annotations).toEqual({ readOnlyHint: false, consequentialHint: false, untrustedContentHint: true });

    const out = (await tool.execute({ id: txn.id }, { signal: new AbortController().signal })) as any;
    expect(out).toMatchObject({ id: txn.id, desc: txn.description, highlighted: true });
    expect(seen.args).toEqual({ id: txn.id });
    const row = db.prepare("SELECT transport, decision, classification FROM mcp_audit_log WHERE tool_name = 'open_transaction'").get() as any;
    expect(row).toEqual({ transport: 'page', decision: 'allowed', classification: 'page' });
  });

  test('a bad id is the server 404 text, and the handler never runs', async () => {
    const { registered, win } = await bootBridge({ tools: GRANT, expectRegistered: 1 });
    const registry = (win as any).__wilsonPageTools;
    registry.setActiveTab('transactions');
    let ran = false;
    mountHandler(registry, 'open_transaction', 'transactions', async () => { ran = true; return {}; });
    await until(() => registered.has('open_transaction'));
    const out = (await registered.get('open_transaction')!.execute({ id: 987654 }, { signal: new AbortController().signal })) as { error: { code: string; message: string } };
    expect(out.error.code).toBe('not_found'); // the REST status stays 404; the agent is handed the result
    expect(out.error.message).toContain('not found — use transaction_search');
    expect(ran).toBe(false);
  });

  test('a call that outlives its tab returns the navigate hint instead of touching unmounted state', async () => {
    const { registered, win } = await bootBridge({ tools: GRANT, expectRegistered: 1 });
    const registry = (win as any).__wilsonPageTools;
    registry.setActiveTab('transactions');
    let ran = false;
    const mount = mountHandler(registry, 'open_transaction', 'transactions', async () => { ran = true; return {}; });
    await until(() => registered.has('open_transaction'));
    const tool = registered.get('open_transaction')!; // an agent holding on to the tool object (Chrome keeps in-flight runs alive)
    mount.abort();
    registry.setActiveTab('review');
    const out = await tool.execute({ id: 1 }, { signal: new AbortController().signal });
    expect(out).toEqual({ error: { code: 'tab_not_open', message: "The Transactions tab is not open. Call navigate_to_tab with tab='transactions' first." } });
    expect(ran).toBe(false);
  });

  test('L3: a resync that changes nothing registers and unregisters nothing, and keeps the live info objects (no mid-call cancellation)', async () => {
    const { registered, win, resync, changeLog } = await bootBridge({ tools: GRANT, expectRegistered: 1 });
    const registry = (win as any).__wilsonPageTools;
    registry.setActiveTab('transactions');
    mountHandler(registry, 'open_transaction', 'transactions', async () => ({}));
    await until(() => registered.has('open_transaction'));
    const infoBefore = registry.toolInfo('transaction_search');
    expect(infoBefore).toBeDefined();
    expect(['allow', 'ask']).toContain(infoBefore.policy); // the policy rides on the live info
    let notified = 0;
    registry.subscribe(() => { notified += 1; });
    const changes = changeLog.length;
    for (let i = 0; i < 3; i++) await resync();
    expect(changeLog.length).toBe(changes);
    expect(registry.toolInfo('transaction_search')).toBe(infoBefore);
    expect(notified).toBe(0);
  });

  test('L3: a tab tool is not unregistered while a call to it is in flight; it is once the call settles', async () => {
    const { registered, win } = await bootBridge({ tools: GRANT, expectRegistered: 1 });
    const registry = (win as any).__wilsonPageTools;
    registry.setActiveTab('transactions');
    let release: (v: unknown) => void = () => {};
    mountHandler(registry, 'open_transaction', 'transactions', () => new Promise((resolve) => { release = resolve; }));
    await until(() => registered.has('open_transaction'));
    const tx = (await (await bfetch(`http://localhost:${(servers[servers.length - 1] as any).port}/api/transactions?limit=1`)).json() as any[])[0];
    const run = registered.get('open_transaction')!.execute({ id: tx.id }, { signal: new AbortController().signal });
    await new Promise((r) => setTimeout(r, 150)); // the server authorized; the handler is now running
    registry.setActiveTab('review'); // the view flaps away mid-call
    await registry.whenSettled();
    expect(registered.has('open_transaction')).toBe(true); // Chrome would cancel the running call if this were unregistered
    release({ highlighted: true });
    expect(await run).toEqual({ highlighted: true, stale: true });
    await until(() => !registered.has('open_transaction'));
    expect(registered.has('open_transaction')).toBe(false); // deferred, not forgotten
  });

  test('the kill switch unregisters every tool, page tools included, on the next sync', async () => {
    const { db, registered, win, resync } = await bootBridge({ tools: GRANT, expectRegistered: 1 });
    const registry = (win as any).__wilsonPageTools;
    registry.setActiveTab('transactions');
    mountHandler(registry, 'open_transaction', 'transactions', async () => ({}));
    mountHandler(registry, 'navigate_to_tab', 'global', async () => ({}));
    await until(() => registered.size === 3);
    expect(registered.size).toBe(3);
    const { setKillSwitch } = await import('../mcp/engine.js');
    setKillSwitch(db, false);
    try {
      await resync();
      await until(() => registered.size === 0);
      expect(registered.size).toBe(0);
      expect([...registry.liveTools()]).toEqual([]);
    } finally {
      setKillSwitch(db, true);
    }
  });
});

/**
 * The ONE periodic driver is the release's tool-resync scheduler (nextToolSyncDelay): no fixed interval. Kill switch and
 * policy are enforced by the server on every call, so a slow background cadence cannot widen what an agent may do; the
 * events below keep a visible tab current at once.
 */
describe('the bridge sync scheduler', () => {
  test('there is no fixed setInterval', async () => {
    const { intervals } = await bootBridge();
    expect(intervals()).toBe(0);
  });

  test('registered tools are re-checked on the slow 60 s cadence, and only that timer exists', async () => {
    const { sync } = await bootBridge();
    expect(sync.pending()).toEqual([TOOL_SYNC_LIVE_MS]);
  });

  test('a hidden tab runs no timer; becoming visible syncs at once and starts the cadence; hiding stops it again', async () => {
    const { sync, emit, setHidden, toolsFetches, stateFetches } = await bootBridge({ hidden: true });
    expect(sync.pending()).toEqual([]);

    const before = { tools: toolsFetches(), state: stateFetches() };
    setHidden(false);
    emit('document', 'visibilitychange');
    for (let i = 0; i < 50 && toolsFetches() === before.tools; i++) await new Promise((r) => setTimeout(r, 20));
    expect(toolsFetches()).toBeGreaterThan(before.tools);
    expect(stateFetches()).toBeGreaterThan(before.state);
    await new Promise((r) => setTimeout(r, 100));
    expect(sync.pending()).toEqual([TOOL_SYNC_LIVE_MS]);

    setHidden(true);
    emit('document', 'visibilitychange');
    expect(sync.pending()).toEqual([]);
  });

  test('a timer firing while the tab is hidden does not keep the chain alive', async () => {
    const { sync, setHidden } = await bootBridge();
    expect(sync.pending()).toEqual([TOOL_SYNC_LIVE_MS]);
    setHidden(true);
    await sync.fire();
    expect(sync.pending()).toEqual([]);
  });

  test('a browser without WebMCP retries 2 s apart, at most 5 times, then stops', async () => {
    const { sync, registered } = await bootBridge({ noModelContext: true, expectRegistered: 0 });
    expect(registered.size).toBe(0);
    await until(() => sync.pending().length > 0, 2000); // the load-time sync finishes, then the first retry is scheduled
    let fired = 0;
    while (sync.pending().length > 0 && fired < 20) {
      expect(sync.pending()).toEqual([TOOL_SYNC_LATE_REGISTRATION_MS]);
      await sync.fire();
      fired += 1;
    }
    expect(fired).toBe(TOOL_SYNC_LATE_ATTEMPTS);
    expect(sync.pending()).toEqual([]);
  });

  test('window focus syncs at once', async () => {
    const { emit, toolsFetches, stateFetches } = await bootBridge();
    const before = { tools: toolsFetches(), state: stateFetches() };
    emit('window', 'focus');
    for (let i = 0; i < 50 && toolsFetches() === before.tools; i++) await new Promise((r) => setTimeout(r, 20));
    expect(toolsFetches()).toBeGreaterThan(before.tools);
    expect(stateFetches()).toBeGreaterThan(before.state);
  });

  test('a modelContext toolchange refreshes the shared state at once', async () => {
    const { emit, stateFetches } = await bootBridge();
    const before = stateFetches();
    emit('modelContext', 'toolchange');
    for (let i = 0; i < 50 && stateFetches() === before; i++) await new Promise((r) => setTimeout(r, 20));
    expect(stateFetches()).toBeGreaterThan(before);
  });

  test('a kill switch flipped in another tab removes the tools through the channel, not the 60 s cadence', async () => {
    FakeChannel.all = [];
    const { db, registered, sync } = await bootBridge({ broadcastChannel: FakeChannel });
    expect(registered.size).toBe(2);
    expect(sync.pending()).toEqual([TOOL_SYNC_LIVE_MS]); // the slow timer is still waiting: it is never fired below
    const { setKillSwitch } = await import('../mcp/engine.js');
    setKillSwitch(db, false);
    try {
      new FakeChannel(WILSON_AGENT_CHANNEL).postMessage({ type: 'state-changed' });
      await until(() => registered.size === 0, 2000);
      expect(registered.size).toBe(0);
    } finally {
      setKillSwitch(db, true);
    }
  });

  test('after the tools are gone the chain stops (WebMCP available, nothing registered: event-driven only)', async () => {
    FakeChannel.all = [];
    const { db, registered, sync } = await bootBridge({ broadcastChannel: FakeChannel });
    const { setKillSwitch } = await import('../mcp/engine.js');
    setKillSwitch(db, false);
    try {
      new FakeChannel(WILSON_AGENT_CHANNEL).postMessage({ type: 'state-changed' });
      await until(() => registered.size === 0, 2000);
      await new Promise((r) => setTimeout(r, 100));
      expect(sync.pending()).toEqual([]);
    } finally {
      setKillSwitch(db, true);
    }
  });
});

/**
 * Live finding (Chrome 154, hidden tab): after the kill switch or revoke-session, get_page_context, navigate_to_tab and
 * transaction_search stayed in getTools() although the server listed nothing. The tab had granted them twice, and
 * /api/mcp/tools lists a tool once per live grant: the bridge registered both rows, the second registerTool was refused,
 * and the first registration was left with no AbortController, so nothing could ever unregister it. Unregistration never
 * waits for visibility: every event-driven sync runs the full tool sync, hidden or not.
 */
describe('a shrinking live set unregisters at once, hidden or visible (tools granted twice)', () => {
  const GRANT = ['navigate_to_tab', 'get_page_context', 'transaction_search'];

  async function bootGrantedTwice(hidden: boolean, extra: Partial<BootOptions> = {}) {
    // Boot with nothing granted, then grant the tools twice (two live rows per tool) while the tab is in its final state.
    const boot = await bootBridge({ tools: GRANT, expectRegistered: 0, hidden, ...extra });
    const post = (path: string, body: unknown) =>
      bfetch(boot.base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', [SESSION_HEADER]: boot.session }, body: JSON.stringify(body) });
    await post('/api/mcp/grants', { tools: GRANT });
    const registry = (boot.win as any).__wilsonPageTools;
    registry.setActiveTab('forecast');
    mountHandler(registry, 'navigate_to_tab', 'global', async () => ({}));
    mountHandler(registry, 'get_page_context', 'global', async () => ({}));
    await boot.resync();
    await until(() => boot.registered.size === 3);
    expect([...boot.registered.keys()].sort()).toEqual([...GRANT].sort());
    const live = (await (await bfetch(boot.base + '/api/mcp/tools', { headers: { [SESSION_HEADER]: boot.session } })).json()) as { tools: { name: string }[] };
    expect(live.tools.length).toBe(6); // the server lists each tool once per live grant
    return { ...boot, post, registry };
  }

  const shrinkers: Array<[string, (b: Awaited<ReturnType<typeof bootGrantedTwice>>) => Promise<() => void>]> = [
    ['the kill switch', async (b) => {
      const { setKillSwitch } = await import('../mcp/engine.js');
      setKillSwitch(b.db, false);
      return () => setKillSwitch(b.db, true);
    }],
    ['revoke-session', async (b) => {
      expect((await b.post('/api/mcp/grants/revoke-session', {})).status).toBe(200);
      return () => {};
    }],
    ['policy Off', async (b) => {
      for (const tool of GRANT) {
        const res = await bfetch(`${b.base}/api/mcp/policies/${tool}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', [SESSION_HEADER]: b.session }, body: JSON.stringify({ policy: 'off' }) });
        expect(res.status).toBe(200);
      }
      return () => {};
    }],
    ['a 401 sync', async (b) => { b.failTools.status = 401; return () => {}; }],
    ['a 403 sync', async (b) => { b.failTools.status = 403; return () => {}; }],
  ];

  for (const hidden of [true, false]) {
    for (const [label, shrink] of shrinkers) {
      test(`${hidden ? 'hidden' : 'visible'} tab: ${label} aborts every imperative registration on the next event-driven sync`, async () => {
        const b = await bootGrantedTwice(hidden);
        const restore = await shrink(b);
        try {
          await b.resync(); // wilson:agent-grants-changed
          await until(() => b.registered.size === 0, 1500);
          expect([...b.registered.keys()]).toEqual([]);
          expect([...b.registry.liveTools()]).toEqual([]);
        } finally {
          restore();
        }
      });
    }
  }

  test('hidden tab: the kill switch flipped in another tab removes every registration through the channel', async () => {
    FakeChannel.all = [];
    const b = await bootGrantedTwice(true, { broadcastChannel: FakeChannel });
    const { setKillSwitch } = await import('../mcp/engine.js');
    setKillSwitch(b.db, false);
    try {
      new FakeChannel(WILSON_AGENT_CHANNEL).postMessage({ type: 'state-changed' });
      await until(() => b.registered.size === 0, 1500);
      expect([...b.registered.keys()]).toEqual([]);
    } finally {
      setKillSwitch(b.db, true);
    }
  });

  test('the next scheduled sync (the 60 s timer) also removes them', async () => {
    const b = await bootGrantedTwice(false);
    expect(b.sync.pending()).toEqual([TOOL_SYNC_LIVE_MS]);
    expect((await b.post('/api/mcp/grants/revoke-session', {})).status).toBe(200);
    await b.sync.fire();
    await until(() => b.registered.size === 0, 1500);
    expect([...b.registered.keys()]).toEqual([]);
  });

  test('hidden tab: a call in flight does not keep a tool the server stopped listing', async () => {
    const b = await bootGrantedTwice(true);
    let release: (v: unknown) => void = () => {};
    mountHandler(b.registry, 'get_page_context', 'global', () => new Promise((resolve) => { release = resolve; }));
    await new Promise((r) => setTimeout(r, 80)); // the remount's reconcile (same name, nothing to register)
    const run = b.registered.get('get_page_context')!.execute({}, { signal: new AbortController().signal });
    await new Promise((r) => setTimeout(r, 150)); // authorized by the server; the handler is running
    expect((await b.post('/api/mcp/grants/revoke-session', {})).status).toBe(200);
    await b.resync();
    await until(() => b.registered.size === 0, 1500);
    expect([...b.registered.keys()]).toEqual([]); // not deferred: only a still-live tool waits for its call
    release({ ok: true });
    await run;
  });
});

describe('event-driven syncs run the full tool sync while the tab is hidden', () => {
  test('a grants-changed event, a state-changed event and a channel message each refetch /api/mcp/tools in a hidden tab', async () => {
    FakeChannel.all = [];
    const b = await bootBridge({ hidden: true, broadcastChannel: FakeChannel });
    const triggers: Array<[string, () => void]> = [
      ['grants-changed', () => { void b.resync(); }],
      ['state-changed', () => b.emit('window', WILSON_AGENT_STATE_CHANGED_EVENT)],
      ['channel', () => new FakeChannel(WILSON_AGENT_CHANNEL).postMessage({ type: 'state-changed' })],
    ];
    for (const [label, fire] of triggers) {
      const before = b.toolsFetches();
      fire();
      await until(() => b.toolsFetches() > before, 1000);
      expect({ label, refetched: b.toolsFetches() > before }).toEqual({ label, refetched: true });
    }
    await new Promise((r) => setTimeout(r, 100));
    expect(b.sync.pending()).toEqual([]); // and still no timer while hidden
  });

  test('a grant made by the raw API in a hidden tab is registered by the next event, not by a timer', async () => {
    const b = await bootBridge({ hidden: true, tools: ['edit_transaction'], expectRegistered: 1 });
    expect(b.sync.pending()).toEqual([]);
    await bfetch(b.base + '/api/mcp/grants', { method: 'POST', headers: { 'Content-Type': 'application/json', [SESSION_HEADER]: b.session }, body: JSON.stringify({ tools: ['transaction_search'] }) });
    await new Promise((r) => setTimeout(r, 100));
    expect([...b.registered.keys()]).toEqual(['edit_transaction']); // paused by design while hidden
    await b.resync();
    await until(() => b.registered.size === 2);
    expect([...b.registered.keys()].sort()).toEqual(['edit_transaction', 'transaction_search']);
  });
});
