/**
 * Ollama model download via REST API
 */

export interface RecommendedModel {
  name: string;
  size: string;
  tags: readonly string[];
  desc: string;
}

export const RECOMMENDED_OLLAMA_MODELS: RecommendedModel[] = [
  { name: 'granite3-dense:2b', size: '1.6 GB', tags: ['open', 'local', 'small'], desc: 'IBM — fast categorization' },
  { name: 'granite3-dense:8b', size: '4.9 GB', tags: ['open', 'local'], desc: 'IBM — balanced quality' },
  { name: 'qwen3:4b', size: '2.6 GB', tags: ['open', 'local', 'small'], desc: 'Alibaba — multilingual' },
  { name: 'llama3.1:8b', size: '4.7 GB', tags: ['open', 'local'], desc: 'Meta — general purpose' },
  { name: 'mistral:7b', size: '4.1 GB', tags: ['open', 'local'], desc: 'Mistral — strong reasoning' },
  { name: 'deepseek-r1:8b', size: '4.9 GB', tags: ['open', 'local', 'reasoning'], desc: 'DeepSeek — chain-of-thought' },
  { name: 'phi4-mini:3.8b', size: '2.4 GB', tags: ['open', 'local', 'small'], desc: 'Microsoft — efficient' },
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
