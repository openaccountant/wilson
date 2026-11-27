/**
 * Ollama API utilities
 */

interface OllamaModel {
  name: string;
  modified_at: string;
  size: number;
  remote_model?: string;
  remote_host?: string;
}

interface OllamaTagsResponse {
  models: OllamaModel[];
}

let remoteOllamaModels: ReadonlySet<string> = new Set();

export function isRemoteOllamaModel(model: string): boolean {
  return isOllamaModelInstalled(model.replace(/^ollama:/, ''), remoteOllamaModels);
}

/**
 * Fetches locally downloaded models from the Ollama API
 */
export async function getOllamaModels(): Promise<string[]> {
  return (await listOllamaModels()) ?? [];
}

/**
 * Like getOllamaModels, but null when Ollama could not be asked (not running,
 * unreachable, a non-OK reply) — so "no such model" is never claimed when the
 * truth is "couldn't check". Read-only GET to the configured Ollama only.
 */
export async function listOllamaModels(): Promise<string[] | null> {
  const baseUrl = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';

  try {
    const response = await fetch(`${baseUrl}/api/tags`);

    if (!response.ok) {
      return null;
    }

    const data = (await response.json()) as OllamaTagsResponse;
    const models = (data?.models ?? []).filter((m) => typeof m?.name === 'string');
    remoteOllamaModels = new Set(models.filter((m) => m.remote_model || m.remote_host).map((m) => m.name));
    return models.map((m) => m.name);
  } catch {
    // Ollama not running or unreachable
    return null;
  }
}

/**
 * Whether `name` (an Ollama model name, no "ollama:" prefix) is in `installed`.
 * A bare name means its ":latest" tag, as `ollama pull` / `ollama run` read it.
 */
export function isOllamaModelInstalled(name: string, installed: Iterable<string>): boolean {
  const want = name.includes(':') ? name : `${name}:latest`;
  for (const have of installed) {
    if (have === name || have === want) return true;
  }
  return false;
}
