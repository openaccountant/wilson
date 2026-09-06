/**
 * OpenAI-compatible server utilities.
 *
 * Covers any server exposing the OpenAI REST API (llama.cpp, LM Studio, vLLM,
 * text-generation-webui, TabbyAPI, KoboldCpp, …). The base URL lives in
 * OPENAI_COMPATIBLE_BASE_URL; OPENAI_COMPATIBLE_API_KEY is optional since most
 * local servers do not authenticate.
 */

import { saveApiKeyToEnv } from './env.js';

/** llama.cpp's `llama-server` default. */
export const DEFAULT_OPENAI_COMPATIBLE_BASE_URL = 'http://localhost:8080/v1';

export const OPENAI_COMPATIBLE_BASE_URL_ENV = 'OPENAI_COMPATIBLE_BASE_URL';
export const OPENAI_COMPATIBLE_API_KEY_ENV = 'OPENAI_COMPATIBLE_API_KEY';

interface OpenAiModelList {
  data?: { id?: string }[];
}

/**
 * Normalizes a user-supplied server URL into an OpenAI API base URL.
 * Adds a scheme when missing and appends `/v1` when the URL has no path,
 * so both `localhost:1234` and `http://host/custom/v1` work.
 */
export function normalizeBaseUrl(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, '');
  if (!trimmed) return DEFAULT_OPENAI_COMPATIBLE_BASE_URL;

  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;

  try {
    const url = new URL(withScheme);
    if (url.pathname === '/' || url.pathname === '') {
      url.pathname = '/v1';
    }
    return url.toString().replace(/\/+$/, '');
  } catch {
    return withScheme;
  }
}

/** Resolves the configured base URL, falling back to the llama.cpp default. */
export function getOpenAiCompatibleBaseUrl(): string {
  const configured = process.env[OPENAI_COMPATIBLE_BASE_URL_ENV];
  return configured?.trim()
    ? normalizeBaseUrl(configured)
    : DEFAULT_OPENAI_COMPATIBLE_BASE_URL;
}

/** Most local servers ignore the key, but they still expect the header to exist. */
export function getOpenAiCompatibleApiKey(): string {
  return process.env[OPENAI_COMPATIBLE_API_KEY_ENV]?.trim() || 'not-needed';
}

/** Persists the base URL to .env so it survives restarts. Returns the normalized value. */
export function setOpenAiCompatibleBaseUrl(input: string): string | null {
  const normalized = normalizeBaseUrl(input);
  return saveApiKeyToEnv(OPENAI_COMPATIBLE_BASE_URL_ENV, normalized) ? normalized : null;
}

/**
 * Fetches the models served by the configured endpoint (GET /models).
 * Returns an empty array when the server is unreachable or does not implement it.
 */
export async function getOpenAiCompatibleModels(): Promise<string[]> {
  const apiKey = process.env[OPENAI_COMPATIBLE_API_KEY_ENV]?.trim();

  try {
    const response = await fetch(`${getOpenAiCompatibleBaseUrl()}/models`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    });

    if (!response.ok) {
      return [];
    }

    const data = (await response.json()) as OpenAiModelList;
    return (data?.data ?? [])
      .map((m) => m?.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
  } catch {
    // Server not running or unreachable
    return [];
  }
}
