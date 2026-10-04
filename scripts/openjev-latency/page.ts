/**
 * Harness page. Drives the SAME open-jev engine through the SAME message protocol in two hosts:
 *  - 'worker': the production bundle (dist-hybrid/prelabel-worker.js, built from src/prelabel/worker.ts)
 *  - 'main'  : createPrelabelEngine (worker-core.ts) on the main thread, wired exactly like worker.ts
 * Product code is untouched. Playwright calls window.__jev.* from run.mjs.
 */
import { env } from '@huggingface/transformers';
import { OpenJev } from 'open-jev';
import { createPrelabelEngine, type GpuLike, type OpenJevStatic, type TransformersEnvLike } from '../../src/dashboard/ui/src/prelabel/worker-core.js';
import type { FromWorker, PrelabelItem, PrelabelPins, ToWorker } from '../../src/dashboard/ui/src/prelabel/protocol.js';

type Mode = 'worker' | 'main';
type Chan = { send(m: ToWorker): void; close(): void };

const inbox: FromWorker[] = [];
const listeners = new Set<() => void>();
const onMsg = (m: FromWorker) => { inbox.push(m); for (const l of [...listeners]) l(); };

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
}

function openChannel(mode: Mode): Chan {
  inbox.length = 0;
  if (mode === 'worker') {
    const w = new Worker('/assets/prelabel-worker.js', { type: 'module' });
    w.onmessage = (ev) => onMsg(ev.data as FromWorker);
    w.onerror = (e) => onMsg({ v: 1, type: 'error', fatal: true, code: 'load', detail: `worker error: ${e.message}` });
    return { send: (m) => w.postMessage(m), close: () => w.terminate() };
  }
  // Same wiring as src/prelabel/worker.ts (keep in sync; see README "drift").
  const engine = createPrelabelEngine({
    loadOpenJev: async () => ({
      OpenJev: OpenJev as unknown as OpenJevStatic,
      env: env as unknown as TransformersEnvLike,
      ortVersion: (env as unknown as TransformersEnvLike).backends?.onnx?.versions?.web,
    }),
    now: () => performance.now(),
    gpu: (navigator as unknown as { gpu?: GpuLike }).gpu,
    fetchConfigSha: async (url) => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`config.json fetch failed: HTTP ${res.status}`);
      return sha256Hex(await res.arrayBuffer());
    },
    post: (m) => onMsg(m),
  });
  return { send: (m) => void engine.handle(m), close: () => {} };
}

function waitFor<T extends FromWorker>(pred: (m: FromWorker) => m is T, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const check = () => {
      const hit = inbox.find(pred);
      if (!hit) return false;
      listeners.delete(check);
      clearTimeout(t);
      resolve(hit);
      return true;
    };
    const t = setTimeout(() => {
      listeners.delete(check);
      reject(new Error(`timeout; last messages=${JSON.stringify(inbox.slice(-5))}`));
    }, timeoutMs);
    if (!check()) listeners.add(check);
  });
}

let chan: Chan | null = null;
let pins: PrelabelPins;
let labels: string[];
let assetBase = '/assets/';

const rpc = {
  async adapter() {
    const gpu = (navigator as unknown as { gpu?: { requestAdapter(): Promise<any> } }).gpu;
    const host = { crossOriginIsolated: self.crossOriginIsolated, userAgent: navigator.userAgent, hardwareConcurrency: navigator.hardwareConcurrency };
    if (!gpu) return { webgpu: false, reason: 'navigator.gpu undefined', ...host };
    let a;
    try { a = await gpu.requestAdapter(); } catch (e) { return { webgpu: false, reason: `requestAdapter threw: ${(e as Error).message}`, ...host }; }
    if (!a) return { webgpu: false, reason: 'requestAdapter() returned null', ...host };
    const i = a.info ?? {};
    return { webgpu: true, vendor: i.vendor, architecture: i.architecture, device: i.device, description: i.description,
      isFallbackAdapter: i.isFallbackAdapter ?? a.isFallbackAdapter ?? null, shaderF16: a.features.has('shader-f16'), ...host };
  },
  versions() {
    const e = env as unknown as TransformersEnvLike;
    return { transformers: e.version ?? null, ort: e.backends?.onnx?.versions?.web ?? null };
  },
  /** Open a fresh engine (new worker or new engine instance), init + probe. */
  async open(cfg: { mode: Mode; pins: PrelabelPins; labels: string[] }) {
    chan?.close();
    pins = cfg.pins; labels = cfg.labels;
    chan = openChannel(cfg.mode);
    chan.send({ v: 1, type: 'init', pins, labels, labelSetVersion: 'harness', assetBase });
    chan.send({ v: 1, type: 'probe' });
    const cap = await waitFor((m): m is Extract<FromWorker, { type: 'capability' }> => m.type === 'capability', 30000);
    return cap;
  },
  /** load + warmup decision. Wall time measured on the main thread around the whole thing. */
  async load() {
    const t0 = performance.now();
    chan!.send({ v: 1, type: 'load' });
    const done = await waitFor((m): m is Extract<FromWorker, { type: 'loaded' | 'error' | 'capability' }> =>
      m.type === 'loaded' || m.type === 'error' || (m.type === 'capability' && m.verdict !== 'ready'), 600000);
    return { wallMs: performance.now() - t0, msg: done };
  },
  /** Score rows through the engine's own run loop. Returns per-row decide ms (in-host) and the run wall. */
  async run(items: PrelabelItem[]) {
    const runId = `r${Math.random().toString(36).slice(2)}`;
    const base = inbox.length;
    const t0 = performance.now();
    chan!.send({ v: 1, type: 'run', runId, items });
    const done = await waitFor((m): m is Extract<FromWorker, { type: 'done' | 'error' }> =>
      (m.type === 'done' && m.runId === runId) || m.type === 'error', 600000);
    const wallMs = performance.now() - t0;
    if (done.type === 'error') return { ok: false as const, error: done };
    const rows = inbox.slice(base).flatMap((m) => (m.type === 'results' && m.runId === runId ? m.rows : []));
    return { ok: true as const, wallMs, done, rows };
  },
  async dispose() {
    chan?.send({ v: 1, type: 'dispose' });
    await new Promise((r) => setTimeout(r, 200));
  },
  close() { chan?.close(); chan = null; },
  /** Per-decision session re-creation: dispose, reload from cache, then score exactly one row. */
  async recreateThenRun(item: PrelabelItem) {
    await rpc.dispose();
    inbox.length = 0;
    const l = await rpc.load();
    const r = await rpc.run([item]);
    return { load: l, run: r };
  },
};
(window as unknown as { __jev: typeof rpc }).__jev = rpc;
(window as unknown as { __ready: boolean }).__ready = true;
