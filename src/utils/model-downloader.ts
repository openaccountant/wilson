/**
 * Ollama model download via REST API, and Transformers.js model pre-download.
 */

export interface RecommendedModel {
  name: string;
  size: string;
  tags: readonly string[];
  desc: string;
}

// Curated models — prioritizes tool-calling support (critical for Open Accountant's agent loop),
// small size, and current-generation quality. Updated 2026-03.
// Sources: ollama.com/search?c=tools, HuggingFace SLM research, NVIDIA SLM-Agents paper.
export const RECOMMENDED_OLLAMA_MODELS: RecommendedModel[] = [
  // ── Tool-calling models (work with Open Accountant's agent tool system) ──────────
  { name: 'qwen3:0.6b',      size: '523 MB', tags: ['open', 'local', 'small'], desc: 'Alibaba — smallest tool-calling model' },
  { name: 'qwen3:4b',        size: '2.5 GB', tags: ['open', 'local', 'small'], desc: 'Alibaba — rivals 72B quality, tool-calling' },
  { name: 'qwen3:8b',        size: '5.2 GB', tags: ['open', 'local'],          desc: 'Alibaba — best balance, tool-calling' },
  { name: 'granite4:3b',     size: '2.1 GB', tags: ['open', 'local', 'small'], desc: 'IBM Granite 4 — tool-calling, 128K ctx' },
  { name: 'granite4:tiny-h', size: '4.2 GB', tags: ['open', 'local', 'small'], desc: 'IBM Granite 4 MoE — 7B, tool-calling' },
  { name: 'ministral-3:3b',  size: '2.1 GB', tags: ['open', 'local', 'small'], desc: 'Mistral — vision + tool-calling, 256K ctx' },

  // ── General-purpose small models ───────────────────────────────────────
  { name: 'gemma3:4b',       size: '3.3 GB', tags: ['open', 'local', 'small'], desc: 'Google — multimodal, 140+ languages' },
  { name: 'smollm2:1.7b',    size: '1.8 GB', tags: ['open', 'local', 'small'], desc: 'HuggingFace — tiny but capable' },
  { name: 'gemma3:1b',       size: '815 MB', tags: ['open', 'local', 'small'], desc: 'Google — ultralight, 32K ctx' },
  { name: 'granite4:350m',   size: '708 MB', tags: ['open', 'local', 'small'], desc: 'IBM — smallest Granite, edge-ready' },
];

/**
 * Pre-download a Transformers.js model to the local cache.
 * Triggers the same download that happens on first inference, but with progress reporting.
 * After this completes, the model loads from ~/.openaccountant/models/ in <2s.
 *
 * @param modelId - HuggingFace model ID (without 'transformers:' prefix), e.g. 'Xenova/Qwen2.5-0.5B-Instruct'
 * @param onProgress - callback receiving progress 0–100
 */
export async function pullTransformersModel(
  modelId: string,
  onProgress?: (pct: number) => void,
): Promise<void> {
  const { join } = await import('node:path');
  const { homedir } = await import('node:os');
  const { env, pipeline } = await import('@huggingface/transformers');

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (env as any).cacheDir = join(homedir(), '.openaccountant', 'models');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if ((env as any).backends?.onnx?.wasm) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (env as any).backends.onnx.wasm.proxy = false;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let lastFile = '';
  let filesDone = 0;
  let totalFiles = 0;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function progressCallback(progress: any) {
    if (!onProgress) return;
    if (progress.status === 'initiate') {
      totalFiles++;
    } else if (progress.status === 'done') {
      filesDone++;
      lastFile = progress.file ?? lastFile;
      const pct = totalFiles > 0 ? Math.round((filesDone / totalFiles) * 100) : 0;
      onProgress(pct);
    } else if (progress.status === 'progress' && progress.total) {
      // Per-file progress for large files
      const filePct = Math.round((progress.loaded / progress.total) * 100);
      const basePct = totalFiles > 0 ? Math.round((filesDone / totalFiles) * 100) : 0;
      onProgress(Math.min(basePct + Math.round(filePct / totalFiles), 99));
    }
  }

  await pipeline('text-generation', modelId, {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    progress_callback: progressCallback as any,
    device: 'cpu',
  });

  onProgress?.(100);
}

export async function pullOllamaModel(
  modelName: string,
  onProgress: (pct: number, status: string) => void,
): Promise<void> {
  const baseUrl = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
  const res = await fetch(`${baseUrl}/api/pull`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: modelName, stream: true }),
  });

  if (!res.ok) {
    throw new Error(`Failed to pull model: ${res.status} ${res.statusText}`);
  }

  if (!res.body) {
    throw new Error('No response body from Ollama');
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const data = JSON.parse(line);
        if (data.error) {
          throw new Error(data.error);
        }
        const status = data.status || '';
        let pct = 0;
        if (data.total && data.completed) {
          pct = Math.round((data.completed / data.total) * 100);
        }
        onProgress(pct, status);
      } catch (e) {
        if (e instanceof SyntaxError) continue;
        throw e;
      }
    }
  }
}
