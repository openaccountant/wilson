import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  callServerTool, callServerToolAnswer, createReconcileScheduler, desiredTools, executePageTool, reconcile, registerLiveTools,
  liveToolsSignature, SESSION_HEADER, type ServerCallDeps, type LiveToolDescriptor, type PageToolRuntime,
} from '../dashboard/webmcp-bridge-core.js';
import { getPageRegistry } from '../dashboard/webmcp-page-registry.js';
import { MCP_TOOL_CATALOG, jsonSchemaFor, tabOpenHint, toolAnnotations } from '../mcp/tool-catalog.js';

/**
 * The bridge's decision logic lives in an import-free core so it can be
 * tested without a browser: which tools to (un)register, and how a call to
 * the server's single tool endpoint becomes either data or a polled outcome.
 */

const SESSION = '3b241101-e2bb-4255-8caf-4136c566a962';

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: any;
  signal: AbortSignal | null | undefined;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** A fake server: `routes` maps "METHOD path" to a response, or to a queue of responses served in order. */
function fakeServer(routes: Record<string, Response | Response[] | (() => Response)>) {
  const calls: Recorded[] = [];
  const fetchFn = async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({
      url,
      method,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      signal: init?.signal,
    });
    const route = routes[`${method} ${url}`];
    if (!route) return jsonResponse({ error: { code: 'not_found', message: 'no such route' } }, 404);
    if (typeof route === 'function') return route();
    if (Array.isArray(route)) return (route.length > 1 ? route.shift() : route[0])!.clone();
    return route.clone();
  };
  return { calls, fetchFn: fetchFn as ServerCallDeps['fetch'] };
}

function deps(fetchFn: ServerCallDeps['fetch'], extra: Partial<ServerCallDeps> = {}): ServerCallDeps {
  let t = 0;
  return {
    fetch: fetchFn,
    sessionGeneration: SESSION,
    authHeaders: () => ({ Authorization: 'Bearer dash-token' }),
    now: () => t,
    sleep: async (ms) => { t += ms; },
    pollIntervalMs: 800,
    timeoutMs: 5000,
    ...extra,
  };
}

const call = { grantId: '11111111-1111-4111-8111-111111111111', tool: 'some_tool', args: { a: 1 } };

describe('reconcile', () => {
  test('reconcile diff: register what is missing, abort what is gone, leave the rest', () => {
    expect(reconcile(['a', 'b'], ['b', 'c'])).toEqual({ toRegister: ['a'], toAbort: ['c'] });
    expect(reconcile([], ['x', 'y'])).toEqual({ toRegister: [], toAbort: ['x', 'y'] });
    expect(reconcile(['x'], [])).toEqual({ toRegister: ['x'], toAbort: [] });
    expect(reconcile(['a', 'b'], ['a', 'b'])).toEqual({ toRegister: [], toAbort: [] });
    expect(reconcile(['a', 'a'], [])).toEqual({ toRegister: ['a'], toAbort: [] });
  });

  test('works on iterables (Map keys, Sets)', () => {
    expect(reconcile(new Set(['a']), new Map([['b', 1]]).keys())).toEqual({ toRegister: ['a'], toAbort: ['b'] });
  });
});

describe('callServerTool', () => {
  test("a {kind:'read'} answer is returned as data", async () => {
    const { calls, fetchFn } = fakeServer({ 'POST /api/mcp/call': jsonResponse({ kind: 'read', data: { total: 2 } }) });
    expect(await callServerTool(deps(fetchFn), call)).toEqual({ total: 2 });
    expect(calls).toHaveLength(1);
  });

  test('the call goes to the one endpoint with the session in a header, never in the body or URL', async () => {
    const { calls, fetchFn } = fakeServer({ 'POST /api/mcp/call': jsonResponse({ kind: 'read', data: {} }) });
    await callServerTool(deps(fetchFn), call);
    expect(calls[0].url).toBe('/api/mcp/call');
    expect(calls[0].headers[SESSION_HEADER]).toBe(SESSION);
    expect(calls[0].headers.Authorization).toBe('Bearer dash-token');
    expect(calls[0].headers['Content-Type']).toBe('application/json');
    expect(calls[0].body).toEqual({ grantId: call.grantId, tool: 'some_tool', args: { a: 1 }, transport: 'imperative' });
    expect(JSON.stringify(calls[0].body)).not.toContain(SESSION);
    expect(calls[0].url).not.toContain(SESSION);
  });

  test("callServerTool maps {kind:'operation'} to poll and returns outcome", async () => {
    const pending = { id: 'op1', status: 'pending' };
    const done = { id: 'op1', status: 'committed', result: { id: 7, category: 'Dining' } };
    const { calls, fetchFn } = fakeServer({
      'POST /api/mcp/call': jsonResponse({ kind: 'operation', operation: pending }),
      'GET /api/mcp/operations/op1?view=agent': [jsonResponse({ operation: pending }), jsonResponse({ operation: pending }), jsonResponse({ operation: done })],
    });
    const out = await callServerTool(deps(fetchFn), call);
    expect(out).toEqual({ outcome: 'committed', operationId: 'op1', result: { id: 7, category: 'Dining' } });
    expect(calls.filter((c) => c.method === 'GET')).toHaveLength(3);
    for (const c of calls) expect(c.headers[SESSION_HEADER]).toBe(SESSION);
  });

  test('rejected, stale and expired outcomes are returned as they are', async () => {
    for (const status of ['rejected', 'stale', 'expired']) {
      const { fetchFn } = fakeServer({
        'POST /api/mcp/call': jsonResponse({ kind: 'operation', operation: { id: 'op1', status: 'pending' } }),
        'GET /api/mcp/operations/op1?view=agent': jsonResponse({ operation: { id: 'op1', status } }),
      });
      expect(await callServerTool(deps(fetchFn), call)).toEqual({ outcome: status, operationId: 'op1', result: undefined });
    }
  });

  test('a read the user was asked to allow: once allowed, the agent gets the data itself, as a direct read would return it', async () => {
    const pending = { id: 'op1', status: 'pending', kind: 'read' };
    const done = { id: 'op1', status: 'committed', kind: 'read', data: { items: [{ id: 1 }], total: 1 } };
    const { fetchFn } = fakeServer({
      'POST /api/mcp/call': jsonResponse({ kind: 'operation', operation: pending }),
      'GET /api/mcp/operations/op1?view=agent': [jsonResponse({ operation: pending }), jsonResponse({ operation: done })],
    });
    expect(await callServerTool(deps(fetchFn), call)).toEqual({ items: [{ id: 1 }], total: 1 });
  });

  test('a read the user rejected, or that went stale, returns the outcome and never data', async () => {
    for (const status of ['rejected', 'stale', 'expired']) {
      const { fetchFn } = fakeServer({
        'POST /api/mcp/call': jsonResponse({ kind: 'operation', operation: { id: 'op1', status: 'pending', kind: 'read' } }),
        'GET /api/mcp/operations/op1?view=agent': jsonResponse({ operation: { id: 'op1', status, kind: 'read' } }),
      });
      expect(await callServerTool(deps(fetchFn), call)).toEqual({ outcome: status, operationId: 'op1', result: undefined });
    }
  });

  test('a read whose data was already delivered says so instead of returning nothing', async () => {
    const { fetchFn } = fakeServer({
      'POST /api/mcp/call': jsonResponse({ kind: 'operation', operation: { id: 'op1', status: 'pending', kind: 'read' } }),
      'GET /api/mcp/operations/op1?view=agent': jsonResponse({ operation: { id: 'op1', status: 'committed', kind: 'read' } }),
    });
    const out = (await callServerTool(deps(fetchFn), call)) as any;
    expect(out).toMatchObject({ outcome: 'committed', operationId: 'op1' });
    expect(out.reason).toContain('already delivered');
  });

  test('a transient failure while polling does not end the wait', async () => {
    let n = 0;
    const { fetchFn } = fakeServer({
      'POST /api/mcp/call': jsonResponse({ kind: 'operation', operation: { id: 'op1', status: 'pending' } }),
      'GET /api/mcp/operations/op1?view=agent': () => {
        n++;
        if (n === 1) throw new Error('network down');
        return jsonResponse({ operation: { id: 'op1', status: 'committed' } });
      },
    });
    expect((await callServerTool(deps(fetchFn), call) as any).outcome).toBe('committed');
  });

  test('no resolution within the window returns an unknown outcome the agent can reconcile by id', async () => {
    const { fetchFn } = fakeServer({
      'POST /api/mcp/call': jsonResponse({ kind: 'operation', operation: { id: 'op1', status: 'pending' } }),
      'GET /api/mcp/operations/op1?view=agent': jsonResponse({ operation: { id: 'op1', status: 'pending' } }),
    });
    const out = (await callServerTool(deps(fetchFn, { timeoutMs: 3000 }), call)) as any;
    expect(out.outcome).toBe('unknown');
    expect(out.operationId).toBe('op1');
    expect(out.reason).toContain('approval window');
  });

  test('abort during poll POSTs cancel and rejects with an AbortError', async () => {
    const controller = new AbortController();
    const { calls, fetchFn } = fakeServer({
      'POST /api/mcp/call': jsonResponse({ kind: 'operation', operation: { id: 'op1', status: 'pending' } }),
      'GET /api/mcp/operations/op1?view=agent': jsonResponse({ operation: { id: 'op1', status: 'pending' } }),
      'POST /api/mcp/operations/op1/cancel': jsonResponse({ outcome: 'cancelled' }),
    });
    let sleeps = 0;
    const d = deps(fetchFn, {
      sleep: async () => {
        sleeps++;
        if (sleeps === 2) controller.abort();
      },
    });
    await expect(callServerTool(d, call, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    const cancel = calls.find((c) => c.url === '/api/mcp/operations/op1/cancel');
    expect(cancel).toBeDefined();
    expect(cancel!.method).toBe('POST');
    expect(cancel!.headers[SESSION_HEADER]).toBe(SESSION);
    // No further polling after the abort.
    const lastGetIndex = calls.map((c) => c.method + c.url).lastIndexOf('GET/api/mcp/operations/op1');
    expect(calls.indexOf(cancel!)).toBeGreaterThan(lastGetIndex);
  });

  test('a failed cancel does not mask the abort', async () => {
    const controller = new AbortController();
    const { fetchFn } = fakeServer({
      'POST /api/mcp/call': jsonResponse({ kind: 'operation', operation: { id: 'op1', status: 'pending' } }),
      'GET /api/mcp/operations/op1?view=agent': jsonResponse({ operation: { id: 'op1', status: 'pending' } }),
      'POST /api/mcp/operations/op1/cancel': () => { throw new Error('offline'); },
    });
    const d = deps(fetchFn, { sleep: async () => controller.abort() });
    await expect(callServerTool(d, call, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });

  test('the signal is passed to fetch, and an already-aborted signal makes no request', async () => {
    const controller = new AbortController();
    const { calls, fetchFn } = fakeServer({ 'POST /api/mcp/call': jsonResponse({ kind: 'read', data: 1 }) });
    await callServerTool(deps(fetchFn), call, controller.signal);
    expect(calls[0].signal).toBe(controller.signal);

    const aborted = new AbortController();
    aborted.abort();
    const second = fakeServer({ 'POST /api/mcp/call': jsonResponse({ kind: 'read', data: 1 }) });
    await expect(callServerTool(deps(second.fetchFn), call, aborted.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(second.calls).toHaveLength(0);
  });

  test('a server error becomes an Error carrying the actionable message and hint', async () => {
    const { fetchFn } = fakeServer({
      'POST /api/mcp/call': jsonResponse({ error: { code: 'invalid_args', message: 'update_transaction: amount must be a number. Example: {"id":42}', hint: 'Fix the amount.' } }, 400),
    });
    await expect(callServerTool(deps(fetchFn), call)).rejects.toThrow('amount must be a number');
    await expect(callServerTool(deps(fetchFn), call)).rejects.toThrow('Fix the amount.');
  });

  test('a non-JSON error body still produces a readable Error', async () => {
    const { fetchFn } = fakeServer({ 'POST /api/mcp/call': () => new Response('upstream exploded', { status: 502 }) });
    await expect(callServerTool(deps(fetchFn), call)).rejects.toThrow('502');
  });

  test('a body without a kind is an error, not silent success', async () => {
    const { fetchFn } = fakeServer({ 'POST /api/mcp/call': jsonResponse({ unexpected: true }) });
    await expect(callServerTool(deps(fetchFn), call)).rejects.toThrow();
  });
});

describe('declarative and page answers', () => {
  test("a {kind:'page'} answer returns the server's page data, or an authorized marker when there is none", async () => {
    const withData = fakeServer({ 'POST /api/mcp/call': jsonResponse({ kind: 'page', pageData: { rows: 3 } }) });
    expect(await callServerTool(deps(withData.fetchFn), call)).toEqual({ rows: 3 });
    const bare = fakeServer({ 'POST /api/mcp/call': jsonResponse({ kind: 'page' }) });
    expect(await callServerTool(deps(bare.fetchFn), call)).toEqual({ authorized: true });
  });

  test('the client-reported transport rides in the body for a declarative call, and the session still travels in a header', async () => {
    const { calls, fetchFn } = fakeServer({ 'POST /api/mcp/call': jsonResponse({ kind: 'read', data: {} }) });
    await callServerTool(deps(fetchFn), { ...call, transport: 'declarative' });
    expect(calls[0].body.transport).toBe('declarative');
    expect(calls[0].headers[SESSION_HEADER]).toBe(SESSION);
  });

  test('a declarative mutating call resolves only after the human answered, never to "submitted"', async () => {
    const pending = { id: 'op9', status: 'pending' };
    const { fetchFn } = fakeServer({
      'POST /api/mcp/call': jsonResponse({ kind: 'operation', operation: pending }),
      'GET /api/mcp/operations/op9?view=agent': [jsonResponse({ operation: pending }), jsonResponse({ operation: { id: 'op9', status: 'rejected' } })],
    });
    const out = (await callServerTool(deps(fetchFn), { ...call, transport: 'declarative' })) as { outcome: string };
    expect(out.outcome).toBe('rejected');
  });

  test('no answer inside the approval window resolves to outcome unknown with the operation id and the card-still-open reason', async () => {
    const pending = { id: 'op8', status: 'pending' };
    const { fetchFn } = fakeServer({
      'POST /api/mcp/call': jsonResponse({ kind: 'operation', operation: pending }),
      'GET /api/mcp/operations/op8?view=agent': jsonResponse({ operation: pending }),
    });
    const out = (await callServerTool(deps(fetchFn, { timeoutMs: 2000 }), call)) as { outcome: string; operationId: string; reason: string };
    expect(out).toEqual({ outcome: 'unknown', operationId: 'op8', reason: 'No response within the approval window — the card is still open.' });
  });
});

describe('registerLiveTools (what the bridge hands to registerTool)', () => {
  /** What /api/mcp/tools says, built from the real catalog so the exposure flags are the server's. */
  function liveFromCatalog(names: string[]): LiveToolDescriptor[] {
    return names.map((name) => {
      const def = MCP_TOOL_CATALOG.find((d) => d.name === name)!;
      return {
        name,
        description: def.description,
        inputSchema: jsonSchemaFor(name),
        annotations: toolAnnotations(name),
        classification: def.classification,
        exposure: def.exposure,
        autosubmit: def.autosubmit === true,
        surface: def.surface,
        ...(def.surface === 'global' ? {} : { openHint: tabOpenHint(def.surface.tab) }),
        grantId: `grant-${name}`,
      };
    });
  }

  function harness(
    tools: LiveToolDescriptor[],
    registered = new Map<string, AbortController>(),
    view: { activeTab?: string; hasHandler?: (name: string) => boolean } = {}
  ) {
    const registeredNames: string[] = [];
    const run = async () =>
      registerLiveTools({
        tools,
        registered,
        ...view,
        registerTool: async (tool) => { registeredNames.push(tool.name); },
        makeExecute: () => async () => 'ran',
      });
    return { registeredNames, registered, run };
  }

  test('a registerTool that never settles cannot block the pass: it is aborted, dropped, and later passes still abort the rest', async () => {
    const tools = [
      { ...liveFromCatalog(['search_transactions'])[0] },
      { ...liveFromCatalog(['get_spending_summary'])[0] },
    ];
    const registered = new Map<string, AbortController>();
    const signals = new Map<string, AbortSignal>();
    const run = (live: LiveToolDescriptor[]) =>
      registerLiveTools({
        tools: live,
        registered,
        registerTimeoutMs: 20,
        registerTool: (tool, options) => {
          signals.set(tool.name, options.signal);
          return tool.name === 'get_spending_summary' ? new Promise(() => {}) : Promise.resolve(undefined);
        },
        makeExecute: () => async () => 'ran',
      });
    const started = Date.now();
    await run(tools); // would hang forever without the timeout
    expect(Date.now() - started).toBeLessThan(2000);
    expect(registered.has('search_transactions')).toBe(true);
    // The hung one was given up on: aborted (if it ever settles it unregisters) and forgotten, so the next pass retries it.
    expect(signals.get('get_spending_summary')!.aborted).toBe(true);
    expect(registered.has('get_spending_summary')).toBe(false);
    // The kill switch case: the live set empties, and the next pass aborts what was registered.
    await run([]);
    expect(signals.get('search_transactions')!.aborted).toBe(true);
    expect(registered.size).toBe(0);
  });

  test('declarative-exposure tools are never passed to registerTool', async () => {
    const all = MCP_TOOL_CATALOG.filter((d) => d.transports.includes('webmcp')).map((d) => d.name);
    // Every tab showing in turn, with every page handler mounted: still no declarative tool is ever registered.
    const seen = new Set<string>();
    for (const tab of ['transactions', 'review', 'goals', 'forecast', 'llm']) {
      const h = harness(liveFromCatalog(all), new Map(), { activeTab: tab, hasHandler: () => true });
      await h.run();
      h.registeredNames.forEach((n) => seen.add(n));
    }
    const declarative = MCP_TOOL_CATALOG.filter((d) => d.exposure === 'declarative').map((d) => d.name);
    expect(declarative.length).toBeGreaterThanOrEqual(5);
    for (const name of declarative) expect(seen.has(name), name).toBe(false);
    for (const name of MCP_TOOL_CATALOG.filter((d) => d.exposure === 'imperative' && d.transports.includes('webmcp')).map((d) => d.name)) {
      expect(seen.has(name), name).toBe(true);
    }
  });

  test('no tool name is registered both imperatively and declaratively', () => {
    const imperative = new Set(MCP_TOOL_CATALOG.filter((d) => d.exposure === 'imperative').map((d) => d.name));
    for (const def of MCP_TOOL_CATALOG.filter((d) => d.exposure === 'declarative')) expect(imperative.has(def.name)).toBe(false);
    // And every catalog tool declares exactly one exposure.
    for (const def of MCP_TOOL_CATALOG) expect(['imperative', 'declarative']).toContain(def.exposure);
  });

  test('a tool that stops being live is aborted; a declarative one that was never registered is left alone', async () => {
    const registered = new Map<string, AbortController>();
    const first = harness(liveFromCatalog(['search_transactions', 'resolve_review_item']), registered);
    await first.run();
    expect([...registered.keys()]).toEqual(['search_transactions']);
    const controller = registered.get('search_transactions')!;
    const second = harness(liveFromCatalog(['resolve_review_item']), registered);
    await second.run();
    expect(controller.signal.aborted).toBe(true);
    expect(registered.size).toBe(0);
  });

  test('a registerTool that rejects leaves the tool unregistered so the next sync retries', async () => {
    const registered = new Map<string, AbortController>();
    await registerLiveTools({
      tools: liveFromCatalog(['search_transactions']),
      registered,
      registerTool: async () => { throw new Error('NotAllowedError'); },
      makeExecute: () => async () => 'ran',
    });
    expect(registered.size).toBe(0);
  });

  test('liveToolsSignature changes with the live set or a schema, not with order', () => {
    const a = liveFromCatalog(['resolve_review_item', 'set_budget']);
    const b = liveFromCatalog(['set_budget', 'resolve_review_item']);
    expect(liveToolsSignature(a)).toBe(liveToolsSignature(b));
    expect(liveToolsSignature(a)).not.toBe(liveToolsSignature(liveFromCatalog(['set_budget'])));
  });
});

describe('desiredTools (live ∧ imperative ∧ on this surface ∧ has a handler)', () => {
  const tool = (name: string, extra: Partial<LiveToolDescriptor> = {}): LiveToolDescriptor => ({
    name,
    description: name,
    inputSchema: {},
    classification: 'read',
    exposure: 'imperative',
    autosubmit: false,
    surface: 'global',
    grantId: `grant-${name}`,
    ...extra,
  });

  test('a global tool is wanted on every tab and with none showing', () => {
    const tools = [tool('g')];
    expect(desiredTools(tools, {}).map((t) => t.name)).toEqual(['g']);
    expect(desiredTools(tools, { activeTab: 'goals' }).map((t) => t.name)).toEqual(['g']);
  });

  test("a tab's tool is wanted only while that tab shows", () => {
    const tools = [tool('t', { surface: { tab: 'review' } })];
    expect(desiredTools(tools, {})).toEqual([]);
    expect(desiredTools(tools, { activeTab: 'transactions' })).toEqual([]);
    expect(desiredTools(tools, { activeTab: 'review' }).map((t) => t.name)).toEqual(['t']);
  });

  test('a page tool also needs a mounted handler; a server read does not', () => {
    const page = tool('p', { classification: 'page' });
    const read = tool('r');
    expect(desiredTools([page, read], { hasHandler: () => false }).map((t) => t.name)).toEqual(['r']);
    expect(desiredTools([page, read], { hasHandler: (n) => n === 'p' }).map((t) => t.name)).toEqual(['p', 'r']);
    // No view of the handlers at all (the React build is not there): a page tool has nothing to run.
    expect(desiredTools([page], {})).toEqual([]);
  });

  test('declarative tools are never wanted', () => {
    expect(desiredTools([tool('d', { exposure: 'declarative' })], { activeTab: 'goals', hasHandler: () => true })).toEqual([]);
  });

  test('a descriptor from a server that sends no surface counts as global', () => {
    const old = { ...tool('o'), surface: undefined } as unknown as LiveToolDescriptor;
    expect(desiredTools([old], { activeTab: 'goals' }).map((t) => t.name)).toEqual(['o']);
  });
});

/** A stand-in for document.modelContext: registerTool with a signal, duplicates refused, `toolchange` counted. */
class FakeModelContext {
  readonly tools = new Map<string, { signal: AbortSignal }>();
  toolchange = 0;
  async registerTool(tool: { name: string }, options: { signal: AbortSignal }): Promise<undefined> {
    if (this.tools.has(tool.name)) throw new Error(`InvalidStateError: ${tool.name} is already registered`);
    this.tools.set(tool.name, { signal: options.signal });
    this.toolchange++;
    options.signal.addEventListener('abort', () => {
      if (this.tools.delete(tool.name)) this.toolchange++;
    });
    return undefined;
  }
  names(): string[] {
    return [...this.tools.keys()].sort();
  }
}

describe('tab-scoped registration (the bridge owns registerTool)', () => {
  const live = (names: string[]): LiveToolDescriptor[] =>
    names.map((name) => {
      const def = MCP_TOOL_CATALOG.find((d) => d.name === name)!;
      return {
        name,
        description: def.description,
        inputSchema: jsonSchemaFor(name),
        classification: def.classification,
        exposure: def.exposure,
        autosubmit: def.autosubmit === true,
        surface: def.surface,
        ...(def.surface === 'global' ? {} : { openHint: tabOpenHint(def.surface.tab) }),
        grantId: `grant-${name}`,
      };
    });

  const GRANTED = ['open_tab', 'get_page_context', 'open_transaction', 'list_review_items', 'open_review_item', 'search_transactions'];

  function bridge(granted: string[]) {
    const mc = new FakeModelContext();
    const registered = new Map<string, AbortController>();
    const handlers = new Set<string>();
    let tools = live(granted);
    let activeTab: string | undefined;
    const reconcileNow = () =>
      registerLiveTools({
        tools,
        registered,
        activeTab,
        hasHandler: (name) => handlers.has(name),
        registerTool: (tool, options) => mc.registerTool(tool, options),
        makeExecute: () => async () => 'ran',
      });
    return {
      mc,
      registered,
      reconcileNow,
      mount: (...names: string[]) => names.forEach((n) => handlers.add(n)),
      unmount: (...names: string[]) => names.forEach((n) => handlers.delete(n)),
      setTab: (tab: string) => { activeTab = tab; },
      setTools: (next: string[]) => { tools = live(next); },
    };
  }

  test("tab change aborts the old tab's tools and registers the new tab's live tools in one reconcile", async () => {
    const b = bridge(GRANTED);
    b.mount('open_tab', 'get_page_context', 'open_transaction', 'open_review_item');
    b.setTab('transactions');
    await b.reconcileNow();
    expect(b.mc.names()).toEqual(['get_page_context', 'open_tab', 'open_transaction', 'search_transactions']);
    const globalController = b.registered.get('open_tab')!;
    const oldTabController = b.registered.get('open_transaction')!;

    const before = b.mc.toolchange;
    b.unmount('open_transaction'); // the old tab's component unmounted...
    b.setTab('review'); //            ...and the new one is showing
    await b.reconcileNow(); //        ONE reconcile does both halves
    expect(oldTabController.signal.aborted).toBe(true);
    expect(b.mc.names()).toEqual(['get_page_context', 'list_review_items', 'open_review_item', 'open_tab', 'search_transactions']);
    // The global tools were not touched: same controllers, never re-registered.
    expect(b.registered.get('open_tab')).toBe(globalController);
    expect(globalController.signal.aborted).toBe(false);
    // toolchange: one removal and two additions, nothing else.
    expect(b.mc.toolchange - before).toBe(3);
  });

  test('a repeat reconcile with nothing changed registers and aborts nothing (no duplicate-registration errors)', async () => {
    const b = bridge(GRANTED);
    b.mount('open_tab', 'get_page_context');
    b.setTab('overview');
    await b.reconcileNow();
    const changes = b.mc.toolchange;
    await b.reconcileNow();
    await b.reconcileNow();
    expect(b.mc.toolchange).toBe(changes);
  });

  test('an ungranted page tool is never registered, whatever tab shows and whatever handlers are mounted', async () => {
    const b = bridge(['search_transactions']); // no grant for any page tool
    b.mount('open_tab', 'get_page_context', 'open_transaction', 'open_review_item');
    for (const tab of ['overview', 'transactions', 'review', 'llm']) {
      b.setTab(tab);
      await b.reconcileNow();
      expect(b.mc.names()).toEqual(['search_transactions']);
    }
  });

  test('a granted page tool without a mounted handler is not registered, and appears once its handler does', async () => {
    const b = bridge(GRANTED);
    b.setTab('transactions');
    await b.reconcileNow();
    expect(b.mc.names()).toEqual(['search_transactions']);
    b.mount('open_transaction');
    await b.reconcileNow();
    expect(b.mc.names()).toEqual(['open_transaction', 'search_transactions']);
  });

  test('the kill switch (the server answers no tools) aborts everything, page tools included', async () => {
    const b = bridge(GRANTED);
    b.mount('open_tab', 'get_page_context', 'open_transaction');
    b.setTab('transactions');
    await b.reconcileNow();
    expect(b.mc.names().length).toBeGreaterThan(3);
    const controllers = [...b.registered.values()];
    b.setTools([]);
    await b.reconcileNow();
    expect(b.mc.names()).toEqual([]);
    expect(b.registered.size).toBe(0);
    for (const c of controllers) expect(c.signal.aborted).toBe(true);
  });

  test("a revoked grant for one tab tool aborts just that tool", async () => {
    const b = bridge(GRANTED);
    b.mount('open_transaction', 'open_tab');
    b.setTab('transactions');
    await b.reconcileNow();
    b.setTools(GRANTED.filter((n) => n !== 'open_transaction'));
    await b.reconcileNow();
    expect(b.mc.names()).toEqual(['open_tab', 'search_transactions']);
  });

  test('an unregistered-then-needed tool is registered fresh (a tab revisited)', async () => {
    const b = bridge(GRANTED);
    b.mount('open_review_item');
    b.setTab('review');
    await b.reconcileNow();
    b.setTab('overview');
    await b.reconcileNow();
    expect(b.mc.names()).toEqual(['search_transactions']);
    b.setTab('review');
    await b.reconcileNow();
    expect(b.mc.names()).toEqual(['list_review_items', 'open_review_item', 'search_transactions']);
  });
});

describe('createReconcileScheduler', () => {
  function fakeTimers() {
    let next = 1;
    const pending = new Map<number, () => void>();
    return {
      setTimer: (fn: () => void, _ms: number) => { const id = next++; pending.set(id, fn); return id; },
      clearTimer: (id: unknown) => { pending.delete(id as number); },
      fire: () => { const fns = [...pending.values()]; pending.clear(); fns.forEach((fn) => fn()); },
      count: () => pending.size,
    };
  }

  test('many requests inside the debounce window become one run', async () => {
    const timers = fakeTimers();
    let runs = 0;
    const s = createReconcileScheduler({ run: async () => { runs++; }, ...timers });
    s.request(); s.request(); s.request();
    expect(timers.count()).toBe(1);
    expect(runs).toBe(0);
    timers.fire();
    await s.settled();
    expect(runs).toBe(1);
  });

  test('flush runs now, cancels the pending timer, and resolves after the run', async () => {
    const timers = fakeTimers();
    let runs = 0;
    const s = createReconcileScheduler({ run: async () => { runs++; }, ...timers });
    s.request();
    await s.flush();
    expect(runs).toBe(1);
    expect(timers.count()).toBe(0);
    timers.fire();
    await s.settled();
    expect(runs).toBe(1);
  });

  test('runs never overlap: a request during a run waits its turn', async () => {
    const timers = fakeTimers();
    const log: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let n = 0;
    const s = createReconcileScheduler({
      run: async () => {
        const id = ++n;
        log.push(`start${id}`);
        if (id === 1) await gate;
        log.push(`end${id}`);
      },
      ...timers,
    });
    const first = s.flush();
    const second = s.flush();
    await Promise.resolve();
    expect(log).toEqual(['start1']);
    release();
    await Promise.all([first, second]);
    expect(log).toEqual(['start1', 'end1', 'start2', 'end2']);
  });

  test('a run that throws does not stop later runs', async () => {
    const timers = fakeTimers();
    let n = 0;
    const s = createReconcileScheduler({ run: async () => { n++; if (n === 1) throw new Error('boom'); }, ...timers });
    await s.flush();
    await s.flush();
    expect(n).toBe(2);
  });
});

describe('executePageTool (what a registered page tool does when the agent calls it)', () => {
  const tabTool = { name: 'open_transaction', surface: { tab: 'transactions' } as const, openHint: tabOpenHint('transactions') };
  const globalTool = { name: 'open_tab', surface: 'global' as const };
  const authorized = (pageData?: unknown) => async () => ({ type: 'page' as const, pageData });

  function runtimeWith(entries: Record<string, { tab: string; handler: (args: any, ctx: any) => Promise<unknown>; signal?: AbortSignal }>, active = 'transactions') {
    const state = { active };
    const runtime: PageToolRuntime = {
      activeTab: () => state.active,
      getHandler: (name) => {
        const e = entries[name];
        if (!e) return undefined;
        return { tab: e.tab, handler: e.handler, signal: e.signal ?? new AbortController().signal };
      },
    };
    return { runtime, state };
  }

  test('runs the handler with the signal and the server pageData, and returns its answer', async () => {
    let seen: any;
    const { runtime } = runtimeWith({ open_transaction: { tab: 'transactions', handler: async (args, ctx) => { seen = { args, ctx }; return { id: 7, highlighted: true }; } } });
    const controller = new AbortController();
    const out = await executePageTool({ tool: tabTool, args: { id: 7 }, signal: controller.signal, serverCall: authorized({ id: 7, desc: 'Coffee' }), runtime });
    expect(out).toEqual({ id: 7, highlighted: true });
    expect(seen.args).toEqual({ id: 7 });
    expect(seen.ctx.pageData).toEqual({ id: 7, desc: 'Coffee' });
    // The handler's signal follows the agent's: aborting the call aborts it.
    expect(seen.ctx.signal.aborted).toBe(false);
    controller.abort();
    expect(seen.ctx.signal.aborted).toBe(true);
  });

  test('execute after the handler was aborted returns the navigate hint, and never runs the handler', async () => {
    let ran = false;
    const handlerController = new AbortController();
    handlerController.abort(); // the tab unmounted
    const { runtime } = runtimeWith({ open_transaction: { tab: 'transactions', signal: handlerController.signal, handler: async () => { ran = true; return 'x'; } } });
    // A real registry returns no handler once its signal aborted; the runtime here hands it over so the core's own check is covered too.
    const out = await executePageTool({ tool: tabTool, args: { id: 7 }, signal: new AbortController().signal, serverCall: authorized(), runtime });
    expect(out).toEqual({ error: { code: 'tab_not_open', message: "The Transactions tab is not open. Call open_tab with tab='transactions' first." } });
    expect(ran).toBe(false);
  });

  test('execute with no handler at all (the tab never mounted one) returns the same hint', async () => {
    const { runtime } = runtimeWith({});
    const out = await executePageTool({ tool: tabTool, args: {}, signal: new AbortController().signal, serverCall: authorized(), runtime });
    expect(out).toEqual({ error: { code: 'tab_not_open', message: tabOpenHint('transactions') } });
  });

  test('a global tool with no handler says it is not available, naming the tool and no tab', async () => {
    const { runtime } = runtimeWith({});
    const out = (await executePageTool({ tool: globalTool, args: {}, signal: new AbortController().signal, serverCall: authorized(), runtime })) as { error: { message: string } };
    expect(out.error.message).toContain('open_tab');
    expect(out.error.message).not.toContain('tab is not open');
  });

  test('the answer is marked stale when the tab changed while the handler ran', async () => {
    const { runtime, state } = runtimeWith({
      open_transaction: { tab: 'transactions', handler: async () => { state.active = 'review'; return { id: 7, highlighted: true }; } },
    });
    const out = await executePageTool({ tool: tabTool, args: { id: 7 }, signal: new AbortController().signal, serverCall: authorized(), runtime });
    expect(out).toEqual({ id: 7, highlighted: true, stale: true });
  });

  test("a non-object answer is wrapped when it is marked stale", async () => {
    const { runtime, state } = runtimeWith({ open_transaction: { tab: 'transactions', handler: async () => { state.active = 'goals'; return 'done'; } } });
    const out = await executePageTool({ tool: tabTool, args: {}, signal: new AbortController().signal, serverCall: authorized(), runtime });
    expect(out).toEqual({ result: 'done', stale: true });
  });

  test('a global tool that changes the tab on purpose is not stale', async () => {
    const { runtime, state } = runtimeWith({ open_tab: { tab: 'global', handler: async () => { state.active = 'goals'; return { tab: 'goals' }; } } });
    const out = await executePageTool({ tool: globalTool, args: { tab: 'goals' }, signal: new AbortController().signal, serverCall: authorized(), runtime });
    expect(out).toEqual({ tab: 'goals' });
  });

  test('the answer is stale when the handler own signal aborted during the run', async () => {
    const handlerController = new AbortController();
    const { runtime } = runtimeWith({ open_transaction: { tab: 'transactions', signal: handlerController.signal, handler: async () => { handlerController.abort(); return { ok: 1 }; } } });
    const out = await executePageTool({ tool: tabTool, args: {}, signal: new AbortController().signal, serverCall: authorized(), runtime });
    expect(out).toEqual({ ok: 1, stale: true });
  });

  test('a call the server did not authorize (rejected card, error outcome) is returned as it is and the page is never touched', async () => {
    let ran = false;
    const { runtime } = runtimeWith({ open_transaction: { tab: 'transactions', handler: async () => { ran = true; return 'x'; } } });
    const out = await executePageTool({
      tool: tabTool, args: {}, signal: new AbortController().signal, runtime,
      serverCall: async () => ({ type: 'value', value: { outcome: 'rejected', operationId: 'op1' } }),
    });
    expect(out).toEqual({ outcome: 'rejected', operationId: 'op1' });
    expect(ran).toBe(false);
  });

  test('a server refusal (grant, policy, rate limit, 404) comes back as an {error} result and the page is never touched', async () => {
    let ran = false;
    const { runtime } = runtimeWith({ open_transaction: { tab: 'transactions', handler: async () => { ran = true; return 'x'; } } });
    const out = (await executePageTool({ tool: tabTool, args: {}, signal: new AbortController().signal, runtime, serverCall: async () => { throw new Error('Transaction #9 not found — use search_transactions.'); } })) as { error: { message: string } };
    expect(out.error.message).toContain('not found');
    expect(ran).toBe(false);
  });

  test('an answer larger than 1500 characters is dropped, not delivered', async () => {
    const { runtime } = runtimeWith({ open_transaction: { tab: 'transactions', handler: async () => ({ blob: 'x'.repeat(5000) }) } });
    const out = (await executePageTool({ tool: tabTool, args: {}, signal: new AbortController().signal, serverCall: authorized(), runtime })) as Record<string, unknown>;
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(1500);
    expect(out.truncated).toBe(true);
    expect(out.blob).toBeUndefined();
  });

  test('an agent that gave up (signal aborted) during the handler gets an AbortError, not a result', async () => {
    const controller = new AbortController();
    const { runtime } = runtimeWith({ open_transaction: { tab: 'transactions', handler: async () => { controller.abort(); return { ok: 1 }; } } });
    await expect(executePageTool({ tool: tabTool, args: {}, signal: controller.signal, serverCall: authorized(), runtime })).rejects.toMatchObject({ name: 'AbortError' });
  });

  test('a handler that throws surfaces its message to the agent as an {error} result', async () => {
    const { runtime } = runtimeWith({ open_transaction: { tab: 'transactions', handler: async () => { throw new Error('row not on screen'); } } });
    const out = (await executePageTool({ tool: tabTool, args: {}, signal: new AbortController().signal, serverCall: authorized(), runtime })) as { error: { message: string } };
    expect(out.error.message).toBe('row not on screen');
  });

  test('works against the real page registry: abort removes the handler, then the hint comes back', async () => {
    const registry = getPageRegistry({});
    registry.setActiveTab('transactions');
    const mount = new AbortController();
    registry.registerHandler('open_transaction', 'transactions', async () => ({ highlighted: true }), mount.signal);
    const run = () => executePageTool({ tool: tabTool, args: {}, signal: new AbortController().signal, serverCall: authorized(), runtime: registry });
    expect(await run()).toEqual({ highlighted: true });
    mount.abort();
    expect(await run()).toEqual({ error: { code: 'tab_not_open', message: tabOpenHint('transactions') } });
  });
});

describe('page tool answers through the server (callServerToolAnswer)', () => {
  const pageCall = { grantId: '11111111-1111-4111-8111-111111111111', tool: 'some_page_tool', args: {}, transport: 'page' as const };

  test("{kind:'page'} is an authorization with the server's pageData", async () => {
    const { fetchFn } = fakeServer({ 'POST /api/mcp/call': jsonResponse({ kind: 'page', pageData: { id: 7 } }) });
    expect(await callServerToolAnswer(deps(fetchFn), pageCall, undefined, { pageMode: true })).toEqual({ type: 'page', pageData: { id: 7 } });
    const bare = fakeServer({ 'POST /api/mcp/call': jsonResponse({ kind: 'page' }) });
    expect(await callServerToolAnswer(deps(bare.fetchFn), pageCall, undefined, { pageMode: true })).toEqual({ type: 'page', pageData: undefined });
  });

  test('under Ask, once the user allowed it the committed answer is an authorization carrying the stored pageData', async () => {
    const pending = { id: 'op1', status: 'pending', kind: 'read' };
    const done = { id: 'op1', status: 'committed', kind: 'read', data: { id: 7, desc: 'Coffee' } };
    const { fetchFn } = fakeServer({
      'POST /api/mcp/call': jsonResponse({ kind: 'operation', operation: pending }),
      'GET /api/mcp/operations/op1?view=agent': [jsonResponse({ operation: pending }), jsonResponse({ operation: done })],
    });
    expect(await callServerToolAnswer(deps(fetchFn), pageCall, undefined, { pageMode: true })).toEqual({ type: 'page', pageData: { id: 7, desc: 'Coffee' } });
  });

  test('under Ask, a rejected or expired card is a value, never an authorization', async () => {
    for (const status of ['rejected', 'stale', 'expired']) {
      const { fetchFn } = fakeServer({
        'POST /api/mcp/call': jsonResponse({ kind: 'operation', operation: { id: 'op1', status: 'pending', kind: 'read' } }),
        'GET /api/mcp/operations/op1?view=agent': jsonResponse({ operation: { id: 'op1', status, kind: 'read' } }),
      });
      expect(await callServerToolAnswer(deps(fetchFn), pageCall, undefined, { pageMode: true })).toEqual({ type: 'value', value: { outcome: status, operationId: 'op1', result: undefined } });
    }
  });

  test('under Ask, a committed answer whose data was already delivered is not an authorization', async () => {
    const { fetchFn } = fakeServer({
      'POST /api/mcp/call': jsonResponse({ kind: 'operation', operation: { id: 'op1', status: 'pending', kind: 'read' } }),
      'GET /api/mcp/operations/op1?view=agent': jsonResponse({ operation: { id: 'op1', status: 'committed', kind: 'read' } }),
    });
    const out = (await callServerToolAnswer(deps(fetchFn), pageCall, undefined, { pageMode: true })) as { type: string; value: { reason: string } };
    expect(out.type).toBe('value');
    expect(out.value.reason).toContain('already delivered');
  });

  test('execute passes signal: aborting during the Ask wait cancels the poll and POSTs cancel', async () => {
    const controller = new AbortController();
    const { calls, fetchFn } = fakeServer({
      'POST /api/mcp/call': jsonResponse({ kind: 'operation', operation: { id: 'op1', status: 'pending', kind: 'read' } }),
      'GET /api/mcp/operations/op1?view=agent': jsonResponse({ operation: { id: 'op1', status: 'pending', kind: 'read' } }),
      'POST /api/mcp/operations/op1/cancel': jsonResponse({ outcome: 'cancelled' }),
    });
    let sleeps = 0;
    const d = deps(fetchFn, { sleep: async () => { if (++sleeps === 2) controller.abort(); } });
    const { runtime } = (() => {
      const r: PageToolRuntime = { activeTab: () => 'transactions', getHandler: () => ({ tab: 'transactions', handler: async () => 'never', signal: new AbortController().signal }) };
      return { runtime: r };
    })();
    await expect(
      executePageTool({
        tool: { name: 'some_page_tool', surface: { tab: 'transactions' } },
        args: {},
        signal: controller.signal,
        runtime,
        serverCall: (signal) => callServerToolAnswer(d, pageCall, signal, { pageMode: true }),
      })
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls.some((c) => c.url === '/api/mcp/operations/op1/cancel' && c.method === 'POST')).toBe(true);
  });

  test('callServerTool still returns plain data for a page tool answer (declarative page forms)', async () => {
    const { fetchFn } = fakeServer({ 'POST /api/mcp/call': jsonResponse({ kind: 'page', pageData: { a: 1 } }) });
    expect(await callServerTool(deps(fetchFn), pageCall)).toEqual({ a: 1 });
  });
});

describe('bridge sources', () => {
  const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
  const sources: Record<string, string> = {
    'webmcp-bridge.ts': read('../dashboard/webmcp-bridge.ts'),
    'webmcp-bridge-core.ts': read('../dashboard/webmcp-bridge-core.ts'),
  };
  const stripComments = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

  test('bridge sources contain no tool-name literals (the server classifies, not the client)', () => {
    for (const [file, source] of Object.entries(sources)) {
      const code = stripComments(source);
      for (const def of MCP_TOOL_CATALOG) {
        expect(code.includes(def.name), `${file} mentions ${def.name}`).toBe(false);
      }
    }
  });

  test('the bridge has no client-side classifier', () => {
    const code = stripComments(sources['webmcp-bridge.ts']);
    expect(code).not.toMatch(/isRead\b|isMutating|isMutatingCall/);
    expect(code).not.toContain(['/api/mcp/', 'read'].join(''));
    expect(code).not.toContain(['/api/mcp/', 'prepare'].join(''));
    expect(code).toContain('callServerTool');
  });

  test("no innerHTML assignment except ''", () => {
    for (const [file, source] of Object.entries(sources)) {
      const code = stripComments(source);
      for (const match of code.matchAll(/\.(innerHTML|outerHTML)\s*(\+?=)\s*([^;\n]*)/g)) {
        expect(match[2], `${file}: ${match[0]}`).toBe('=');
        expect(match[3].trim(), `${file}: ${match[0]}`).toMatch(/^(''|"")$/);
      }
      expect(code).not.toMatch(/insertAdjacentHTML|document\.write\(/);
    }
  });

  test('the session id travels in a header, not a query string', () => {
    for (const source of Object.values(sources)) {
      expect(stripComments(source)).not.toMatch(/[?&]sessionGeneration=/);
    }
  });

  test('the bridge publishes the live set to the page registry and registers only what the server marks imperative', () => {
    const code = stripComments(sources['webmcp-bridge.ts']);
    expect(code).toContain('setLiveTools');
    expect(code).toContain('getPageRegistry');
    expect(code).toContain('registerLiveTools');
  });

  test('the core imports only the import-free tool-error module, so any bundler can include it', () => {
    const imports = [...sources['webmcp-bridge-core.ts'].matchAll(/^\s*import\s[^;]*from\s+'([^']+)'/gm)].map((m) => m[1]);
    expect(imports).toEqual(['./webmcp-tool-error.js']);
    expect(readFileSync(new URL('../dashboard/webmcp-tool-error.ts', import.meta.url), 'utf8')).not.toMatch(/^\s*import\s/m);
  });
});

// ── L3, L4: error results, identity-stable registration ──────────────────────

describe('L4: refusals come back as {error:{code,message}} results, not thrown errors', () => {
  const pageTool = { name: 'open_transaction', surface: { tab: 'transactions' } as const, openHint: tabOpenHint('transactions') };
  const handlerEntry = (handler: (args: any, ctx: any) => Promise<unknown>) => ({ tab: 'transactions', signal: new AbortController().signal, handler });
  const runtimeFor = (handler: (args: any, ctx: any) => Promise<unknown>) => ({
    activeTab: () => 'transactions',
    getHandler: () => handlerEntry(handler),
  });

  test('callServerToolAnswer throws a ToolCallError carrying the server code (REST status codes are unchanged)', async () => {
    const { fetchFn } = fakeServer({ 'POST /api/mcp/call': jsonResponse({ error: { code: 'not_found', message: 'Transaction #9 not found' } }, 404) });
    const err = await callServerToolAnswer(deps(fetchFn), call).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('not_found');
  });

  test('a server refusal in a page tool (404, policy off, kill switch) is returned as an error result and the page is untouched', async () => {
    let ran = false;
    const out = await executePageTool({
      tool: pageTool, args: { id: 9 }, signal: new AbortController().signal,
      runtime: runtimeFor(async () => { ran = true; return 'x'; }),
      serverCall: async () => { throw Object.assign(new Error('Transaction #9 not found'), { code: 'not_found' }); },
    });
    expect(out).toEqual({ error: { code: 'not_found', message: 'Transaction #9 not found' } });
    expect(ran).toBe(false);
  });

  test('a handler that throws is returned as an error result with its message', async () => {
    const out = await executePageTool({
      tool: pageTool, args: {}, signal: new AbortController().signal,
      runtime: runtimeFor(async () => { throw new Error('row not on screen'); }),
      serverCall: async () => ({ type: 'page' }),
    });
    expect(out).toEqual({ error: { code: 'tool_failed', message: 'row not on screen' } });
  });

  test('a handler that returns {error:{...}} is delivered as it is (and not marked stale-wrapped)', async () => {
    const refusal = { error: { code: 'settings_refused', message: 'The Settings tab is not available to agents.' } };
    const out = await executePageTool({
      tool: pageTool, args: {}, signal: new AbortController().signal,
      runtime: runtimeFor(async () => refusal),
      serverCall: async () => ({ type: 'page' }),
    });
    expect(out).toEqual(refusal);
  });

  test('a missing handler answers with an error result carrying the open-the-tab hint', async () => {
    const out = await executePageTool({
      tool: pageTool, args: {}, signal: new AbortController().signal,
      runtime: { activeTab: () => 'review', getHandler: () => undefined },
      serverCall: async () => ({ type: 'page' }),
    });
    expect(out).toEqual({ error: { code: 'tab_not_open', message: tabOpenHint('transactions') } });
  });

  test('an over-long page answer is dropped with an error result, not a bare string', async () => {
    const out = (await executePageTool({
      tool: pageTool, args: {}, signal: new AbortController().signal,
      runtime: runtimeFor(async () => ({ blob: 'x'.repeat(5000) })),
      serverCall: async () => ({ type: 'page' }),
    })) as { error: { code: string }; truncated?: boolean };
    expect(out.error.code).toBe('output_too_long');
    expect(out.truncated).toBe(true);
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(1500);
  });

  test('an AbortError (the agent gave up) still rejects', async () => {
    const controller = new AbortController();
    await expect(
      executePageTool({
        tool: pageTool, args: {}, signal: controller.signal,
        runtime: runtimeFor(async () => { controller.abort(); return { ok: 1 }; }),
        serverCall: async () => ({ type: 'page' }),
      })
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('L3: registration is identity-stable', () => {
  const descriptor = (name: string, extra: Partial<LiveToolDescriptor> = {}): LiveToolDescriptor => ({
    name, description: `${name} d`, inputSchema: { type: 'object' }, classification: 'read', exposure: 'imperative', autosubmit: false, grantId: `g-${name}`, ...extra,
  });

  test('the signature ignores the grant id and tool order but sees a policy change', () => {
    const a = [descriptor('a', { policy: 'allow' }), descriptor('b', { policy: 'ask' })];
    const b = [descriptor('b', { policy: 'ask', grantId: 'other' }), descriptor('a', { policy: 'allow', grantId: 'other' })];
    expect(liveToolsSignature(a)).toBe(liveToolsSignature(b));
    expect(liveToolsSignature(a)).not.toBe(liveToolsSignature([descriptor('a', { policy: 'ask' }), descriptor('b', { policy: 'ask' })]));
  });

  test('a repeated pass over an unchanged live set registers nothing twice', async () => {
    const registered = new Map<string, AbortController>();
    let calls = 0;
    const base = { tools: [descriptor('a'), descriptor('b')], registered, registerTool: async () => { calls += 1; }, makeExecute: () => async () => null };
    await registerLiveTools(base);
    await registerLiveTools(base);
    await registerLiveTools({ ...base, tools: [descriptor('b', { grantId: 'new-grant' }), descriptor('a')] });
    expect(calls).toBe(2);
    expect([...registered.values()].every((c) => !c.signal.aborted)).toBe(true);
  });

  test('a tab tool whose view flaps (tab or handler gone) is NOT unregistered while a call to it is in flight; it is once the call settles', async () => {
    const registered = new Map<string, AbortController>();
    const tool = descriptor('open_transaction', { classification: 'page', surface: { tab: 'transactions' } });
    let busy = true;
    const run = (view: { activeTab?: string; hasHandler?: (n: string) => boolean }) =>
      registerLiveTools({ tools: [tool], registered, registerTool: async () => {}, makeExecute: () => async () => null, isBusy: () => busy, ...view });
    await run({ activeTab: 'transactions', hasHandler: () => true });
    const controller = registered.get('open_transaction')!;
    const deferred = await run({ activeTab: 'review', hasHandler: () => true }); // tab flapped away mid-call
    expect(controller.signal.aborted).toBe(false);
    expect(registered.has('open_transaction')).toBe(true);
    expect(deferred.deferred).toEqual(['open_transaction']);
    busy = false;
    const settled = await run({ activeTab: 'review', hasHandler: () => true });
    expect(controller.signal.aborted).toBe(true);
    expect(settled.deferred).toEqual([]);
  });

  test('a REVOKED tool (no longer in the live set) is aborted at once, even with a call in flight', async () => {
    const registered = new Map<string, AbortController>();
    const tool = descriptor('search_transactions');
    await registerLiveTools({ tools: [tool], registered, registerTool: async () => {}, makeExecute: () => async () => null });
    const controller = registered.get('search_transactions')!;
    await registerLiveTools({ tools: [], registered, registerTool: async () => {}, makeExecute: () => async () => null, isBusy: () => true });
    expect(controller.signal.aborted).toBe(true);
    expect(registered.size).toBe(0);
  });
});

/**
 * A stand-in for Chrome's `document.modelContext`: a second registerTool for a name that is registered rejects
 * (InvalidStateError), and aborting the signal a tool was registered with is the only way to remove it.
 */
function chromeLikeModelContext() {
  const live = new Map<string, AbortSignal>();
  let calls = 0;
  return {
    live,
    calls: () => calls,
    registerTool: async (tool: { name: string }, options: { signal: AbortSignal }) => {
      calls += 1;
      if (live.has(tool.name)) throw new Error(`InvalidStateError: ${tool.name} is already registered`);
      live.set(tool.name, options.signal);
      options.signal.addEventListener('abort', () => {
        if (live.get(tool.name) === options.signal) live.delete(tool.name);
      });
    },
  };
}

describe('registerLiveTools: a shrinking live set always unregisters', () => {
  const d = (name: string, extra: Partial<LiveToolDescriptor> = {}): LiveToolDescriptor => ({
    name, description: name, inputSchema: { type: 'object' }, classification: 'read', exposure: 'imperative', autosubmit: false, surface: 'global', grantId: `g-${name}`, ...extra,
  });
  const pass = (mc: ReturnType<typeof chromeLikeModelContext>, registered: Map<string, AbortController>, tools: LiveToolDescriptor[], isBusy?: (n: string) => boolean) =>
    registerLiveTools({ tools, registered, registerTool: mc.registerTool, makeExecute: () => async () => null, hasHandler: () => true, isBusy });

  test('a tool listed twice (granted twice: one row per live grant) is registered once, and the kill switch then removes it', async () => {
    const mc = chromeLikeModelContext();
    const registered = new Map<string, AbortController>();
    const twice = [d('search_transactions', { grantId: 'g1' }), d('search_transactions', { grantId: 'g2' }), d('open_tab', { classification: 'page', grantId: 'g3' }), d('open_tab', { classification: 'page', grantId: 'g4' })];
    await pass(mc, registered, twice);
    expect(mc.calls()).toBe(2); // one registerTool per name, never a refused duplicate
    expect([...mc.live.keys()].sort()).toEqual(['open_tab', 'search_transactions']);
    expect([...registered.keys()].sort()).toEqual(['open_tab', 'search_transactions']);
    expect([...registered.values()].every((c) => !c.signal.aborted)).toBe(true);

    await pass(mc, registered, []); // kill switch / revoke: the server lists nothing
    expect([...mc.live.keys()]).toEqual([]);
    expect(registered.size).toBe(0);
  });

  test('every way the live set shrinks (kill switch, revoke one, policy Off, 401/403 empties it) aborts what left, at once', async () => {
    const mc = chromeLikeModelContext();
    const registered = new Map<string, AbortController>();
    const all = [d('a'), d('b'), d('c', { classification: 'page' })];
    await pass(mc, registered, all);
    expect(mc.live.size).toBe(3);
    await pass(mc, registered, [d('a'), d('c', { classification: 'page' })]); // b revoked, or its policy set to Off
    expect([...mc.live.keys()].sort()).toEqual(['a', 'c']);
    await pass(mc, registered, []); // kill switch, revoke-session, or a 401/403 sync
    expect(mc.live.size).toBe(0);
    expect(registered.size).toBe(0);
  });

  test('a call in flight never keeps a tool the server stopped listing; it only keeps a still-live tool that left the view, until the call settles', async () => {
    const mc = chromeLikeModelContext();
    const registered = new Map<string, AbortController>();
    const tabTool = d('open_transaction', { classification: 'page', surface: { tab: 'transactions' } });
    let busy = true;
    await registerLiveTools({ tools: [d('a'), tabTool], registered, registerTool: mc.registerTool, makeExecute: () => async () => null, hasHandler: () => true, activeTab: 'transactions' });
    expect(mc.live.size).toBe(2);
    // The tab changes while both have a call in flight: the still-live tab tool is deferred, nothing else.
    const flapped = await registerLiveTools({ tools: [d('a'), tabTool], registered, registerTool: mc.registerTool, makeExecute: () => async () => null, hasHandler: () => true, activeTab: 'review', isBusy: () => busy });
    expect(flapped.deferred).toEqual(['open_transaction']);
    expect(mc.live.has('open_transaction')).toBe(true);
    // The kill switch lands while the calls still run: both go, busy or not.
    const killed = await registerLiveTools({ tools: [], registered, registerTool: mc.registerTool, makeExecute: () => async () => null, hasHandler: () => true, activeTab: 'review', isBusy: () => busy });
    expect(killed.deferred).toEqual([]);
    expect(mc.live.size).toBe(0);
    busy = false;
  });
});
