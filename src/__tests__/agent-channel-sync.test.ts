import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as session from '../dashboard/webmcp-session.js';
import {
  WILSON_AGENT_CHANNEL,
  WILSON_AGENT_STATE_CHANGED_EVENT,
  WILSON_GRANTS_CHANGED_EVENT,
  openAgentChannel,
  postAgentStateChanged,
  type AgentChannel,
} from '../dashboard/webmcp-session.js';

/**
 * Cross-tab sync (F5). A kill-switch, policy or grant change in one tab reaches the others over a BroadcastChannel so
 * they refetch `/api/mcp/state` at once instead of at the next 5 s poll. These tests use a fake BroadcastChannel that
 * behaves like the real one: same-name channels in other objects receive a message, the posting object does not, and a
 * closed channel gets nothing. The bridge side is covered against the real served bundle in
 * webmcp-bridge-bundle.test.ts ("a message from another tab on the agent channel makes the bridge resync").
 */

class FakeBroadcastChannel implements AgentChannel {
  static all: FakeBroadcastChannel[] = [];
  static constructed = 0;
  onmessage: ((event: unknown) => void) | null = null;
  closed = false;
  constructor(readonly name: string) {
    FakeBroadcastChannel.constructed++;
    FakeBroadcastChannel.all.push(this);
  }
  postMessage(message: unknown): void {
    if (this.closed) throw new Error('InvalidStateError: channel is closed');
    for (const other of FakeBroadcastChannel.all) {
      if (other !== this && other.name === this.name && !other.closed) queueMicrotask(() => other.onmessage?.({ data: message }));
    }
  }
  close(): void {
    this.closed = true;
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const live = () => FakeBroadcastChannel.all.filter((c) => !c.closed);

beforeEach(() => {
  FakeBroadcastChannel.all = [];
  FakeBroadcastChannel.constructed = 0;
});

describe('openAgentChannel and postAgentStateChanged', () => {
  test('a post from one tab triggers the handler in another, on the agreed channel name', async () => {
    let resyncs = 0;
    const listener = openAgentChannel(() => resyncs++, FakeBroadcastChannel);
    expect(listener).not.toBeNull();
    expect((listener as unknown as FakeBroadcastChannel).name).toBe(WILSON_AGENT_CHANNEL);
    postAgentStateChanged(FakeBroadcastChannel);
    await flush();
    expect(resyncs).toBe(1);
  });

  test('the post uses a short-lived channel: it is closed again, and only the listener stays open', async () => {
    openAgentChannel(() => {}, FakeBroadcastChannel);
    postAgentStateChanged(FakeBroadcastChannel);
    await flush();
    expect(FakeBroadcastChannel.all).toHaveLength(2);
    expect(FakeBroadcastChannel.all[1].closed).toBe(true);
    expect(live()).toHaveLength(1);
  });

  test('every other listening tab resyncs once per post; a closed listener does not', async () => {
    const counts = [0, 0, 0];
    const channels = counts.map((_, i) => openAgentChannel(() => counts[i]++, FakeBroadcastChannel)!);
    channels[2].close();
    postAgentStateChanged(FakeBroadcastChannel);
    postAgentStateChanged(FakeBroadcastChannel);
    await flush();
    expect(counts).toEqual([2, 2, 0]);
  });

  test('a channel with another name is not heard', async () => {
    let resyncs = 0;
    openAgentChannel(() => resyncs++, FakeBroadcastChannel);
    new FakeBroadcastChannel('somebody-else').postMessage({ type: 'state-changed' });
    await flush();
    expect(resyncs).toBe(0);
  });

  test('where BroadcastChannel is missing or throws, both are quiet no-ops', () => {
    const g = globalThis as { BroadcastChannel?: unknown };
    const saved = g.BroadcastChannel;
    delete g.BroadcastChannel; // an old browser or a locked-down context: nothing to open
    try {
      expect(openAgentChannel(() => {})).toBeNull();
      expect(() => postAgentStateChanged()).not.toThrow();
    } finally {
      g.BroadcastChannel = saved;
    }
    class Blocked {
      constructor() {
        throw new Error('SecurityError');
      }
    }
    expect(openAgentChannel(() => {}, Blocked as never)).toBeNull();
    expect(() => postAgentStateChanged(Blocked as never)).not.toThrow();
  });

  test('with no argument they use the global BroadcastChannel at call time', async () => {
    const g = globalThis as { BroadcastChannel?: unknown };
    const saved = g.BroadcastChannel;
    g.BroadcastChannel = FakeBroadcastChannel;
    try {
      let resyncs = 0;
      const ch = openAgentChannel(() => resyncs++);
      postAgentStateChanged();
      await flush();
      expect(resyncs).toBe(1);
      ch?.close();
    } finally {
      g.BroadcastChannel = saved;
    }
  });
});

describe('the React UI wrapper (ui/src/lib/agent-api.ts) over the same channel', () => {
  // The UI file imports vite aliases; bind them to the real session module and a stand-in for the fetch wrapper.
  mock.module('@webmcp-session', () => session);
  mock.module('@/api', () => ({ api: async () => ({}) }));

  type Listener = (e: unknown) => void;
  const listeners = new Map<string, Set<Listener>>();
  const fakeWindow = {
    addEventListener: (type: string, fn: Listener) => void (listeners.get(type) ?? listeners.set(type, new Set()).get(type)!).add(fn),
    removeEventListener: (type: string, fn: Listener) => void listeners.get(type)?.delete(fn),
    dispatchEvent: (e: { type: string }) => {
      for (const fn of listeners.get(e.type) ?? []) fn(e);
      return true;
    },
  };
  class FakeCustomEvent {
    detail: unknown;
    constructor(readonly type: string, init?: { detail?: unknown }) {
      this.detail = init?.detail;
    }
  }
  const g = globalThis as Record<string, unknown>;
  const saved: Record<string, unknown> = {};

  beforeEach(() => {
    listeners.clear();
    for (const k of ['window', 'CustomEvent', 'BroadcastChannel']) saved[k] = g[k];
    g.window = fakeWindow;
    g.CustomEvent = FakeCustomEvent;
    g.BroadcastChannel = FakeBroadcastChannel;
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete g[k];
      else g[k] = v;
    }
  });

  // A variable specifier keeps tsc from following the import into the UI package (it has its own tsconfig and aliases).
  const UI_MODULE = '../dashboard/ui/src/lib/agent-api.ts';
  const load = () =>
    import(UI_MODULE) as Promise<{
      announceAgentStateChanged: (from: string) => void;
      onAgentStateChanged: (listener: () => void, ownName: string) => () => void;
    }>;

  test('announceAgentStateChanged posts on the channel, so another tab`s subscriber resyncs', async () => {
    const { announceAgentStateChanged, onAgentStateChanged } = await load();
    let otherTab = 0;
    onAgentStateChanged(() => otherTab++, 'settings');
    listeners.clear(); // window events stay inside one tab: only the channel can reach the other tab's subscriber
    const before = FakeBroadcastChannel.constructed;
    announceAgentStateChanged('settings');
    await flush();
    expect(FakeBroadcastChannel.constructed).toBe(before + 1);
    expect(otherTab).toBe(1);
  });

  test('announce also fires both window events with its own name, for this tab`s other surfaces', async () => {
    const { announceAgentStateChanged } = await load();
    const seen: Array<[string, unknown]> = [];
    for (const type of [WILSON_AGENT_STATE_CHANGED_EVENT, WILSON_GRANTS_CHANGED_EVENT]) {
      fakeWindow.addEventListener(type, (e) => seen.push([type, (e as { detail: unknown }).detail]));
    }
    announceAgentStateChanged('settings');
    expect(seen).toEqual([
      [WILSON_AGENT_STATE_CHANGED_EVENT, { from: 'settings' }],
      [WILSON_GRANTS_CHANGED_EVENT, { from: 'settings' }],
    ]);
  });

  test('a subscriber hears the window events from other surfaces but not its own, and the channel always', async () => {
    const { onAgentStateChanged } = await load();
    let calls = 0;
    const off = onAgentStateChanged(() => calls++, 'panel');
    fakeWindow.dispatchEvent(new FakeCustomEvent(WILSON_AGENT_STATE_CHANGED_EVENT, { detail: { from: 'settings' } }));
    fakeWindow.dispatchEvent(new FakeCustomEvent(WILSON_GRANTS_CHANGED_EVENT, { detail: { from: 'panel' } })); // own echo
    expect(calls).toBe(1);
    postAgentStateChanged(FakeBroadcastChannel);
    await flush();
    expect(calls).toBe(2);
    off();
  });

  test('unsubscribing removes both window listeners and closes the channel', async () => {
    const { onAgentStateChanged } = await load();
    let calls = 0;
    const off = onAgentStateChanged(() => calls++, 'panel');
    expect(live()).toHaveLength(1);
    off();
    expect(live()).toHaveLength(0);
    fakeWindow.dispatchEvent(new FakeCustomEvent(WILSON_AGENT_STATE_CHANGED_EVENT, { detail: { from: 'settings' } }));
    postAgentStateChanged(FakeBroadcastChannel);
    await flush();
    expect(calls).toBe(0);
  });
});
