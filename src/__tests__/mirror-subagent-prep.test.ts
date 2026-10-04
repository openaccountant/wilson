import { describe, expect, test } from 'bun:test';
import { mirrorStatusViaPort, prepareMirrorForRun, type MirrorPrepDeps } from '../dashboard/ui/src/store/mirror-subagent.js';

/**
 * Main-thread mirror preparation for a subagent run (spec C4/C7/C8): the
 * freshness check, the bounded sync wait and the profile binding all happen
 * BEFORE `subagentRun` is posted, because the model worker cannot call
 * syncMirror(). Pure: every collaborator is injected.
 */

const NOW = Date.parse('2026-10-03T12:00:00.000Z');
const FRESH = new Date(NOW - 10_000).toISOString();
const OLD = new Date(NOW - 5 * 60_000).toISOString();

interface State {
  available: boolean;
  seeded: boolean;
  profile: string | null;
  lastSyncedAt: string | null;
}

function deps(initial: Partial<State>, over: Partial<MirrorPrepDeps> = {}) {
  const state: State = { available: true, seeded: true, profile: 'default', lastSyncedAt: FRESH, ...initial };
  const calls = { sync: 0, port: [] as string[] };
  const port = { id: 'port' } as unknown as MessagePort;
  const d: MirrorPrepDeps = {
    getState: () => state,
    syncMirror: async () => {
      calls.sync++;
    },
    fetchActiveProfile: async () => 'default',
    openToolPort: (p) => {
      calls.port.push(p);
      return port;
    },
    now: () => NOW,
    syncWaitMs: 50,
    ...over,
  };
  return { d, state, calls, port };
}

describe('prepareMirrorForRun', () => {
  test('fresh + right profile: ready, no sync, port bound to the server profile', async () => {
    const { d, calls, port } = deps({});
    const r = await prepareMirrorForRun(d);
    expect(r).toEqual({ kind: 'ready', port, expectedProfile: 'default', lastSyncedAt: FRESH });
    expect(calls.sync).toBe(0);
    expect(calls.port).toEqual(['default']);
  });

  test('mirror unavailable or never seeded: unavailable (bundle mode), no sync, no port', async () => {
    for (const s of [{ available: false }, { seeded: false }, { profile: null }]) {
      const { d, calls } = deps(s);
      expect(await prepareMirrorForRun(d)).toEqual({ kind: 'unavailable' });
      expect(calls.sync).toBe(0);
      expect(calls.port).toEqual([]);
    }
  });

  test('server unreachable for the profile lookup: unavailable', async () => {
    const { d } = deps({}, { fetchActiveProfile: async () => { throw new Error('offline'); } });
    expect(await prepareMirrorForRun(d)).toEqual({ kind: 'unavailable' });
  });

  test('older than 120 s: syncs first, then ready with the new timestamp', async () => {
    const { d, state, calls, port } = deps({ lastSyncedAt: OLD }, {});
    d.syncMirror = async () => {
      calls.sync++;
      state.lastSyncedAt = FRESH;
    };
    const r = await prepareMirrorForRun(d);
    expect(calls.sync).toBe(1);
    expect(r).toEqual({ kind: 'ready', port, expectedProfile: 'default', lastSyncedAt: FRESH });
  });

  test('sync does not finish within the wait: stale (and the port is not opened)', async () => {
    const { d, calls } = deps({ lastSyncedAt: OLD }, { syncMirror: () => new Promise(() => {}) });
    const t0 = Date.now();
    const r = await prepareMirrorForRun(d);
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(r).toEqual({ kind: 'stale', lastSyncedAt: OLD });
    expect(calls.port).toEqual([]);
  });

  test('sync finishes but the mirror is still old (server down): stale', async () => {
    const { d } = deps({ lastSyncedAt: OLD }, {});
    expect(await prepareMirrorForRun(d)).toEqual({ kind: 'stale', lastSyncedAt: OLD });
  });

  test('a profile switch: syncs to re-key, and only then is the port bound to the new profile', async () => {
    const { d, state, calls, port } = deps({ profile: 'old' }, { fetchActiveProfile: async () => 'new' });
    d.syncMirror = async () => {
      calls.sync++;
      state.profile = 'new';
      state.lastSyncedAt = FRESH;
    };
    const r = await prepareMirrorForRun(d);
    expect(r).toEqual({ kind: 'ready', port, expectedProfile: 'new', lastSyncedAt: FRESH });
    expect(calls.port).toEqual(['new']);
  });

  test('a profile switch the sync cannot complete: stale, never a port for the wrong profile', async () => {
    const { d, calls } = deps({ profile: 'old' }, { fetchActiveProfile: async () => 'new' });
    expect(await prepareMirrorForRun(d)).toEqual({ kind: 'stale', lastSyncedAt: FRESH });
    expect(calls.port).toEqual([]);
  });

  test('openToolPort returning null (mirror went away): unavailable', async () => {
    const { d } = deps({}, { openToolPort: () => null });
    expect(await prepareMirrorForRun(d)).toEqual({ kind: 'unavailable' });
  });

  test('never throws, even when syncMirror rejects or openToolPort throws', async () => {
    const a = deps({ lastSyncedAt: OLD }, { syncMirror: async () => { throw new Error('x'); } });
    expect((await prepareMirrorForRun(a.d)).kind).toBe('stale');
    const b = deps({}, { openToolPort: () => { throw new Error('y'); } });
    expect((await prepareMirrorForRun(b.d)).kind).toBe('unavailable');
  });
});

describe('mirrorStatusViaPort (dev-only debug helper)', () => {
  test('sends one status request on a fresh port, resolves the reply and closes the port', async () => {
    const posted: unknown[] = [];
    const port = {
      onmessage: null as null | ((e: { data: unknown }) => void),
      postMessage(m: unknown) {
        posted.push(m);
        queueMicrotask(() => port.onmessage?.({ data: { id: (m as { id: number }).id, ok: true, result: { seeded: true } } }));
      },
      close() {
        closed++;
      },
    };
    let closed = 0;
    const r = await mirrorStatusViaPort(() => port as unknown as MessagePort);
    expect(r).toEqual({ seeded: true });
    expect(posted).toEqual([{ id: 1, t: 'status' }]);
    expect(closed).toBe(1);
  });

  test('no port available resolves null', async () => {
    expect(await mirrorStatusViaPort(() => null)).toBeNull();
  });
});
