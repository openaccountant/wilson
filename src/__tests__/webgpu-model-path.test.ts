import { describe, test, expect } from 'bun:test';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import {
  checkWebGpuAvailable,
  WEBGPU_MODEL_PATTERNS,
} from '../model/providers/transformers.js';
import { getModelsForProvider } from '../utils/model.js';

/**
 * Layered coverage for the WebGPU model path (issue #39). Layers 1 and 2 run
 * everywhere, GPU or not. Layers 3 and 4 download ~600 MB and need a real GPU,
 * so they are opt-in via WILSON_GPU_TESTS=1 — see CONTRIBUTING.md.
 */

const GPU_TESTS = process.env.WILSON_GPU_TESTS === '1';
const GPU_MODEL = 'onnx-community/Qwen3-0.6B-ONNX';

async function loadOnnxBackend() {
  const entry = createRequire(import.meta.url).resolve('@huggingface/transformers');
  return (await import(
    join(dirname(entry), '..', 'src', 'backends', 'onnx.js')
  )) as { deviceToExecutionProviders(device: string): unknown[] };
}

// ---------------------------------------------------------------------------
// Layer 1 — EP resolution and model tagging. No GPU required.
// ---------------------------------------------------------------------------

describe('layer 1: execution provider resolution', () => {
  test('the webgpu device resolves to the webgpu EP', async () => {
    const { deviceToExecutionProviders } = await loadOnnxBackend();
    expect(deviceToExecutionProviders('webgpu')).toEqual(['webgpu']);
  });

  test('the cpu device still resolves to the cpu EP', async () => {
    const { deviceToExecutionProviders } = await loadOnnxBackend();
    expect(deviceToExecutionProviders('cpu')).toEqual(['cpu']);
  });
});

describe('layer 1: webgpu tags agree with WEBGPU_MODEL_PATTERNS', () => {
  const models = getModelsForProvider('transformers');
  const matchesPattern = (id: string) => WEBGPU_MODEL_PATTERNS.some((p) => id.includes(p));

  test('the provider actually lists models of both kinds', () => {
    expect(models.some((m) => m.tags?.includes('webgpu'))).toBe(true);
    expect(models.some((m) => !m.tags?.includes('webgpu'))).toBe(true);
  });

  for (const model of models) {
    const tagged = model.tags?.includes('webgpu') ?? false;
    test(`${model.id} is ${tagged ? '' : 'not '}dispatched to WebGPU`, () => {
      // A mismatch either hides a GPU model from the picker or sends a CPU
      // model down the webgpu path, which only fails after the download.
      expect(matchesPattern(model.id)).toBe(tagged);
    });
  }
});

// ---------------------------------------------------------------------------
// Layer 2 — capability probe. Runs on GPU-less CI without throwing.
// ---------------------------------------------------------------------------

describe('layer 2: capability probe', () => {
  test('checkWebGpuAvailable() returns a boolean and never throws', async () => {
    const available = await checkWebGpuAvailable();
    // Logged on purpose: CI runners have no GPU, so this line is the only
    // place the probe's `false` branch is observable (see #38).
    console.log(`[webgpu-model-path] checkWebGpuAvailable() -> ${available} on ${process.platform}/${process.arch}`);
    expect(typeof available).toBe('boolean');
  });

  test('the result is cached, so repeat calls agree', async () => {
    const first = await checkWebGpuAvailable();
    expect(await checkWebGpuAvailable()).toBe(first);
  });

  test('the model picker hides webgpu models exactly when unavailable', async () => {
    const available = await checkWebGpuAvailable();
    // Mirrors the filter in ModelSelectionController.handleProviderSelect.
    const offered = getModelsForProvider('transformers').filter((m) =>
      available ? true : !m.tags?.includes('webgpu'),
    );
    expect(offered.some((m) => m.tags?.includes('webgpu'))).toBe(available);
    // CPU models are offered either way — there is always something to pick.
    expect(offered.some((m) => !m.tags?.includes('webgpu'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Layers 3 and 4 — gated. Download ~600 MB and need a working GPU.
// ---------------------------------------------------------------------------

describe('layers 3-4: gated GPU generation (WILSON_GPU_TESTS=1)', () => {
  test.skipIf(!GPU_TESTS)(
    'layer 3: smoke — generates 16 tokens on the webgpu device',
    async () => {
      const { pipeline } = await import('@huggingface/transformers');
      const pipe = await pipeline('text-generation', GPU_MODEL, {
        device: 'webgpu',
        dtype: 'fp16',
      });
      const out = await pipe('Hello', { max_new_tokens: 16, do_sample: false });
      const text = (out as { generated_text: string }[])[0]?.generated_text ?? '';
      expect(text.length).toBeGreaterThan(0);
    },
    600_000,
  );

  test.skipIf(!GPU_TESTS)(
    'layer 4: soak — RSS stops growing across 30 generations',
    async () => {
      const { pipeline } = await import('@huggingface/transformers');
      const pipe = await pipeline('text-generation', GPU_MODEL, {
        device: 'webgpu',
        dtype: 'fp16',
      });

      const rss: number[] = [];
      for (let i = 0; i < 30; i++) {
        await pipe('Hello', { max_new_tokens: 16, do_sample: false });
        rss.push(process.memoryUsage().rss);
      }

      // Guards a regression of the oven-sh/bun#19322 class of FFI leak. Early
      // iterations legitimately grow as caches warm, so only the tail matters.
      const deltas = rss.slice(-10).map((v, i, a) => (i === 0 ? 0 : v - a[i - 1])).slice(1);
      const meanDelta = deltas.reduce((a, b) => a + b, 0) / deltas.length;
      expect(meanDelta).toBeLessThan(1024 * 1024);
    },
    900_000,
  );
});
