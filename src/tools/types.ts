export interface ToolResult {
  data: unknown;
  sourceUrls?: string[];
}

export function formatToolResult(data: unknown, sourceUrls?: string[]): string {
  const result: ToolResult = { data };
  if (sourceUrls?.length) {
    result.sourceUrls = sourceUrls;
  }
  return JSON.stringify(result);
}

export function parseSearchResults(result: unknown): { parsed: unknown; urls: string[] } {
  let parsed: unknown;
  if (typeof result === 'string') {
    try {
      parsed = JSON.parse(result);
    } catch {
      parsed = result;
    }
  } else {
    parsed = result;
  }

  let urls: string[] = [];

  if (parsed && typeof parsed === 'object' && 'results' in parsed) {
    const results = (parsed as { results?: unknown[] }).results;
    if (Array.isArray(results)) {
      urls = results
        .map((r) => (r && typeof r === 'object' && 'url' in r ? (r as { url?: string }).url : null))
        .filter((url): url is string => Boolean(url));
    }
  } else if (Array.isArray(parsed)) {
    urls = parsed
      .map((r) => (r && typeof r === 'object' && 'url' in r ? (r as { url?: string }).url : null))
      .filter((url): url is string => Boolean(url));
  }

  return { parsed, urls };
}
