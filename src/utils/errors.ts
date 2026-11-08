export interface ApiErrorInfo {
  httpCode?: number;
  type?: string;
  code?: string;
  message?: string;
  requestId?: string;
}

export type ErrorType =
  | 'context_overflow'
  | 'rate_limit'
  | 'billing'
  | 'auth'
  | 'timeout'
  | 'overloaded'
  | 'model_not_found'
  | 'unknown';

type ErrorPattern = RegExp | string;

const ERROR_PATTERNS = {
  rateLimit: [
    /rate[_ ]limit|too many requests|429/i,
    'model_cooldown',
    'cooling down',
    'exceeded your current quota',
    'resource has been exhausted',
    'quota exceeded',
    'resource_exhausted',
    'usage limit',
    'tpm',
    'tokens per minute',
  ],
  overloaded: [
    /overloaded_error|"type"\s*:\s*"overloaded_error"/i,
    'overloaded',
    'service unavailable',
    'high demand',
  ],
  timeout: [
    'timeout',
    'timed out',
    'deadline exceeded',
    'context deadline exceeded',
  ],
  billing: [
    /["']?(?:status|code)["']?\s*[:=]\s*402\b/i,
    /\bhttp\s*402\b/i,
    'payment required',
    'insufficient credits',
    'credit balance',
    'insufficient balance',
  ],
  auth: [
    /invalid[_ ]?api[_ ]?key/i,
    'incorrect api key',
    'invalid token',
    'authentication',
    'unauthorized',
    'forbidden',
    'access denied',
    /\b401\b/,
    /\b403\b/,
    'no api key found',
  ],
  // Ollama: "model 'qwen3:8b' not found" (older builds: `model "x" not found, try pulling it first`).
  // OpenAI-compatible: "The model `x` does not exist", code model_not_found.
  modelNotFound: [
    /\bmodel\s+['"`][^'"`]+['"`]\s+not\s+found\b/i,
    /\bmodel\s+['"`][^'"`]+['"`]\s+does\s+not\s+exist\b/i,
    'model_not_found',
    'try pulling it first',
  ],
  contextOverflow: [
    'context length exceeded',
    'maximum context length',
    "this model's maximum context length",
    'prompt is too long',
    'request_too_large',
    'exceeds model context window',
    'context overflow',
    'exceed context limit',
    'model token limit',
    'your request exceeded model token limit',
  ],
} as const;

const CHINESE_CONTEXT_OVERFLOW = ['上下文过长', '上下文超出', '超出最大上下文'];
const ERROR_PAYLOAD_PREFIX_RE = /^\[[\w\s]+\]\s*|^(?:error|api\s*error)[:\s-]+/i;
const HTTP_STATUS_PREFIX_RE = /^(\d{3})\s+(.+)$/s;

export function parseApiErrorInfo(raw?: string): ApiErrorInfo | null {
  if (!raw) return null;

  let trimmed = raw.trim();
  if (!trimmed) return null;

  let httpCode: number | undefined;

  trimmed = trimmed.replace(ERROR_PAYLOAD_PREFIX_RE, '').trim();

  const httpMatch = trimmed.match(HTTP_STATUS_PREFIX_RE);
  if (httpMatch) {
    httpCode = Number.parseInt(httpMatch[1], 10);
    trimmed = httpMatch[2].trim();
  }

  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const requestId = typeof parsed.request_id === 'string'
      ? parsed.request_id
      : typeof parsed.requestId === 'string'
        ? parsed.requestId
        : undefined;

    if (parsed.error && typeof parsed.error === 'object' && !Array.isArray(parsed.error)) {
      const err = parsed.error as Record<string, unknown>;
      return {
        httpCode,
        type: typeof err.type === 'string' ? err.type : undefined,
        code: typeof err.code === 'string' ? err.code : undefined,
        message: typeof err.message === 'string' ? err.message : undefined,
        requestId,
      };
    }

    if (parsed.type === 'error' && parsed.error && typeof parsed.error === 'object' && !Array.isArray(parsed.error)) {
      const err = parsed.error as Record<string, unknown>;
      return {
        httpCode,
        type: typeof err.type === 'string' ? err.type : undefined,
        message: typeof err.message === 'string' ? err.message : undefined,
        requestId,
      };
    }

    if (typeof parsed.message === 'string') {
      return {
        httpCode,
        type: typeof parsed.type === 'string' ? parsed.type : undefined,
        code: typeof parsed.code === 'string' ? parsed.code : undefined,
        message: parsed.message,
        requestId,
      };
    }

    return null;
  } catch {
    return null;
  }
}

function matchesPatterns(raw: string, patterns: readonly ErrorPattern[]): boolean {
  const lower = raw.toLowerCase();
  return patterns.some((pattern) =>
    pattern instanceof RegExp ? pattern.test(raw) : lower.includes(pattern)
  );
}

export function isContextOverflowError(raw?: string): boolean {
  if (!raw) return false;
  const lower = raw.toLowerCase();

  if (lower.includes('tpm') || lower.includes('tokens per minute')) {
    return false;
  }

  if (matchesPatterns(raw, ERROR_PATTERNS.contextOverflow)) {
    return true;
  }

  if (CHINESE_CONTEXT_OVERFLOW.some(msg => raw.includes(msg))) {
    return true;
  }

  if (lower.includes('request size exceeds') && lower.includes('context')) {
    return true;
  }
  if (lower.includes('max_tokens') && lower.includes('exceed') && lower.includes('context')) {
    return true;
  }
  if (lower.includes('input length') && lower.includes('exceed') && lower.includes('context')) {
    return true;
  }
  if (lower.includes('413') && lower.includes('too large')) {
    return true;
  }

  return false;
}

export function isRateLimitError(raw?: string): boolean {
  return raw ? matchesPatterns(raw, ERROR_PATTERNS.rateLimit) : false;
}

export function isBillingError(raw?: string): boolean {
  return raw ? matchesPatterns(raw, ERROR_PATTERNS.billing) : false;
}

export function isAuthError(raw?: string): boolean {
  return raw ? matchesPatterns(raw, ERROR_PATTERNS.auth) : false;
}

export function isTimeoutError(raw?: string): boolean {
  return raw ? matchesPatterns(raw, ERROR_PATTERNS.timeout) : false;
}

export function isOverloadedError(raw?: string): boolean {
  return raw ? matchesPatterns(raw, ERROR_PATTERNS.overloaded) : false;
}

export function isModelNotFoundError(raw?: string): boolean {
  return raw ? matchesPatterns(raw, ERROR_PATTERNS.modelNotFound) : false;
}

/** The model name a model-not-found error quotes ('qwen3:8b'), or null. Only model-id characters survive. */
export function modelNameFromError(raw: string): string | null {
  const m = raw.match(/\bmodel\s+['"`]([^'"`]+)['"`]/i);
  if (!m) return null;
  const name = m[1].trim();
  return /^[\w.:/@+-]{1,200}$/.test(name) ? name : null;
}

export function classifyError(raw?: string): ErrorType {
  if (!raw) return 'unknown';

  // Before the others: the quoted model name could contain any of their words.
  if (isModelNotFoundError(raw)) return 'model_not_found';
  if (isContextOverflowError(raw)) return 'context_overflow';
  if (isRateLimitError(raw)) return 'rate_limit';
  if (isBillingError(raw)) return 'billing';
  if (isAuthError(raw)) return 'auth';
  if (isTimeoutError(raw)) return 'timeout';
  if (isOverloadedError(raw)) return 'overloaded';

  return 'unknown';
}

export function isNonRetryableError(raw?: string): boolean {
  const type = classifyError(raw);
  // A missing model stays missing until someone pulls it or picks another: retrying only repeats the call.
  return type === 'context_overflow' || type === 'billing' || type === 'auth' || type === 'model_not_found';
}

export function formatUserFacingError(raw: string, provider?: string): string {
  if (!raw.trim()) {
    return 'LLM request failed with an unknown error.';
  }

  const errorType = classifyError(raw);
  const info = parseApiErrorInfo(raw);
  const providerLabel = provider ? `${provider} ` : '';

  switch (errorType) {
    case 'context_overflow':
      return 'Context overflow: the conversation is too large for the model. ' +
        'Try starting a new conversation or use a model with a larger context window.';
    case 'rate_limit':
      return `${providerLabel}API rate limit reached. Please wait a moment and try again.`;
    case 'billing':
      return `${providerLabel}API key has run out of credits or has an insufficient balance. ` +
        'Check your billing dashboard and top up, or switch to a different API key.';
    case 'auth':
      return `${providerLabel}API key is invalid or expired. ` +
        'Check that your API key is correct in your environment variables.';
    case 'timeout':
      return 'LLM request timed out. Please try again.';
    case 'overloaded':
      return 'The AI service is temporarily overloaded. Please try again in a moment.';
    case 'model_not_found':
      return formatModelNotFound(raw, provider);
    case 'unknown':
    default:
      if (info?.message) {
        const prefix = info.httpCode ? `HTTP ${info.httpCode}` : 'LLM error';
        const type = info.type ? ` (${info.type})` : '';
        const requestId = info.requestId ? ` [request_id: ${info.requestId}]` : '';
        return `${prefix}${type}: ${info.message}${requestId}`;
      }

      if (raw.length > 300) {
        return `${raw.slice(0, 300)}...`;
      }

      return raw;
  }
}

/**
 * Plain-language setup steps for a chat model that isn't there (#182). An Ollama model is
 * named in the error (callLlm prefixes "[Ollama API]"); anything else gets the Settings step only.
 */
function formatModelNotFound(raw: string, provider?: string): string {
  const name = modelNameFromError(raw);
  const isOllama = /ollama/i.test(provider ?? '') || /\[ollama api\]|try pulling it first/i.test(raw);
  const quoted = name ? `"${name}"` : 'the configured model';
  if (isOllama) {
    return `The chat model ${quoted} isn't installed in Ollama yet, so nothing answered. To fix it, either:\n\n` +
      `1. Install it: run \`ollama pull ${name ?? '<model>'}\` in a terminal, then send your message again.\n` +
      '2. Or pick a model you already have in Settings → Models.';
  }
  const from = provider ? ` from ${provider}` : '';
  return `The chat model ${quoted} isn't available${from}, so nothing answered. ` +
    'Pick a different model in Settings → Models.';
}
