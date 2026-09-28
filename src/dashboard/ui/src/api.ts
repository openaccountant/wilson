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

  const res = await fetch(`${getBaseUrl()}${path}`, {
    ...options,
    headers,
  });

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
