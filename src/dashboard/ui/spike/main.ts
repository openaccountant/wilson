/**
 * SPIKE HARNESS (not shipped) — src/dashboard/ui/spike/
 *
 * Proves (or refutes) that @huggingface/transformers 4.0.1 can load and
 * generate with device 'webgpu' inside a bundle the dashboard can serve, and
 * that the prebuilt hybrid chunk evaluates in a real browser. Findings are
 * recorded in docs/research/dashboard-webgpu-spike.md.
 *
 * Build + run (throwaway server + headless Chrome):
 *   cd src/dashboard/ui
 *   npx vite build --config vite.spike.config.ts
 *   bun spike/serve.ts           # serves spike/dist + dist-hybrid + ort
 *   google-chrome --headless=new --no-sandbox --enable-unsafe-webgpu \
 *     --use-angle=swiftshader --dump-dom --virtual-time-budget=600000 \
 *     http://localhost:8999/ | grep SPIKE-RESULT
 *
 * Query params:
 *   ?full=1 — also attempt the real dashboard model (Qwen3-0.6B, fp16, ~600MB)
 *             when the adapter reports the shader-f16 feature.
 *
 * Result lines are written as "SPIKE-RESULT: key=value" so a headless
 * --dump-dom run can be grepped.
 */

import { pipeline, env } from '@huggingface/transformers';

const out = document.getElementById('out') as HTMLPreElement | null;
const lines: string[] = ['SPIKE-RESULT: page=loaded'];

function record(key: string, value: string): void {
  const line = `SPIKE-RESULT: ${key}=${value}`;
  lines.push(line);
  console.log(line);
  if (out) out.textContent = lines.join('\n');
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timeout after ${ms}ms: ${label}`)), ms)),
  ]);
}

const TINY_MODEL = 'Xenova/llama2.c-stories15M'; // ~60MB — machinery proof only
const REAL_MODEL = 'onnx-community/Qwen3-0.6B-ONNX'; // the dashboard's fastModel

// Same-origin ort binaries (scripts/copy-ort-web-assets.ts output), main
// thread, no CDN — exactly the shipped configuration.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const onnx = (env as any).backends?.onnx;
if (onnx?.wasm) {
  onnx.wasm.wasmPaths = '/assets/ort/';
  onnx.wasm.proxy = false;
}
env.allowLocalModels = false;

async function main(): Promise<void> {
  record('userAgent', navigator.userAgent);

  // ── Layer 1: WebGPU API present ──────────────────────────────────────────
  const hasGpu = 'gpu' in navigator;
  record('gpu-present', String(hasGpu));

  // ── Layer 2: adapter request ─────────────────────────────────────────────
  let adapter: GPUAdapter | null = null;
  if (hasGpu) {
    try {
      adapter = await withTimeout(navigator.gpu.requestAdapter(), 20_000, 'requestAdapter');
    } catch (e) {
      record('adapter-error', e instanceof Error ? e.message : String(e));
    }
  }
  record('adapter', adapter ? 'ok' : 'null');
  if (adapter) {
    const features = [...adapter.features].join(',');
    record('adapter-features', features || '(none)');
    record('shader-f16', String(adapter.features.has('shader-f16')));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const info = (adapter as any).info ?? (adapter as any).requestAdapterInfoSync?.();
    if (info) record('adapter-info', `${info.vendor ?? '?'}/${info.architecture ?? '?'}`);
  }

  // ── Machinery proof: real pipeline + generation in this browser bundle ──
  // Uses a tiny model so the spike never depends on a 600MB download. Device
  // choice: webgpu when an adapter exists (fp32 needs no shader-f16), wasm as
  // the cross-check when webgpu machinery fails or no adapter exists.
  const forceFull = new URLSearchParams(location.search).get('full') === '1';
  const wantWebgpu = adapter !== null;
  const attempts: { device: 'webgpu' | 'wasm'; model: string; dtype: 'fp32' | 'fp16' }[] = [];
  if (wantWebgpu) attempts.push({ device: 'webgpu', model: TINY_MODEL, dtype: 'fp32' });
  attempts.push({ device: 'wasm', model: TINY_MODEL, dtype: 'fp32' });
  if (adapter && adapter.features.has('shader-f16') && forceFull) {
    attempts.unshift({ device: 'webgpu', model: REAL_MODEL, dtype: 'fp16' });
  }

  for (const a of attempts) {
    const key = `gen-${a.device}-${a.model.includes('Qwen3') ? 'qwen3-0.6B-fp16' : 'tiny-fp32'}`;
    const t0 = performance.now();
    try {
      let lastPct = -1;
      const pipe = await withTimeout(
        pipeline('text-generation', a.model, {
          device: a.device,
          dtype: a.dtype,
          progress_callback: (p: { status?: string; progress?: number; file?: string }) => {
            if (p.status === 'progress' && typeof p.progress === 'number') {
              const pct = Math.round(p.progress / 25) * 25;
              if (pct > lastPct) {
                lastPct = pct;
                record(`${key}-download`, `${pct}% (${p.file ?? ''})`);
              }
            }
          },
        }),
        a.model.includes('Qwen3') ? 900_000 : 300_000,
        `pipeline ${a.model}`,
      );
      record(`${key}-load`, `ok (${Math.round(performance.now() - t0)}ms)`);
      // The tiny stories model has no chat template — use a raw string prompt.
      // Qwen3 (the dashboard's fastModel) gets the real two-message chat array.
      const input = a.model.includes('Qwen3')
        ? [
            { role: 'system', content: 'You are a helpful assistant.' },
            { role: 'user', content: 'Reply with the single word OK.' },
          ]
        : 'Once upon a time';
      const result = await withTimeout(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (pipe as any)(input as any, { max_new_tokens: 32, do_sample: false }),
        120_000,
        `generate ${a.model}`,
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const gen = (result as any)[0]?.generated_text;
      const last = Array.isArray(gen) ? gen[gen.length - 1] : gen;
      const text =
        typeof last === 'object' && last !== null && 'content' in last
          ? String((last as { content: unknown }).content)
          : String(last ?? '');
      record(key, `ok (${Math.round(performance.now() - t0)}ms) output="${text.trim().slice(0, 60)}"`);
      if (!a.model.includes('Qwen3')) break; // machinery proven; stop after first success
      record('real-model', 'ok');
    } catch (e) {
      record(key, `FAIL ${e instanceof Error ? e.message : String(e)}`);
      if (a.model.includes('Qwen3')) record('real-model', 'fail');
    }
  }

  // ── Shipped-chunk check: does /assets/hybrid-chat.js evaluate? ──────────
  try {
    const res = await fetch('/assets/hybrid-chat.js');
    record('hybrid-chunk-http', String(res.status));
    if (res.ok) {
      // Variable specifier + @vite-ignore: leave this import untouched at build time.
      const chunkUrl = '/assets/hybrid-chat.js';
      const mod = (await import(/* @vite-ignore */ chunkUrl)) as {
        WilsonHybridChat?: { init(o: { baseUrl: string; fetchImpl: typeof fetch }): void; tryLocal(q: string): Promise<{ ok: boolean }> };
      };
      const hybrid = mod.WilsonHybridChat ?? window.WilsonHybridChat;
      record('hybrid-chunk-global', hybrid ? 'ok' : 'MISSING');
      if (hybrid) {
        hybrid.init({ baseUrl: '', fetchImpl: (...a) => fetch(...a) });
        // No API server here → must resolve {ok:false} (silent server path),
        // never throw. With no GPU it short-circuits even earlier.
        const t0 = performance.now();
        const r = await withTimeout(hybrid.tryLocal('test'), 30_000, 'tryLocal');
        record('hybrid-chunk-trylocal', `ok=${r.ok} (${Math.round(performance.now() - t0)}ms)`);
      }
    }
  } catch (e) {
    record('hybrid-chunk-trylocal', `FAIL ${e instanceof Error ? e.message : String(e)}`);
  }

  record('done', 'true');
}

void main().catch((e) => {
  record('fatal', e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e));
  record('done', 'true');
});