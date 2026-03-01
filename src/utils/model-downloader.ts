/**
 * Ollama model download via REST API
 */

export interface RecommendedModel {
  name: string;
  size: string;
  tags: readonly string[];
  desc: string;
}

// Curated models — prioritizes tool-calling support (critical for Wilson's agent loop),
// small size, and current-generation quality. Updated 2026-03.
// Sources: ollama.com/search?c=tools, HuggingFace SLM research, NVIDIA SLM-Agents paper.
export const RECOMMENDED_OLLAMA_MODELS: RecommendedModel[] = [
  // ── Tool-calling models (work with Wilson's agent tool system) ──────────
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
