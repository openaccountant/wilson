import {
  RequiresConnectionError,
  isNetworkError,
  resolveFetchOutcome,
} from './store/offline-writes';
// mirror-client deliberately does NOT import this module: its sync pulls must
// bypass the mirror fallback, so it uses its own authed fetch. This import only
// brings tryMirror, which is called at fetch time, never at module-eval time.
import { tryMirror } from './store/mirror-client';

const AUTH_KEY = 'wilson_auth_token';

export function getBaseUrl(): string {
  if (import.meta.env.DEV) return 'http://localhost:3141';
  return window.location.origin;
}

export async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const token = localStorage.getItem(AUTH_KEY);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options?.headers as Record<string, string>),
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  let res: Response;
  try {
    res = await fetch(`${getBaseUrl()}${path}`, {
      ...options,
      headers,
    });
  } catch (err) {
    // Connection-level failure only (server unreachable). HTTP errors below
    // mean the server answered, so they never fall back to the mirror. An
    // offline GET the mirror cannot serve becomes RequiresConnectionError —
    // the UI's explicit "unavailable offline" signal — instead of a raw
    // TypeError; mirrored GETs return the mirror's rows.
    if (isNetworkError(err)) {
      const method = (options?.method ?? 'GET').toUpperCase();
      const isWrite = method !== 'GET';
      const mirrored = isWrite ? null : await tryMirror(path).catch(() => null);
      const outcome = resolveFetchOutcome({ isWrite, networkError: true, mirrored });
      if (outcome === 'return-mirror') return mirrored as T;
      if (outcome === 'throw-requires-connection') {
        throw new RequiresConnectionError();
      }
    }
    throw err;
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`API ${res.status}: ${body || res.statusText}`);
  }

  return res.json() as Promise<T>;
}

/**
 * fetch with the auth token attached, returning the raw Response. Used by the
 * hybrid chat client, which needs Response objects rather than parsed JSON.
 */
export function authedFetch(path: string, options?: RequestInit): Promise<Response> {
  const token = localStorage.getItem(AUTH_KEY);
  const headers: Record<string, string> = {
    ...(options?.headers as Record<string, string> | undefined),
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  return fetch(`${getBaseUrl()}${path}`, { ...options, headers });
}