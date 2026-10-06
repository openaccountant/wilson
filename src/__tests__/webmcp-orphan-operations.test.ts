import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { getPageRegistry, type LiveToolInfo } from '../dashboard/webmcp-page-registry.js';
import { join } from 'node:path';
import {
  callServerToolAnswer, createOperationLedger, endChromeCall, SESSION_HEADER,
  type OperationLedger,
  type ServerCallDeps,
} from '../dashboard/webmcp-bridge-core.js';

/**
 * S2: Chrome can end an agent call without telling the page, and the call may have left a pending approval card. The
 * ledger is keyed by CALL identity: each agent call (an imperative `execute`, a page tool, a declarative `agentInvoked`
 * submit) records the operation ids IT created, and only two things withdraw them server-side:
 *   (a) a `toolcancel` naming the tool while that agent call is in flight, and
 *   (b) that call's `execute` rejecting or aborting.
 * Never withdrawn: a card from a PERSON's submit, another call's card (even of the same tool), or a card orphaned by a form
 * unmount, a `toolchange` (Chrome's carries no tool name) or an ended `respondWith`. Those expire on their own (5 minutes);
 * re-derivation is prevented by schema stability, not cleaned up.
 */

const SESSION = '3b241101-e2bb-4255-8caf-4136c566a962';
const GRANT = '11111111-1111-4111-8111-111111111111';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function fakeServer(routes: Record<string, Response | Response[] | (() => Response)>) {
  const calls: Array<{ url: string; method: string; headers: Record<string, string> }> = [];
  const fetchFn = async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ url, method, headers: (init?.headers ?? {}) as Record<string, string> });
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
    authHeaders: () => ({}),
    now: () => t,
    sleep: async (ms) => { t += ms; },
    pollIntervalMs: 800,
    timeoutMs: 5000,
    ...extra,
  };
}

const cancelsOf = (calls: Array<{ url: string; method: string }>) => calls.filter((c) => c.method === 'POST' && c.url.endsWith('/cancel')).map((c) => c.url);

const TOOL = 'set_budget';
const pendingCall = { 'POST /api/mcp/call': jsonResponse({ kind: 'operation', operation: { id: 'op1', status: 'pending' } }) };
const declarativeAgent = (ledger: OperationLedger, tool = TOOL) => ({ grantId: GRANT, tool, args: {}, transport: 'declarative' as const, agentCall: ledger.beginCall(tool) });
const declarativePerson = { grantId: GRANT, tool: TOOL, args: {}, transport: 'declarative' as const };

describe('createOperationLedger (per-call identity)', () => {
  test('each call records the operations it created, until their outcome is delivered', () => {
    const ledger = createOperationLedger();
    const a = ledger.beginCall(TOOL);
    const b = ledger.beginCall('update_goal');
    expect(ledger.attach(a, 'op1')).toBe(true);
    expect(ledger.attach(a, 'op2')).toBe(true);
    expect(ledger.attach(b, 'op3')).toBe(true);
    expect(ledger.opsOf(a)).toEqual(['op1', 'op2']);
    expect(ledger.has('op3')).toBe(true);
    ledger.release('op1');
    expect(ledger.opsOf(a)).toEqual(['op2']);
    ledger.release('op1'); // idempotent
    expect(ledger.inFlight(TOOL)).toEqual([a]);
    ledger.endCall(a);
    expect(ledger.has('op2')).toBe(false);
    expect(ledger.inFlight(TOOL)).toEqual([]);
  });

  test('(b) a rejected execute hands back only the operations of THAT call, once', () => {
    const ledger = createOperationLedger();
    const first = ledger.beginCall(TOOL);
    const second = ledger.beginCall(TOOL); // the same tool, another call
    ledger.attach(first, 'op1');
    ledger.attach(second, 'op2');
    expect(ledger.cancelled({ type: 'execute-rejected', call: first })).toEqual(['op1']);
    expect(ledger.has('op2'), 'the second pending op of the same tool survives another call\'s cancel').toBe(true);
    expect(ledger.opsOf(second)).toEqual(['op2']);
    expect(ledger.cancelled({ type: 'execute-rejected', call: first }), 'not handed back twice').toEqual([]);
  });

  test('(a) a toolcancel naming the tool hands back the operations of the one agent call of it in flight', () => {
    const ledger = createOperationLedger();
    const mine = ledger.beginCall(TOOL);
    const other = ledger.beginCall('update_goal');
    ledger.attach(mine, 'op1');
    ledger.attach(other, 'op2');
    expect(ledger.cancelled({ type: 'toolcancel', tool: TOOL })).toEqual(['op1']);
    expect(ledger.has('op2'), "another tool's call is untouched").toBe(true);
    expect(ledger.cancelled({ type: 'toolcancel', tool: TOOL }), 'once').toEqual([]);
  });

  test('a toolcancel that cannot be attributed withdraws nothing: no tool name, no call in flight, or several calls of the tool', () => {
    const ledger = createOperationLedger();
    expect(ledger.cancelled({ type: 'toolcancel', tool: TOOL }), 'no agent call in flight (a person\'s card was never registered)').toEqual([]);
    const a = ledger.beginCall(TOOL);
    const b = ledger.beginCall(TOOL);
    ledger.attach(a, 'op1');
    ledger.attach(b, 'op2');
    expect(ledger.cancelled({ type: 'toolcancel' })).toEqual([]);
    expect(ledger.cancelled({ type: 'toolcancel', tool: TOOL }), 'two calls of the tool: which one is not known').toEqual([]);
    expect(ledger.has('op1') && ledger.has('op2')).toBe(true);
  });

  test('an operation whose outcome was delivered, or whose call ended, is never handed back', () => {
    const ledger = createOperationLedger();
    const call = ledger.beginCall(TOOL);
    ledger.attach(call, 'op1');
    ledger.release('op1'); // the agent has its answer
    expect(ledger.cancelled({ type: 'toolcancel', tool: TOOL })).toEqual([]);
    ledger.attach(call, 'op2');
    ledger.endCall(call);
    expect(ledger.cancelled({ type: 'execute-rejected', call })).toEqual([]);
    expect(ledger.cancelled({ type: 'toolcancel', tool: TOOL })).toEqual([]);
  });

  test('a toolcancel that arrives before the call created its operation withdraws the call: a later attach is refused', () => {
    const ledger = createOperationLedger();
    const call = ledger.beginCall(TOOL);
    expect(ledger.cancelled({ type: 'toolcancel', tool: TOOL })).toEqual([]);
    expect(ledger.attach(call, 'late')).toBe(false);
    expect(ledger.has('late')).toBe(false);
  });
});

describe('callServerToolAnswer records and releases its operation under its own call', () => {
  test('an agent call: the operation is in the ledger while the card is open and gone once the outcome is delivered', async () => {
    const ledger = createOperationLedger();
    let seenWhilePolling = false;
    const { fetchFn } = fakeServer({
      ...pendingCall,
      'GET /api/mcp/operations/op1?view=agent': () => {
        seenWhilePolling = ledger.has('op1');
        return jsonResponse({ operation: { id: 'op1', status: 'committed', result: {} } });
      },
    });
    const answer = await callServerToolAnswer(deps(fetchFn, { ledger }), declarativeAgent(ledger));
    expect(answer).toMatchObject({ type: 'value', value: { outcome: 'committed', operationId: 'op1' } });
    expect(seenWhilePolling).toBe(true);
    expect(ledger.has('op1')).toBe(false);
  });

  test('a PERSON\'s submit (no agent call) never registers its card, so no Chrome event can withdraw it', async () => {
    const ledger = createOperationLedger();
    let registered = true;
    const { calls, fetchFn } = fakeServer({
      ...pendingCall,
      'GET /api/mcp/operations/op1?view=agent': () => {
        registered = ledger.has('op1');
        return jsonResponse({ operation: { id: 'op1', status: 'committed', result: {} } });
      },
    });
    const d = deps(fetchFn, { ledger });
    // While the person's card is open: an unrelated call of the same tool is cancelled, the agent cancels the tool.
    const other = ledger.beginCall(TOOL);
    const person = callServerToolAnswer(d, declarativePerson);
    await endChromeCall(d, ledger, { type: 'execute-rejected', call: other });
    await endChromeCall(d, ledger, { type: 'toolcancel', tool: TOOL });
    await person;
    expect(registered).toBe(false);
    expect(cancelsOf(calls)).toEqual([]);
  });

  test('a person\'s card survives a refetch, an unmount and a tab switch: the registry events they cause cancel nothing', async () => {
    const ledger = createOperationLedger();
    const registry = getPageRegistry({});
    const info: LiveToolInfo = { name: TOOL, description: 'd', classification: 'mutating', autosubmit: false, inputSchema: { type: 'object', properties: {} } };
    registry.setLiveTools([TOOL], [info]);
    registry.setActiveTab('goals');
    const { calls, fetchFn } = fakeServer({
      ...pendingCall,
      'GET /api/mcp/operations/op1?view=agent': [
        jsonResponse({ operation: { id: 'op1', status: 'pending' } }),
        jsonResponse({ operation: { id: 'op1', status: 'pending' } }),
        jsonResponse({ operation: { id: 'op1', status: 'pending' } }),
        jsonResponse({ operation: { id: 'op1', status: 'committed', result: {} } }),
      ],
    });
    const d = deps(fetchFn, { ledger });
    const mounted = new AbortController();
    registry.registerHandler('open_review_item', 'goals', async () => ({}), mounted.signal);
    let step = 0;
    d.sleep = async (ms) => {
      step += 1;
      if (step === 1) registry.setLiveTools([TOOL], [{ ...info, description: 'refetched lists' }]); // a refetch re-publishes the tool
      if (step === 2) mounted.abort(); // the form's tab unmounts
      if (step === 3) registry.setActiveTab('transactions'); // the tab switches away
      void ms;
    };
    const answer = await callServerToolAnswer(d, declarativePerson); // no agent call: a person's submit
    expect(answer).toMatchObject({ type: 'value', value: { outcome: 'committed', operationId: 'op1' } });
    expect(cancelsOf(calls)).toEqual([]);
    expect(calls.filter((c) => c.method === 'GET')).toHaveLength(4); // polled to the end: nothing stopped it
  });

  test('an abort releases the operation too (the existing cancel runs once, the ledger has nothing left to cancel)', async () => {
    const ledger = createOperationLedger();
    const controller = new AbortController();
    const { calls, fetchFn } = fakeServer({
      ...pendingCall,
      'GET /api/mcp/operations/op1?view=agent': jsonResponse({ operation: { id: 'op1', status: 'pending' } }),
      'POST /api/mcp/operations/op1/cancel': jsonResponse({ outcome: 'cancelled' }),
    });
    let sleeps = 0;
    const d = deps(fetchFn, { ledger, sleep: async () => { if (++sleeps === 2) controller.abort(); } });
    const call = { ...declarativeAgent(ledger), transport: 'imperative' as const };
    await expect(callServerToolAnswer(d, call, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancelsOf(calls)).toEqual(['/api/mcp/operations/op1/cancel']);
    expect(ledger.has('op1')).toBe(false);
    expect(ledger.cancelled({ type: 'execute-rejected', call: call.agentCall })).toEqual([]); // the safety net posts nothing more
    expect(cancelsOf(calls)).toHaveLength(1);
  });

  test('(a) toolcancel mid-call: that call\'s operation is cancelled server-side, the poll stops and reports cancelled', async () => {
    const ledger = createOperationLedger();
    const { calls, fetchFn } = fakeServer({
      ...pendingCall,
      'GET /api/mcp/operations/op1?view=agent': jsonResponse({ operation: { id: 'op1', status: 'pending' } }),
      'POST /api/mcp/operations/op1/cancel': jsonResponse({ outcome: 'cancelled' }),
    });
    const d = deps(fetchFn, { ledger });
    let sleeps = 0;
    d.sleep = async () => {
      if (++sleeps === 1) await endChromeCall(d, ledger, { type: 'toolcancel', tool: TOOL });
    };
    const answer = await callServerToolAnswer(d, declarativeAgent(ledger));
    expect(cancelsOf(calls)).toEqual(['/api/mcp/operations/op1/cancel']);
    expect(calls.find((c) => c.url.endsWith('/cancel'))!.headers[SESSION_HEADER]).toBe(SESSION);
    expect(answer).toMatchObject({ type: 'value', value: { outcome: 'cancelled', operationId: 'op1' } });
    expect(calls.filter((c) => c.method === 'GET')).toHaveLength(1); // one poll before the cancel, none after it
    expect(ledger.has('op1')).toBe(false);
  });

  test('a poll that sees the cancelled row before the cancel call returned still reports what the cancel route said', async () => {
    const ledger = createOperationLedger();
    const { fetchFn } = fakeServer({
      ...pendingCall,
      // The server already shows the cancelled row (status rejected) when the poll asks.
      'GET /api/mcp/operations/op1?view=agent': jsonResponse({ operation: { id: 'op1', status: 'rejected', result: {} } }),
      'POST /api/mcp/operations/op1/cancel': jsonResponse({ outcome: 'cancelled' }),
    });
    const d = deps(fetchFn, { ledger });
    let first = true;
    d.sleep = async () => {};
    const baseFetch = d.fetch;
    d.fetch = async (url, init) => {
      // Chrome's toolcancel lands while the poll's request is in flight (the cancel is started, not yet answered).
      if (first && url.includes('?view=agent')) {
        first = false;
        void endChromeCall(d, ledger, { type: 'toolcancel', tool: TOOL });
      }
      return baseFetch(url, init);
    };
    const answer = await callServerToolAnswer(d, declarativeAgent(ledger));
    expect(answer).toMatchObject({ type: 'value', value: { outcome: 'cancelled', operationId: 'op1' } });
  });

  describe('cancel-after-approve: the person answered first, so the cancel route says so, and so does the agent', () => {
    for (const resolved of ['committed', 'rejected', 'stale', 'expired']) {
      test(`the cancel route answers ${resolved}: the agent is told ${resolved}, never cancelled`, async () => {
        const ledger = createOperationLedger();
        const { fetchFn } = fakeServer({
          ...pendingCall,
          'GET /api/mcp/operations/op1?view=agent': jsonResponse({ operation: { id: 'op1', status: 'pending' } }),
          'POST /api/mcp/operations/op1/cancel': jsonResponse({ outcome: resolved }, resolved === 'expired' ? 409 : 200),
        });
        const d = deps(fetchFn, { ledger });
        let sleeps = 0;
        d.sleep = async () => {
          if (++sleeps === 1) await endChromeCall(d, ledger, { type: 'toolcancel', tool: TOOL });
        };
        const answer = (await callServerToolAnswer(d, declarativeAgent(ledger))) as { type: 'value'; value: { outcome: string; operationId: string } };
        expect(answer.value).toMatchObject({ outcome: resolved, operationId: 'op1' });
        expect(answer.value.outcome).not.toBe('cancelled');
      });
    }

    test('a cancel that could not be confirmed (offline) is reported unknown, not cancelled', async () => {
      const ledger = createOperationLedger();
      const { fetchFn } = fakeServer({
        ...pendingCall,
        'GET /api/mcp/operations/op1?view=agent': jsonResponse({ operation: { id: 'op1', status: 'pending' } }),
        'POST /api/mcp/operations/op1/cancel': () => { throw new Error('offline'); },
      });
      const d = deps(fetchFn, { ledger });
      let sleeps = 0;
      d.sleep = async () => {
        if (++sleeps === 1) await endChromeCall(d, ledger, { type: 'toolcancel', tool: TOOL });
      };
      const answer = (await callServerToolAnswer(d, declarativeAgent(ledger))) as { value: { outcome: string } };
      expect(answer.value.outcome).toBe('unknown');
    });
  });

  test('a call withdrawn before its operation existed: the card is cancelled the moment it is created', async () => {
    const ledger = createOperationLedger();
    const { calls, fetchFn } = fakeServer({
      ...pendingCall,
      'POST /api/mcp/operations/op1/cancel': jsonResponse({ outcome: 'cancelled' }),
    });
    const call = declarativeAgent(ledger);
    await endChromeCall(deps(fetchFn), ledger, { type: 'toolcancel', tool: TOOL }); // the agent cancelled first
    const answer = await callServerToolAnswer(deps(fetchFn, { ledger }), call);
    expect(cancelsOf(calls)).toEqual(['/api/mcp/operations/op1/cancel']);
    expect(answer).toMatchObject({ type: 'value', value: { outcome: 'cancelled', operationId: 'op1' } });
    expect(calls.filter((c) => c.method === 'GET')).toHaveLength(0);
  });

  test('(a) toolcancel while one call is open does not touch a second pending op of the same tool', async () => {
    const ledger = createOperationLedger();
    // Two calls of the same tool, each with its own card.
    const second = ledger.beginCall(TOOL);
    ledger.attach(second, 'op2');
    const { calls, fetchFn } = fakeServer({
      ...pendingCall,
      'GET /api/mcp/operations/op1?view=agent': jsonResponse({ operation: { id: 'op1', status: 'pending' } }),
      'POST /api/mcp/operations/op1/cancel': jsonResponse({ outcome: 'cancelled' }),
    });
    const d = deps(fetchFn, { ledger });
    let sleeps = 0;
    d.sleep = async () => {
      // Chrome says the first call was rejected (its execute ended): only its card goes.
      if (++sleeps === 1) await endChromeCall(d, ledger, { type: 'execute-rejected', call: first.agentCall });
    };
    const first = declarativeAgent(ledger);
    await callServerToolAnswer(d, first);
    expect(cancelsOf(calls)).toEqual(['/api/mcp/operations/op1/cancel']);
    expect(ledger.has('op2')).toBe(true);
  });

  test('a call that never created an operation (a read, a page tool) leaves nothing to cancel', async () => {
    const ledger = createOperationLedger();
    const { calls, fetchFn } = fakeServer({ 'POST /api/mcp/call': jsonResponse({ kind: 'read', data: { items: [] } }) });
    const d = deps(fetchFn, { ledger });
    const call = ledger.beginCall('transaction_search');
    await callServerToolAnswer(d, { grantId: GRANT, tool: 'transaction_search', args: {}, transport: 'imperative', agentCall: call });
    expect(await endChromeCall(d, ledger, { type: 'toolcancel', tool: 'transaction_search' })).toEqual([]);
    expect(await endChromeCall(d, ledger, { type: 'execute-rejected', call })).toEqual([]);
    expect(cancelsOf(calls)).toEqual([]);
  });
});

describe('endChromeCall', () => {
  test('cancels every pending operation of the ended call, best effort: a failing cancel neither throws nor blocks the others', async () => {
    const ledger = createOperationLedger();
    const call = ledger.beginCall(TOOL);
    ledger.attach(call, 'op1');
    ledger.attach(call, 'op2');
    const { calls, fetchFn } = fakeServer({
      'POST /api/mcp/operations/op1/cancel': () => { throw new Error('offline'); },
      'POST /api/mcp/operations/op2/cancel': jsonResponse({ outcome: 'cancelled' }),
    });
    const ids = await endChromeCall(deps(fetchFn), ledger, { type: 'execute-rejected', call });
    expect(ids).toEqual(['op1', 'op2']);
    expect(cancelsOf(calls)).toEqual(['/api/mcp/operations/op1/cancel', '/api/mcp/operations/op2/cancel']);
  });

  test('a repeated end of the same call (toolcancel after a rejected execute) posts one cancel', async () => {
    const ledger = createOperationLedger();
    const call = ledger.beginCall('update_goal');
    ledger.attach(call, 'op9');
    const { calls, fetchFn } = fakeServer({ 'POST /api/mcp/operations/op9/cancel': jsonResponse({ outcome: 'cancelled' }) });
    const d = deps(fetchFn);
    await endChromeCall(d, ledger, { type: 'execute-rejected', call });
    await endChromeCall(d, ledger, { type: 'toolcancel', tool: 'update_goal' });
    expect(cancelsOf(calls)).toEqual(['/api/mcp/operations/op9/cancel']);
  });
});

describe('S2 source guards: only a toolcancel and a rejected execute withdraw cards, and only the ending call\'s', () => {
  const dash = join(import.meta.dir, '../dashboard');
  const strip = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const bridge = strip(readFileSync(join(dash, 'webmcp-bridge.ts'), 'utf8'));
  const hook = strip(readFileSync(join(dash, 'ui/src/agent/useDeclarativeTool.ts'), 'utf8'));
  const registry = strip(readFileSync(join(dash, 'webmcp-page-registry.ts'), 'utf8'));
  const core = strip(readFileSync(join(dash, 'webmcp-bridge-core.ts'), 'utf8'));

  test('the bridge has one ledger, passes it to every server call, and ends calls on toolcancel and on a rejected execute (by call)', () => {
    expect(bridge).toContain('createOperationLedger()');
    expect(bridge).toMatch(/function serverDeps\(\) \{[^}]*\bledger\b/);
    expect(bridge).toMatch(/window\.addEventListener\('toolcancel'[\s\S]{0,200}withdrawOrphans\(\{ type: 'toolcancel'/);
    expect(bridge).toMatch(/async function withdrawOrphans[\s\S]{0,200}endChromeCall\(serverDeps\(\), ledger, event\)/);
    expect(bridge).toMatch(/type: 'execute-rejected', call/);
    expect(bridge).toMatch(/ledger\.beginCall\(name\)/);
    // An imperative or page call hands its identity to the server call; a declarative one only when the form says it is the agent's.
    expect(bridge).toMatch(/executeServerTool\(\(\) => callWithGrant\(tool\.name, args, 'imperative', options\?\.signal, call\)\)/);
    expect(bridge).toMatch(/transport: 'page', agentCall: call/);
    expect(bridge).toMatch(/opts\.agentCall !== true\) return callWithGrant/);
  });

  test('toolchange (which names no tool), a form unmounting or going not-live, and an ended respondWith cancel nothing', () => {
    expect(bridge).not.toMatch(/withdrawOrphans\(\{ type: 'toolchange'/);
    expect(bridge).not.toMatch(/respond-ended/);
    expect(bridge).not.toContain('toolIsPresent');
    expect(bridge).not.toContain('cancelPendingOperations');
    expect(registry).not.toContain('cancelPendingOperations');
    expect(hook).not.toContain('cancelPendingOperations');
    expect(hook).not.toContain('cancelOrphans');
    expect(core).not.toContain('respond-ended');
    expect(core).not.toMatch(/type: 'toolchange'/);
    // The toolchange listener only refreshes state.
    const listener = /addEventListener\('toolchange', \(\) => \{([\s\S]*?)\n  \}\);/.exec(bridge);
    expect(listener).not.toBeNull();
    expect(listener![1]).not.toMatch(/endChromeCall|withdrawOrphans/);
  });

  test('a person\'s submit is not an agent call: the hook passes the form\'s own agentCall flag, and the handler sets it only for agentInvoked', () => {
    expect(hook).toMatch(/agentCall: opts\.agentCall/);
    const submitCore = strip(readFileSync(join(dash, 'declarative-submit-core.ts'), 'utf8'));
    expect(submitCore).toMatch(/agentCall: decision\.respond/);
  });
});
