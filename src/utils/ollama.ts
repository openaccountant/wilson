/**
 * Ollama API utilities
 */

interface OllamaModel {
  name: string;
  modified_at: string;
  size: number;
}

interface OllamaTagsResponse {
  models: OllamaModel[];
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
    return (data?.models ?? [])
      .map((m) => m?.name)
      .filter((n): n is string => typeof n === 'string');
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
