// Slice 8 measurement page (no product code). Exposes window.__eval for the
// Playwright driver. The main thread owns only the gate (as client.ts does) and,
// for Round 4 arm O, the open-jev route decision (as client.ts will, spec §4.3).
import EvalWorker from './eval.worker.ts?worker&inline';
import OpenJevWorker from './openjev.worker.ts?worker&inline';
import { gateQuestion, keywordRoute } from '../../src/dashboard/ui/src/hybrid/subagent-core.js';
import { detectComparisonIntent } from '../../src/dashboard/ui/src/hybrid/subagent-intent.js';
import { OPEN_JEV_ROUTE_CUT, decideRoute, type ToolChoice } from '../../src/dashboard/ui/src/hybrid/openjev-route.js';

type Pending = Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>;

function rpc(make: () => Worker) {
  let worker: Worker | null = null;
  let seq = 0;
  const pending: Pending = new Map();
  return {
    spawn() {
      worker?.terminate();
      for (const [, p] of pending) p.reject(new Error('worker respawned'));
      pending.clear();
      worker = make();
      worker.onmessage = (e) => {
        const p = pending.get(e.data.id);
        if (!p) return;
        pending.delete(e.data.id);
        e.data.ok ? p.resolve(e.data.result) : p.reject(new Error(e.data.error));
      };
    },
    call(msg: Record<string, unknown>): Promise<any> {
      const id = ++seq;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        worker!.postMessage({ id, ...msg });
      });
    },
  };
}

const model = rpc(() => new (EvalWorker as any)() as Worker);
const oj = rpc(() => new (OpenJevWorker as any)() as Worker);

(window as any).__eval = {
  spawn: () => model.spawn(),
  init: (cfg: unknown) => model.call({ t: 'init', origin: location.origin, ...(cfg as object) }),
  load: () => model.call({ t: 'load' }),
  /** Main-thread gate, timed the way client.ts runs it (before any model or port work). */
  gate(q: string) {
    const s = performance.now();
    const g = gateQuestion(q);
    const gateMs = performance.now() - s;
    const hits = g.kind === 'route' ? keywordRoute(q) : [];
    // Round 4: what-if / comparison / trend phrasing is handed off by the core before routing, so open-jev never sees it.
    const shape = g.kind === 'route' ? detectComparisonIntent(q) : null;
    return { gate: g.kind, gateMs, hits, shape };
  },
  run: (q: string, nowIso: string, persona?: string | null, limits?: unknown, routeHint?: unknown) =>
    model.call({ t: 'run', q, nowIso, persona: persona ?? null, limits, ...(routeHint ? { routeHint } : {}) }),
  // ── Round 4 arm O ──
  routeCut: () => OPEN_JEV_ROUTE_CUT,
  ojSpawn: () => oj.spawn(),
  ojInit: (pins: unknown) => oj.call({ t: 'init', pins, origin: location.origin }),
  ojLoad: () => oj.call({ t: 'load' }),
  ojMeta: () => oj.call({ t: 'meta' }),
  ojDispose: () => oj.call({ t: 'dispose' }),
  choose: (q: string, mode?: string) => oj.call({ t: 'choose', q, mode }),
  /** The pure route decision with the frozen cut compiled into this page (or an explicit one for dev analysis). */
  decide: (hits: string[], choice: ToolChoice | null, cut?: number | null) => decideRoute(hits, choice, cut === undefined ? OPEN_JEV_ROUTE_CUT : cut),
};
(window as any).__evalReady = true;
