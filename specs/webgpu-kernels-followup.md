# WebGPU kernels: fast follow to the model manager

Status: plan (2026-11-07). Starts when `feat/model-manager` lands. Base: `main`.
Prior work:
- `docs/research/webgpu-kernels/`, the Sept 7 sweep in the monorepo. All 8 of its proposals were refuted as written.
- Issue #41 and `.github/workflows/kernels-watch.yml`, the monthly upstreaming watch.

## What changed since September

- **Kernel count.** The `webgpu-kernels` Hub org lists 221 kernel repos (207 at the Sept 1 launch). Joshua Lochner's Nov 2026 talk counts "over 3,000 kernels across 221 ops", because one op ships many variants (a matmul needs 50+ to run well everywhere).
- **Custom kernels behind the speed claims.** The headline in-browser numbers this month all come from custom kernels:
  - pi + LFM3-1.7B at about 300 tok/s
  - LFM3-Omni at about 280 tok/s
  - React Native on iPhone at about 80 tok/s

  That runtime is still unlicensed and unpublished, so we don't vendor it (chat-workspace D13).
- **Matmul gains.** The Sept blog's per-op benchmark beat ONNX Runtime Web by 2.57x geomean on an M4. Matmul, the op that dominates LLM decode, gained only about 14%.
- **Tunable kernels in the literature.** arXiv 2610.17321 (*GPU Goldmines*) reports tunable WebGPU matmul, matrix-vector multiply and flash attention, with a "kernel miner" and a results database shared across devices. On Llama/Qwen shapes: matmul 7.0x faster than ORT's WebGPU kernels and 1.41x faster than llama.cpp's, and prefill 1.48x faster end to end.
- **Integration status.** `@huggingface/kernels` is still browser-only and not wired into Transformers.js or ONNX Runtime. HF says it is upstreaming to ORT. As of this week the watch has found no merged upstreaming.

## Goal

Know, with our own numbers, where in-tab inference spends its time for the models we actually ship, and be ready to adopt faster kernels the day they reach a path we can depend on. Don't build a parallel runtime.

## Plan

### K1. Per-op lab, scratch only (never product)

A dev-only page under `scripts/kernels-lab/`, served by `bun` on localhost. It isn't bundled into the dashboard.

It runs `@huggingface/kernels@preview` ops against the **shapes of our catalog models**: Qwen3 0.6B, LFM3 1.7B, Granite 4.0 350M and Gemma 4 E2B. Shapes come from each model's `config.json` at its pinned revision (M2):
- matmul / matrix-vector multiply at prefill and decode shapes
- attention (GQA)
- RMSNorm and rotary

The comparison is the same op as a one-node ONNX graph in onnxruntime-web 1.31 (the version Transformers.js 4.3.2 ships). The output is JSON per device: `{ op, shape, kernelsMs, ortMs, speedup, adapter }`. Results go to `docs/research/webgpu-kernels/lab/<date>-<device>.json`.

The question K1 answers: for decode at our shapes, how much of the end-to-end tok/s (from the M6 benchmark) could faster kernels win, and in which ops?

### K2. Device spread

Run K1 and the M6 benchmark on the machines we demo on:
- MacBook (M-series)
- Demos-Mac-Mini
- one Windows/NVIDIA box, when available

Optionally, run HF's Fleet benchmark on the same machines (opt-in, per its instructions) so our numbers line up with HF's published ones. Stop rule: if K1 shows decode-side gains under 1.2x end to end for every catalog model, record that and park K3.

### K3. Adoption path

We take kernels only through a dependency we can pin and license-check. Options, in order:
1. **ORT-web upstream** (HF + ORT team). We'd get it by bumping onnxruntime-web, or Transformers.js. Our M1 bump checklist and the hybrid bundle checks already cover this. *Preferred.*
2. **A published, licensed, model-specific runtime** (for example if Xenova's LFM3 runtime ships with source and a license). This would be a separate engine behind `model-engine.ts`'s `TransformersModule` seam, selected per catalog entry with a new `runtime` field. Its cache key and revision pin would follow M2/M4.
3. **Our own WGSL.** Not planned. We would only consider it if K1 finds one op that dominates and nothing upstream moves for a quarter.

### K4. Watch upgrade

Extend `kernels-watch.yml`:
- track the `webgpu-kernels` org repo count, and kernels mentions in onnxruntime-web release notes
- link arXiv follow-ups to 2610.17321
- post a monthly comment on #41 with the K1 baseline delta when a new ORT-web or Transformers.js version appears

## Decisions to ask (before K1 starts)

1. Is a Windows/NVIDIA box available for K2, or is the run Apple-only?
2. Is Fleet in or out? It sends benchmark results to HF.
3. Should K3 option 2 stay open (a per-model runtime seam), or stay closed until upstream ORT is the only path?
