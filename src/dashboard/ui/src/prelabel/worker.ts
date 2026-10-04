/**
 * Entry of the open-jev pre-labeler worker bundle (dist-hybrid/prelabel-worker.js).
 * A thin `self.onmessage` shim: all logic is in worker-core.ts (bun-tested).
 *
 * ONLY the prelabel vite build may import this file. The singlefile React
 * bundle must never reference it, `open-jev` or `onnxruntime`.
 *
 * The UI tsconfig has no WebWorker or WebGPU lib types, so `self` and
 * `navigator.gpu` are reached through structural casts (as hybrid/client.ts does).
 */
import { env } from '@huggingface/transformers';
import { OpenJev } from 'open-jev';
import { parseToWorker, type FromWorker } from './protocol.js';
import { createPrelabelEngine, type GpuLike, type OpenJevStatic, type TransformersEnvLike } from './worker-core.js';

type WorkerScope = {
  postMessage(msg: unknown): void;
  onmessage: ((ev: { data: unknown }) => void) | null;
};
const scope = self as unknown as WorkerScope;

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

const engine = createPrelabelEngine({
  // Static imports: the SAME transformers instance open-jev resolves (peer dependency, deduped).
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
  post: (msg: FromWorker) => scope.postMessage(msg),
});

// Do NOT chain or await here: a `cancel` must be handled while a `run` is in flight.
scope.onmessage = (ev) => {
  const msg = parseToWorker(ev.data);
  if (msg) void engine.handle(msg);
};
