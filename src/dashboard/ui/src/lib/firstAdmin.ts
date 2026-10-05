/**
 * Settings > Security: the first-admin form (#157).
 *
 * With dashboard auth off and no users, `PATCH /api/auth/config {auth_enabled:true}` is refused (409): turning auth
 * on with nobody to log in would let the first caller of `/api/auth/setup` become admin. The first enable goes
 * through `POST /api/auth/setup`, which creates the admin and switches auth on in one transaction. These are the
 * pure decisions behind that form, kept out of the component so they can be tested without a DOM.
 */

/** The part of GET /api/auth/status the form needs. */
export interface AuthStatusLike {
  authEnabled: boolean;
  userCount: number;
}

/** What the person typed. */
export interface FirstAdminInput {
  username: string;
  password: string;
  confirm: string;
}

/**
 * Offer the first-admin form (instead of a bare Enable button) while auth is off and no user exists, which is
 * exactly when `/api/auth/setup` is allowed. With users present (but auth off) the plain Enable button stays,
 * and the server's answer is shown if it refuses.
 */
export function shouldOfferFirstAdmin(status: AuthStatusLike | null): boolean {
  return status !== null && !status.authEnabled && status.userCount === 0;
}

/** A message for the first problem with the input, or null when it can be submitted. */
export function validateFirstAdmin(input: FirstAdminInput): string | null {
  if (!input.username.trim()) return 'Choose a username.';
  if (!input.password) return 'Choose a password.';
  if (input.password !== input.confirm) return 'The passwords do not match.';
  return null;
}

/** The body for POST /api/auth/setup. */
export function firstAdminBody(input: FirstAdminInput): { username: string; password: string } {
  return { username: input.username.trim(), password: input.password };
}

/**
 * The server's own words for a failed request. `api()` throws `API <status>: <body>` where the body is the JSON
 * the dashboard returned (`{"error":"..."}`, or `{"error":{"message":"..."}}` for the structured errors). Show
 * that text, not a generic "failed"; fall back to `fallback` only when there is nothing better.
 */
export function apiErrorMessage(err: unknown, fallback: string): string {
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  const match = /^API \d+:\s*([\s\S]*)$/.exec(raw);
  const body = (match ? match[1] : raw).trim();
  if (!body) return fallback;
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === 'object') {
      const e = (parsed as { error?: unknown }).error;
      if (typeof e === 'string' && e) return e;
      if (e && typeof e === 'object') {
        const m = (e as { message?: unknown }).message;
        if (typeof m === 'string' && m) return m;
      }
    }
  } catch {
    // Not JSON: the text itself is the message.
  }
  return body;
}
