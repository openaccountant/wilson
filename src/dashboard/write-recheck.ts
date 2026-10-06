/**
 * Central write-time auth re-check (#157).
 *
 * The auth middleware runs once, when a request's headers arrive. Bun hands the
 * request to `fetch` at that point, so a write whose body is still on the wire
 * can find dashboard auth switched on (the admin finishing `/api/auth/setup`)
 * by the time a route's `await req.json()` returns. If auth was off at arrival
 * the request carries no login; running it afterwards would be an anonymous
 * write on an authenticated dashboard.
 *
 * Rather than patch each of the ~30 routes that read a body, the server calls
 * `readBodyThenRecheck` once, before routing, for every state-changing request.
 * It reads the whole body, asks whether the request's authority changed meanwhile
 * (auth switched on under a login-less request, the login it arrived with was
 * deactivated / logged out / expired, or the active profile changed), and then
 * leaves the bytes on the request so the route's own `req.json()` still works
 * unchanged. A route added later is covered without remembering to ask.
 */

/** Methods that change state. Anything else (GET, HEAD, OPTIONS) is read-only and never waits on a body. */
const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function isStateChanging(method: string): boolean {
  return STATE_CHANGING.has(method.toUpperCase());
}

/** The body readers a route may call. After buffering they all serve the same bytes. */
const BODY_READERS = ['json', 'text', 'arrayBuffer', 'blob', 'formData'] as const;

/**
 * Read the request body to the end, then ask whether the request's authority
 * changed while it was arriving. The bytes stay available to the route:
 * `req.json()` and friends are re-pointed at the buffered copy. The original
 * `Request` object is kept (not rebuilt) because `Bun.Server.requestIP(req)` is
 * keyed on it.
 *
 * `check()` returns null while the request may proceed, or a reason to refuse:
 * auth switched on under a request that arrived without a login, the login it
 * arrived with was deactivated / logged out / expired, or the active profile
 * changed (a request validated against profile A must never run on profile B).
 * The reason is handed back so the caller picks the status. A body that cannot
 * be read (client hung up) rejects, exactly as the route's own read would have.
 */
export async function readBodyThenRecheck<R>(req: Request, check: () => R | null): Promise<R | null> {
  const bytes = await req.arrayBuffer();
  const refusal = check();
  if (refusal !== null) return refusal;
  const contentType = req.headers.get('Content-Type');
  const replay = () => new Response(bytes, contentType ? { headers: { 'Content-Type': contentType } } : undefined);
  for (const name of BODY_READERS) {
    Object.defineProperty(req, name, { configurable: true, value: () => replay()[name]() });
  }
  return null;
}
