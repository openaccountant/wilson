import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  pathsFor,
  shouldAbort,
  shouldStart,
  type ForecastQuality,
} from '../dashboard/ui/src/lib/netWorthForecastProtocol.js';
import { DRAG_PATHS, RELEASE_PATHS } from '../dashboard/ui/src/lib/netWorthForecast.js';
import { TAB_IDS as URL_TAB_IDS } from '../dashboard/ui/src/lib/urlState.js';
import { TAB_IDS } from '../dashboard/webmcp-session.js';

// Pure, dependency-free supersession/policy tests (no worker, no DOM, no
// timing) plus source-level architecture pins, following the readFileSync
// pattern in transformers-webgpu-ep.test.ts:2,15.

const repoRoot = join(import.meta.dir, '..', '..');
const uiSrc = join(repoRoot, 'src', 'dashboard', 'ui', 'src');

function read(...segments: string[]): string {
  return readFileSync(join(...segments), 'utf8');
}

describe('pathsFor', () => {
  test('draft -> 5,000, final -> 20,000, matching DRAG_PATHS / RELEASE_PATHS', () => {
    expect(pathsFor('draft')).toBe(5_000);
    expect(pathsFor('final')).toBe(20_000);
    expect(pathsFor('draft')).toBe(DRAG_PATHS);
    expect(pathsFor('final')).toBe(RELEASE_PATHS);
  });
});

describe('shouldStart', () => {
  test('accepts only a strictly-newer runId; a replay or out-of-order post is dropped', () => {
    expect(shouldStart(5, 4)).toBe(true);
    expect(shouldStart(4, 4)).toBe(false);
    expect(shouldStart(3, 4)).toBe(false);
  });
});

describe('shouldAbort', () => {
  test('aborts whenever the run is not the active one, in either direction', () => {
    expect(shouldAbort(4, 4)).toBe(false);
    expect(shouldAbort(4, 5)).toBe(true);
    expect(shouldAbort(5, 4)).toBe(true);
  });
});

describe('drag simulation', () => {
  test('only the final run survives; the three drafts before it abort', () => {
    // A tiny in-test reducer built from shouldStart/shouldAbort, mirroring how
    // the worker's onmessage (shouldStart -> maybe advance activeRunId) and
    // its in-flight loop (shouldAbort against the CURRENT activeRunId) interact.
    const requests: Array<{ runId: number; quality: ForecastQuality }> = [
      { runId: 1, quality: 'draft' },
      { runId: 2, quality: 'draft' },
      { runId: 3, quality: 'draft' },
      { runId: 4, quality: 'final' },
    ];

    let activeRunId = 0;
    const started: number[] = [];
    for (const req of requests) {
      if (shouldStart(req.runId, activeRunId)) {
        activeRunId = req.runId;
        started.push(req.runId);
      }
    }
    // All four are strictly newer than what preceded them, so the worker
    // starts each in turn (superseding, not queueing, the previous one).
    expect(started).toEqual([1, 2, 3, 4]);

    // Each run's in-flight chunk loop checks shouldAbort against whatever
    // activeRunId ended up being once all four requests had arrived — as if
    // runs 1-3 were still mid-chunk when run 4 (the release) landed.
    const survivors = requests.filter((req) => !shouldAbort(req.runId, activeRunId));
    const aborted = requests.filter((req) => shouldAbort(req.runId, activeRunId));

    expect(survivors).toEqual([{ runId: 4, quality: 'final' }]);
    expect(aborted.map((r) => r.runId)).toEqual([1, 2, 3]);
  });
});

// ── Driving the REAL hook source under a tiny hook runtime ─────────────────
//
// useNetWorthForecast.ts can't be imported from a root test: it pulls in
// `react` (a UI-workspace dependency) and, transitively,
// netWorthForecastClient.ts's `?worker&inline` import. But the scheduling
// policy under test is plain JavaScript over four injectable seams —
// requestAnimationFrame, cancelAnimationFrame, setTimeout, clearTimeout —
// plus createForecastClient and the five React hooks it uses, none of which
// need a DOM, a worker, or a reconciler.
//
// So: read the module's own source (same readFileSync pattern the pins below
// use), drop its import lines, transpile TS -> JS, and evaluate it with all
// nine of those names supplied as parameters. Parameters shadow globals, so
// the hook's bare `requestAnimationFrame(...)` / `setTimeout(...)` calls bind
// to the fakes. This is the actual shipped code path, not a restatement of
// it: edit the hook and these tests move with it.

let cachedHookFactory: HookFactory | null = null;

type HookFactory = (
  useCallback: (fn: unknown, deps?: unknown) => unknown,
  useEffect: (fn: () => (() => void) | void, deps?: unknown) => void,
  useRef: (init: unknown) => { current: unknown },
  useState: (init: unknown) => [unknown, (v: unknown) => void],
  createForecastClient: () => unknown,
  requestAnimationFrame: (cb: () => void) => number,
  cancelAnimationFrame: (id: number) => void,
  setTimeout: (cb: () => void, ms: number) => number,
  clearTimeout: (id: number) => void,
) => () => HookApi;

interface HookApi {
  refining: boolean;
  progress: number;
  quality: ForecastQuality | null;
  error: string | null;
  onInputChange(input: unknown): void;
  onInputSettled(input: unknown): void;
}

function loadHookFactory(): HookFactory {
  if (cachedHookFactory) return cachedHookFactory;
  const source = read(uiSrc, 'hooks', 'useNetWorthForecast.ts');
  // Every import in this module is either type-only or one of the two value
  // imports we inject by parameter, so all of them can go.
  const stripped = source.replace(/^import[^;]*;$/gm, '').replace(/^export /gm, '');
  const js = new Bun.Transpiler({ loader: 'ts' }).transformSync(stripped);
  cachedHookFactory = new Function(
    'useCallback',
    'useEffect',
    'useRef',
    'useState',
    'createForecastClient',
    'requestAnimationFrame',
    'cancelAnimationFrame',
    'setTimeout',
    'clearTimeout',
    `${js}\nreturn useNetWorthForecast;`,
  ) as unknown as HookFactory;
  return cachedHookFactory;
}

interface RecordedPost {
  runId: number;
  quality: ForecastQuality;
}

function createHarness() {
  // ── recorded worker posts ──
  const posts: RecordedPost[] = [];
  let nextRunId = 0;
  const client = {
    request(_input: unknown, quality: ForecastQuality): number {
      const id = ++nextRunId;
      posts.push({ runId: id, quality });
      return id;
    },
    subscribe(_fn: unknown): () => void {
      return () => {};
    },
    // The real client keeps serving requests after dispose() — ensureWorker()
    // respawns — which matters here because StrictMode disposes and remounts
    // without ever rebuilding clientRef.
    dispose(): void {},
  };

  // ── fake vsync ──
  let nextFrameId = 0;
  const frames = new Map<number, () => void>();
  const raf = (cb: () => void): number => {
    const id = ++nextFrameId;
    frames.set(id, cb);
    return id;
  };
  const caf = (id: number): void => {
    frames.delete(id);
  };
  const flushFrame = (): void => {
    const due = [...frames.values()];
    frames.clear();
    for (const cb of due) cb();
  };

  // ── fake clock ──
  let nextTimerId = 0;
  let clock = 0;
  const timers = new Map<number, { at: number; cb: () => void }>();
  const st = (cb: () => void, ms: number): number => {
    const id = ++nextTimerId;
    timers.set(id, { at: clock + ms, cb });
    return id;
  };
  const ct = (id: number): void => {
    timers.delete(id);
  };
  const advance = (ms: number): void => {
    clock += ms;
    const due = [...timers.entries()]
      .filter(([, t]) => t.at <= clock)
      .sort((a, b) => a[1].at - b[1].at);
    for (const [id, t] of due) {
      timers.delete(id);
      t.cb();
    }
  };

  // ── minimal hook runtime (one persistent component instance) ──
  const cells: unknown[] = [];
  let cursor = 0;
  const effects: Array<() => (() => void) | void> = [];
  let effectsCollected = false;
  let cleanups: Array<() => void> = [];

  const useRefShim = (init: unknown): { current: unknown } => {
    const idx = cursor++;
    if (cells[idx] === undefined) cells[idx] = { current: init };
    return cells[idx] as { current: unknown };
  };
  const useStateShim = (init: unknown): [unknown, (v: unknown) => void] => {
    const idx = cursor++;
    if (cells[idx] === undefined) {
      const cell: [unknown, (v: unknown) => void] = [
        init,
        (v: unknown) => {
          cell[0] = typeof v === 'function' ? (v as (p: unknown) => unknown)(cell[0]) : v;
        },
      ];
      cells[idx] = cell;
    }
    return cells[idx] as [unknown, (v: unknown) => void];
  };
  const useCallbackShim = (fn: unknown): unknown => fn;
  // StrictMode re-runs the effect closures from the SAME render pass, so they
  // are collected once and replayed on every mount.
  const useEffectShim = (fn: () => (() => void) | void): void => {
    if (!effectsCollected) effects.push(fn);
  };

  const hook = loadHookFactory()(
    useCallbackShim,
    useEffectShim,
    useRefShim,
    useStateShim,
    () => client,
    raf,
    caf,
    st,
    ct,
  );

  let api: HookApi | null = null;
  const render = (): HookApi => {
    cursor = 0;
    api = hook();
    effectsCollected = true;
    return api;
  };
  const mountEffects = (): void => {
    cleanups = effects.map((fn) => fn() ?? (() => {}));
  };
  const unmount = (): void => {
    for (const c of cleanups) c();
    cleanups = [];
  };

  return {
    posts,
    render,
    mountEffects,
    unmount,
    flushFrame,
    advance,
    pendingFrames: (): number => frames.size,
    onInputChange: (input: unknown): void => api!.onInputChange(input),
    onInputSettled: (input: unknown): void => api!.onInputSettled(input),
  };
}

/** Replays the worker's own accept rule over the recorded posts. */
function survivingRun(posts: RecordedPost[]): RecordedPost | undefined {
  let active = 0;
  for (const p of posts) if (shouldStart(p.runId, active)) active = p.runId;
  return posts.find((p) => p.runId === active);
}

const INPUT_A = { tag: 'a' } as const;
const INPUT_B = { tag: 'b' } as const;

describe('drag/release scheduling (real hook source, fake rAF + fake clock)', () => {
  test('control: a release AFTER the frame lands leaves draft-then-final, final newest', () => {
    // Proves the harness is not trivially always-final: when the vsync gets
    // there first (release >= ~7ms after the last input event) both tiers post.
    const h = createHarness();
    h.render();
    h.mountEffects();

    h.onInputChange(INPUT_A);
    h.flushFrame();
    h.onInputSettled(INPUT_A);

    expect(h.posts).toEqual([
      { runId: 1, quality: 'draft' },
      { runId: 2, quality: 'final' },
    ]);
    expect(survivingRun(h.posts)?.quality).toBe('final');
  });

  test('a release INSIDE the pending draft frame must not be superseded by that draft', () => {
    // The reproduced defect: pointerup arrives before the next vsync, so the
    // rAF armed by the last onInputChange is still pending when the 'final'
    // is posted. If it is not cancelled it runs afterwards, issues a NEWER
    // runId at 5,000 paths, the worker aborts the 20,000-path final, and
    // nothing re-arms — the UI settles on the draft with no "refining"
    // indicator until the user touches a control again.
    const h = createHarness();
    h.render();
    h.mountEffects();

    h.onInputChange(INPUT_A);
    expect(h.pendingFrames()).toBe(1);

    h.onInputSettled(INPUT_A); // pointerup, same frame
    h.flushFrame(); // the vsync the browser still owed us

    expect(h.posts).toEqual([{ runId: 1, quality: 'final' }]);
    expect(survivingRun(h.posts)?.quality).toBe('final');
    expect(h.render().refining).toBe(true);
  });

  test('the settle timer is not re-armed by the stale draft, so nothing re-escalates', () => {
    // Second half of the same failure: postDraft arms no settle timer, so a
    // draft that sneaks in after the final leaves the UI permanently stuck.
    // Advancing well past SETTLE_MS must produce no further posts at all.
    const h = createHarness();
    h.render();
    h.mountEffects();

    h.onInputChange(INPUT_A);
    h.onInputSettled(INPUT_A);
    h.flushFrame();
    h.advance(1_000);

    expect(h.posts).toEqual([{ runId: 1, quality: 'final' }]);
  });

  test('the draft tier survives StrictMode mount/unmount/remount', () => {
    // main.tsx wraps the app in <StrictMode>, so in dev every effect mounts,
    // unmounts and remounts once. The unmount cleanup cancels the pending
    // rAF; if it leaves the dead handle in rafRef, the `rafRef.current == null`
    // guard in onInputChange is false forever and the draft tier is dead for
    // the entire dev session — which is where manual drag QA happens.
    const h = createHarness();
    h.render();
    h.mountEffects();

    h.onInputChange(INPUT_A); // as ForecastTab's mount effect does
    h.unmount(); // StrictMode's dev-only cleanup
    h.mountEffects(); // StrictMode remounts

    h.onInputChange(INPUT_B);
    h.flushFrame();
    h.advance(250);

    expect(h.posts.map((p) => p.quality)).toEqual(['draft', 'final']);
  });
});

describe('worker boundary (source pin)', () => {
  test('ForecastTab.tsx never runs the simulation on the main thread', () => {
    const source = read(uiSrc, 'tabs', 'ForecastTab.tsx');
    // The invariant is behavioural, not about import spelling: the tab may
    // freely use the module's pure helpers (deriveNetWorthInputs,
    // savingsDeltaToDollars, the UI-bound constants), but it must never reach
    // for an entry point that actually simulates. Naming the entry points
    // directly catches that regardless of whether the import is written as
    // '@/lib/netWorthForecast' or './netWorthForecast.js' — an import-path
    // pattern alone would let the alias form through.
    expect(source).not.toMatch(/\brunNetWorthForecast\b/);
    expect(source).not.toMatch(/\bsimulateNetWorth\b/);
  });

  test('useNetWorthForecast.ts never runs the simulation on the main thread', () => {
    // The hook is the natural place for a "just compute it here if the worker
    // is slow/unavailable" fallback to creep in, and it is the one module in
    // the slice that already owns the input, the quality policy and the error
    // state — everything such a fallback would need. Same behavioural test as
    // the tab's: the hook may use the module's pure helpers and types, but
    // must never name an entry point that actually simulates.
    const source = read(uiSrc, 'hooks', 'useNetWorthForecast.ts');
    expect(source).not.toMatch(/\brunNetWorthForecast\b/);
    expect(source).not.toMatch(/\bsimulateNetWorth\b/);
  });

  test('netWorthForecastClient.ts spawns the worker via the inline-worker precedent', () => {
    const source = read(uiSrc, 'lib', 'netWorthForecastClient.ts');
    expect(source).toContain('./netWorthForecast.worker.ts?worker&inline');
  });
});

describe('single-file build invariant', () => {
  test('vite.config.ts keeps viteSingleFile() and the ES-module worker format', () => {
    const source = read(repoRoot, 'src', 'dashboard', 'ui', 'vite.config.ts');
    expect(source).toContain('viteSingleFile()');
    expect(source).toMatch(/format:\s*'es'/);
  });
});

describe('tab registration lockstep', () => {
  // The ids live in one list (TAB_IDS, webmcp-session.ts; tab-ids-parity.test.ts pins that nothing else lists them).
  // What is left to keep in step is every map keyed by a tab id: the tab bar's labels and the app's components.
  function extractRecordKeys(source: string, declaration: RegExp, what: string): string[] {
    const block = source.match(declaration);
    if (!block) throw new Error(`could not locate ${what}`);
    const ids: string[] = [];
    const keyRe = /^\s*([a-z0-9-]+):\s*\S+?,?\s*$/gm;
    let m: RegExpExecArray | null;
    while ((m = keyRe.exec(block[1])) !== null) ids.push(m[1]);
    return ids;
  }

  test('TAB_LABELS and TAB_COMPONENTS have exactly the TAB_IDS keys, in order, and include forecast', () => {
    const tabBarSource = read(uiSrc, 'components', 'TabBar.tsx');
    const appSource = read(uiSrc, 'App.tsx');

    const labelKeys = extractRecordKeys(tabBarSource, /const TAB_LABELS: Record<TabId, string> = \{([\s\S]*?)\};/, 'the TAB_LABELS map');
    const componentKeys = extractRecordKeys(appSource, /const TAB_COMPONENTS: Record<TabId, React\.FC> = \{([\s\S]*?)\};/, 'the TAB_COMPONENTS map');

    expect(labelKeys).toEqual([...TAB_IDS]);
    expect(componentKeys).toEqual([...TAB_IDS]);
    expect(TAB_IDS).toContain('forecast');
    // The URL-hash parser (lib/urlState.ts) reads the same list.
    expect([...URL_TAB_IDS]).toEqual([...TAB_IDS]);
  });
});

describe('root-purity pin', () => {
  test('forecastCore.ts, netWorthForecast.ts and netWorthForecastProtocol.ts stay pure/DOM-free', () => {
    for (const file of ['forecastCore.ts', 'netWorthForecast.ts', 'netWorthForecastProtocol.ts']) {
      const source = read(uiSrc, 'lib', file);
      expect(source).not.toContain('import.meta');
      expect(source).not.toContain('?worker');
      expect(source).not.toMatch(/from ['"]react['"]/);
    }
  });
});
