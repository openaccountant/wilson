# Spike: transformers.js 4.0.1 WebGPU in the dashboard browser bundle

**Verdict: WORKS (with one environment constraint, recorded below).**

The hybrid slice proceeded on this verdict. This note records what the spike
proved, in which browser, and what remains for the manual matrix (real-GPU
hardware).

## What was spiked

`@huggingface/transformers` 4.0.1 (root-pinned exact version, already a server-side
dependency) loaded and generating with `device: 'webgpu'` **inside a browser
bundle the dashboard can serve** — the known friction being the React UI's
`vite-plugin-singlefile` inlining everything into one HTML, which was expected
to fight onnxruntime-web's wasm/worker assets.

Harness: `src/dashboard/ui/spike/` (not shipped; see its header comment for the
rebuild/run commands). Driver: `spike/drive.ts` launches headless Chrome over
CDP and polls the results in real time — `--dump-dom --virtual-time-budget`
burns through page timers instantly and produces spurious timeouts, so don't
use it for this.

## Results (Headless Chrome 145, Linux x86_64, SwiftShader WebGPU adapter)

| Check | Result |
|---|---|
| `navigator.gpu` present | true |
| `requestAdapter()` | ok — adapter `google/swiftshader` |
| adapter features | includes `subgroups`, `timestamp-query`, … but **no `shader-f16`** |
| `pipeline('text-generation', 'Xenova/llama2.c-stories15M', { device: 'webgpu', dtype: 'fp32' })` | **load ok (2.8s)** |
| real generation through the WebGPU EP | **ok (10.8s)** — real text out: `Once upon a time, there was a little girl named Lily…` |
| prebuilt hybrid chunk `/assets/hybrid-chat.js` served same-origin | HTTP 200, module evaluates, `window.WilsonHybridChat` defined |
| `tryLocal('test')` with no API server | resolves `{ok:false}` in 2ms — the silent-hand-off contract holds in a real browser, nothing throws |
| ort wasm binaries served same-origin at `/assets/ort/` | HTTP 200, `application/wasm` |

## Findings that shaped the shipped architecture

1. **Two build variants were tried, as planned:**
   - **(a) Plain vite build + same-origin ort binaries (SHIPPED):** works. The
     trick is vite's `resolve.conditions: ['onnxruntime-web-use-extern-wasm']`
     in `vite.hybrid.config.ts` — it selects onnxruntime-web's *non-bundled*
     variant, so the `.wasm` binaries are **not** inlined into the chunk as
     base64. ORT fetches them at runtime from
     `env.backends.onnx.wasm.wasmPaths = /assets/ort/` (copied next to the
     chunk by `scripts/copy-ort-web-assets.ts`, served publicly by the
     dashboard server). Chunk size: 1.2MB (240KB gzipped).
     Without that condition, vite silently resolves the bundled variant and
     the chunk balloons to 62MB of base64-embedded wasm.
   - **(b) singlefile inlining:** confirmed the predicted fight. With default
     conditions the single HTML balloons to **59MB** (base64 wasm inlined).
     With the extern-wasm condition it builds, but still drags transformers.js
     into the React bundle for no benefit. **The shipped path keeps
     transformers.js out of the singlefile HTML entirely**: it is bundled only
     into `dist-hybrid/hybrid-chat.js`, which both UIs load at runtime.
2. **`shader-f16` is the environment constraint.** WebGPU generation itself
   works in a browser (proven above at fp32), but the dashboard model runs
   `dtype: 'fp16'`, which requires the GPU `shader-f16` feature. SwiftShader
   (and older GPUs generally) lacks it, so fp16 session creation would fail
   **after** the ~600MB download. This is exactly the failure path the layered
   capability check covers: layers 1–2 (adapter present) pass, layer 3 (a real
   ~16-token generation inside `loadModel`) fails → verdict `failed` cached for
   the session → silent server path. Do not skip layer 3.
3. **Chat templates matter for the harness, not the app.** A messages-array
   generation throws on models without a chat template (the tiny stories model
   has none); Qwen3-0.6B has one. The app always sends `{role, content}`
   arrays to the dashboard model — fine.
4. **Model files download straight from the HF Hub** in the browser (302 →
   CDN, observed in the spike) and are cached by the browser Cache API —
   Track D's first-load UX stands, with progress labels from
   `progress_callback`.

## Not exercised in this environment (manual matrix)

- The real dashboard model (`onnx-community/Qwen3-0.6B-ONNX`, fp16, ~600MB)
  end-to-end **on hardware with `shader-f16`** (real Chrome/Edge on a real
  GPU). The spike environment (SwiftShader, no f16) would fail it at session
  creation by design — that failure path is covered, but the "local answer with
  matching figures" acceptance criterion needs the manual check.
- First-load download timing at ~600MB and browser Cache API warm reload.
- Safari/Firefox (no WebGPU) — server-path fallback is covered by
  `hybrid-chunk-trylocal={ok:false}` semantics plus the `unavailable` probe
  layers, but the real browsers should be eyeballed once.