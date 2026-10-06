import { describe, expect, test } from 'bun:test';
import { bindPageHandlers, getPageRegistry, type LiveToolInfo, type PageToolHandler } from '../dashboard/webmcp-page-registry.js';

/**
 * The page registry is how the in-page bridge (vanilla bundle) and the React dashboard (vite bundle) agree on
 * which tools are live. Two separate bundles each carry their own copy of this module, so the registry is
 * a singleton on `window`, not on the module.
 */

const info = (name: string): LiveToolInfo => ({
  name,
  description: `${name} description`,
  classification: 'read',
  autosubmit: false,
  inputSchema: { type: 'object', properties: {} },
});

describe('getPageRegistry', () => {
  test('get-or-create returns the same instance across two module copies', async () => {
    const w: { __wilsonPageTools?: unknown } = {};
    const first = getPageRegistry(w as never);
    // A second bundle evaluates the module again; a query string makes bun load a distinct module instance.
    const copy = (await import(`../dashboard/webmcp-page-registry.js?copy=${Math.random()}`)) as typeof import('../dashboard/webmcp-page-registry.js');
    expect(copy.getPageRegistry).not.toBe(getPageRegistry);
    const second = copy.getPageRegistry(w as never);
    expect(second).toBe(first);
    first.setLiveTools(['review_action']);
    expect(second.isToolLive('review_action')).toBe(true);
  });

  test('a window with no registry gets a fresh one, and two windows do not share', () => {
    const a = getPageRegistry({});
    const b = getPageRegistry({});
    expect(a).not.toBe(b);
    a.setLiveTools(['x']);
    expect(b.isToolLive('x')).toBe(false);
  });
});

describe('isToolLive / liveTools / setLiveTools', () => {
  test('isToolLive reflects setLiveTools, and a later call replaces the set', () => {
    const reg = getPageRegistry({});
    expect(reg.isToolLive('filter_transactions')).toBe(false);
    reg.setLiveTools(['filter_transactions', 'review_action']);
    expect(reg.isToolLive('filter_transactions')).toBe(true);
    expect([...reg.liveTools()].sort()).toEqual(['filter_transactions', 'review_action']);
    reg.setLiveTools(['review_action']);
    expect(reg.isToolLive('filter_transactions')).toBe(false);
    expect(reg.isToolLive('review_action')).toBe(true);
  });

  test('setLiveTools with info makes toolInfo available only for live tools', () => {
    const reg = getPageRegistry({});
    reg.setLiveTools(['a', 'b'], [info('a'), info('b')]);
    expect(reg.toolInfo('a')?.description).toBe('a description');
    reg.setLiveTools(['b'], [info('b')]);
    expect(reg.toolInfo('a')).toBeUndefined();
    reg.setLiveTools([]);
    expect(reg.toolInfo('b')).toBeUndefined();
  });

  test('the live set cannot be mutated through the returned view', () => {
    const reg = getPageRegistry({});
    reg.setLiveTools(['a']);
    (reg.liveTools() as Set<string>).add?.('sneaky');
    expect(reg.isToolLive('sneaky')).toBe(false);
  });
});

describe('subscribe', () => {
  test('subscribe fires on setLiveTools and stops after unsubscribe', () => {
    const reg = getPageRegistry({});
    let calls = 0;
    const off = reg.subscribe(() => { calls += 1; });
    reg.setLiveTools(['a']);
    expect(calls).toBe(1);
    off();
    reg.setLiveTools(['b']);
    expect(calls).toBe(1);
  });

  test('one failing subscriber does not stop the others', () => {
    const reg = getPageRegistry({});
    let reached = false;
    reg.subscribe(() => { throw new Error('boom'); });
    reg.subscribe(() => { reached = true; });
    reg.setLiveTools(['a']);
    expect(reached).toBe(true);
  });
});

describe('page tool handlers (P3)', () => {
  const noop = async () => 'ok';

  test('registerHandler / getHandler: a handler is returned while its signal is live, and abort removes it', () => {
    const reg = getPageRegistry({});
    reg.setActiveTab('transactions');
    const controller = new AbortController();
    reg.registerHandler('open_transaction', 'transactions', noop, controller.signal);
    expect(reg.getHandler('open_transaction')?.handler).toBe(noop);
    expect(reg.getHandler('open_transaction')?.tab).toBe('transactions');
    controller.abort();
    expect(reg.getHandler('open_transaction')).toBeUndefined();
  });

  test('a handler registered with an already-aborted signal is ignored', () => {
    const reg = getPageRegistry({});
    const controller = new AbortController();
    controller.abort();
    reg.registerHandler('x', 'global', noop, controller.signal);
    expect(reg.getHandler('x')).toBeUndefined();
  });

  test("a tab's handler is not returned while another tab is active; a global one always is", () => {
    const reg = getPageRegistry({});
    const controller = new AbortController();
    reg.registerHandler('open_review_item', 'review', noop, controller.signal);
    reg.registerHandler('navigate_to_tab', 'global', noop, controller.signal);
    reg.setActiveTab('review');
    expect(reg.getHandler('open_review_item')).toBeDefined();
    reg.setActiveTab('transactions');
    expect(reg.getHandler('open_review_item')).toBeUndefined();
    expect(reg.getHandler('navigate_to_tab')).toBeDefined();
  });

  test('re-registering a name replaces the handler, and the old signal aborting does not remove the new one', () => {
    const reg = getPageRegistry({});
    reg.setActiveTab('transactions');
    const first = new AbortController();
    const second = new AbortController();
    const newer = async () => 'newer';
    reg.registerHandler('open_transaction', 'transactions', noop, first.signal);
    reg.registerHandler('open_transaction', 'transactions', newer, second.signal);
    first.abort();
    expect(reg.getHandler('open_transaction')?.handler).toBe(newer);
    second.abort();
    expect(reg.getHandler('open_transaction')).toBeUndefined();
  });

  test('setActiveTab / activeTab round-trip', () => {
    const reg = getPageRegistry({});
    expect(reg.activeTab()).toBeUndefined();
    reg.setActiveTab('goals');
    expect(reg.activeTab()).toBe('goals');
  });

  test('subscribe fires on register, abort and a real setActiveTab change (not on a repeat)', () => {
    const reg = getPageRegistry({});
    let calls = 0;
    reg.subscribe(() => { calls += 1; });
    const controller = new AbortController();
    reg.registerHandler('a', 'global', noop, controller.signal);
    expect(calls).toBe(1);
    reg.setActiveTab('review');
    expect(calls).toBe(2);
    reg.setActiveTab('review');
    expect(calls).toBe(2);
    controller.abort();
    expect(calls).toBe(3);
  });

  test('the registry stays a singleton across module copies for the handler API too', async () => {
    const w: { __wilsonPageTools?: unknown } = {};
    const first = getPageRegistry(w as never);
    const copy = (await import(`../dashboard/webmcp-page-registry.js?copy=${Math.random()}`)) as typeof import('../dashboard/webmcp-page-registry.js');
    const controller = new AbortController();
    first.registerHandler('a', 'global', noop, controller.signal);
    expect(copy.getPageRegistry(w as never).getHandler('a')?.handler).toBe(noop);
  });
});

describe('bindPageHandlers (what a tab component does on mount and unmount)', () => {
  test('registers every name for the tab, calls the latest handler, and unmount aborts them all', async () => {
    const reg = getPageRegistry({});
    reg.setActiveTab('transactions');
    let latest: Record<string, PageToolHandler> = { open_transaction: async () => 'v1' };
    const dispose = bindPageHandlers(reg, 'transactions', ['open_transaction'], () => latest);
    const ctx = { signal: new AbortController().signal };
    expect(await reg.getHandler('open_transaction')!.handler({}, ctx)).toBe('v1');
    latest = { open_transaction: async () => 'v2' }; // a re-render: same registration, newer closure
    expect(await reg.getHandler('open_transaction')!.handler({}, ctx)).toBe('v2');
    dispose();
    expect(reg.getHandler('open_transaction')).toBeUndefined();
  });

  test('a handler that is missing at call time rejects with a readable error instead of crashing', async () => {
    const reg = getPageRegistry({});
    reg.setActiveTab('review');
    bindPageHandlers(reg, 'review', ['open_review_item'], () => ({}));
    const out = (await reg.getHandler('open_review_item')!.handler({}, { signal: new AbortController().signal })) as { error: { code: string; message: string } };
    expect(out.error.code).toBe('unavailable');
    expect(out.error.message).toContain('open_review_item');
  });
});

describe('L3: the live-info snapshot is identity-stable across resyncs', () => {
  const full = (name: string, extra: Partial<LiveToolInfo> = {}): LiveToolInfo => ({
    name, description: `${name} d`, classification: 'read', autosubmit: false, policy: 'allow',
    inputSchema: { type: 'object', properties: { a: { type: 'string', description: 'x' } } }, ...extra,
  });

  test('re-publishing an equal set (fresh objects, same content) keeps the same info objects and notifies nobody', () => {
    const reg = getPageRegistry({});
    reg.setLiveTools(['a', 'b'], [full('a'), full('b')]);
    const [a, b] = [reg.toolInfo('a'), reg.toolInfo('b')];
    let notified = 0;
    reg.subscribe(() => { notified += 1; });
    reg.setLiveTools(['b', 'a'], [full('b'), full('a')]);
    expect(reg.toolInfo('a')).toBe(a);
    expect(reg.toolInfo('b')).toBe(b);
    expect(notified).toBe(0);
  });

  test('when one tool changes, only its info object is replaced; every other keeps its identity', () => {
    const reg = getPageRegistry({});
    reg.setLiveTools(['a', 'b'], [full('a'), full('b')]);
    const [a, b] = [reg.toolInfo('a'), reg.toolInfo('b')];
    let notified = 0;
    reg.subscribe(() => { notified += 1; });
    reg.setLiveTools(['a', 'b'], [full('a'), full('b', { description: 'changed' })]);
    expect(reg.toolInfo('a')).toBe(a);
    expect(reg.toolInfo('b')).not.toBe(b);
    expect(reg.toolInfo('b')?.description).toBe('changed');
    expect(notified).toBe(1);
  });

  test('a policy change (Allow to Ask) is a real change: a new info object and a notification', () => {
    const reg = getPageRegistry({});
    reg.setLiveTools(['a'], [full('a', { policy: 'allow' })]);
    const before = reg.toolInfo('a');
    let notified = 0;
    reg.subscribe(() => { notified += 1; });
    reg.setLiveTools(['a'], [full('a', { policy: 'ask' })]);
    expect(reg.toolInfo('a')).not.toBe(before);
    expect(reg.toolInfo('a')?.policy).toBe('ask');
    expect(notified).toBe(1);
  });

  test('a schema change is a real change', () => {
    const reg = getPageRegistry({});
    reg.setLiveTools(['a'], [full('a')]);
    const before = reg.toolInfo('a');
    reg.setLiveTools(['a'], [full('a', { inputSchema: { type: 'object', properties: { b: { type: 'number' } } } })]);
    expect(reg.toolInfo('a')).not.toBe(before);
  });

  test('a tool added or revoked still notifies', () => {
    const reg = getPageRegistry({});
    reg.setLiveTools(['a'], [full('a')]);
    let notified = 0;
    reg.subscribe(() => { notified += 1; });
    reg.setLiveTools(['a', 'b'], [full('a'), full('b')]);
    reg.setLiveTools(['b'], [full('b')]);
    reg.setLiveTools([]);
    expect(notified).toBe(3);
  });

  test('setLiveTools with names only (no info) after a full publish still notifies (the info was dropped)', () => {
    const reg = getPageRegistry({});
    reg.setLiveTools(['a'], [full('a')]);
    let notified = 0;
    reg.subscribe(() => { notified += 1; });
    reg.setLiveTools(['a']);
    expect(notified).toBe(1);
    expect(reg.toolInfo('a')).toBeUndefined();
  });
});
