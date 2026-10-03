// Round 4 arm O measurement worker (no product code). Loads the pinned open-jev model
// (the pre-labeler's PRELABEL_MODEL pins, same repo/revision/configSha/dtype/temperature)
// on real WebGPU and answers one route decision per message, with the frozen route
// question and options from src/dashboard/ui/src/hybrid/openjev-route.ts.
//
// Mirrors the product engine's load rules (src/dashboard/ui/src/prelabel/worker-core.ts):
// every remote file comes from the pinned revision, config.json must hash to the pinned
// configSha before any weights download, and the runtime must resolve to webgpu/q4f16.
import { OpenJev } from 'open-jev';
import { env } from '@huggingface/transformers';
import {
  OPEN_JEV_ROUTE_QUESTION,
  routeChoiceQuestion,
  routeOptionTokens,
  type RouteOptionMode,
} from '../../src/dashboard/ui/src/hybrid/openjev-route.js';
import { topTwo } from '../../src/dashboard/ui/src/prelabel/core.js';

interface Pins {
  repo: string;
  revision: string;
  configSha: string;
  dtype: 'q4f16';
  device: 'webgpu';
  temperature: number;
}

interface Ctx {
  postMessage(m: unknown): void;
  onmessage: ((e: MessageEvent<any>) => void) | null;
}
const ctx = self as unknown as Ctx;

let pins: Pins | null = null;
let jev: Awaited<ReturnType<typeof OpenJev.load>> | null = null;

async function sha256Hex(url: string): Promise<string> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`config.json fetch ${r.status}`);
  const buf = await r.arrayBuffer();
  const d = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function handle(msg: any): Promise<unknown> {
  switch (msg.t) {
    case 'init': {
      pins = msg.pins as Pins;
      if (pins.device !== 'webgpu' || pins.dtype !== 'q4f16') throw new Error('unsupported pins');
      const e = env as any;
      e.allowLocalModels = false;
      e.remotePathTemplate = `{model}/resolve/${pins.revision}/`;
      if (e.backends?.onnx?.wasm) e.backends.onnx.wasm.wasmPaths = `${msg.origin}/assets/ort/`;
      return { transformers: e.version ?? null, ort: e.backends?.onnx?.versions ?? null };
    }
    case 'load': {
      if (!pins) throw new Error('not initialised');
      const t0 = performance.now();
      const host = ((env as any).remoteHost as string | undefined) ?? 'https://huggingface.co/';
      const base = host.endsWith('/') ? host : `${host}/`;
      const sha = await sha256Hex(`${base}${pins.repo}/resolve/${pins.revision}/config.json`);
      if (sha !== pins.configSha) throw new Error(`model_mismatch: config.json sha256 ${sha} != pinned ${pins.configSha}`);
      let loaded = 0;
      let total = 0;
      jev = await OpenJev.load({
        model: pins.repo,
        device: 'webgpu',
        dtype: 'q4f16',
        temperature: pins.temperature,
        truncation: 'cut',
        onProgress: (p) => {
          loaded = p.loaded;
          total = p.total;
        },
      });
      if (jev.runtime.device !== 'webgpu' || jev.runtime.dtype !== 'q4f16') {
        throw new Error(`runtime resolved to ${jev.runtime.device}/${jev.runtime.dtype}`);
      }
      const loadMs = performance.now() - t0;
      // First decision of the session (shader compile), as the product warmup measures it.
      const w0 = performance.now();
      await jev.decide('What is my net worth?', [routeChoiceQuestion('descriptions')], { temperature: pins.temperature, truncation: 'cut' });
      const firstDecisionMs = performance.now() - w0;
      return { loadMs, firstDecisionMs, progressLoaded: loaded, progressTotal: total, runtime: jev.runtime, configSha: sha };
    }
    case 'meta': {
      if (!jev) throw new Error('not loaded');
      const count = (s: string) => jev!.countTokens(s);
      return {
        question: OPEN_JEV_ROUTE_QUESTION,
        questionTokens: count(OPEN_JEV_ROUTE_QUESTION),
        optionTokens: { descriptions: routeOptionTokens(count, 'descriptions'), bare: routeOptionTokens(count, 'bare') },
      };
    }
    case 'choose': {
      if (!jev || !pins) throw new Error('not loaded');
      const mode: RouteOptionMode = msg.mode === 'bare' ? 'bare' : 'descriptions';
      const state = String(msg.q).slice(0, 512);
      const t0 = performance.now();
      const [a] = await jev.decide(state, [routeChoiceQuestion(mode)], { temperature: pins.temperature, truncation: 'cut' });
      const ms = performance.now() - t0;
      const top = topTwo((a as { probabilities: Record<string, number> }).probabilities);
      if (!top) throw new Error('decide returned fewer than two options');
      return { top1: top.top2[0][0], p1: top.p1, p2: top.p2, margin: top.margin, top2: top.top2, ms, stateTokens: jev.countTokens(state) };
    }
    case 'dispose': {
      await jev?.dispose();
      jev = null;
      return true;
    }
    default:
      throw new Error('unknown message ' + msg.t);
  }
}

// Sequential: one decide at a time on the one ORT session.
let queue: Promise<void> = Promise.resolve();
ctx.onmessage = (e) => {
  const { id } = e.data;
  queue = queue.then(async () => {
    try {
      ctx.postMessage({ id, ok: true, result: await handle(e.data) });
    } catch (err) {
      ctx.postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });
};
