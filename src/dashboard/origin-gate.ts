/**
 * The dashboard's network boundary (threat model T01-T05).
 *
 *  - Host:   only `localhost`, `127.0.0.1`, `[::1]` on this server's port (or a name in
 *            `WILSON_DASHBOARD_ALLOWED_HOSTS`) may address it, which defeats DNS rebinding.
 *            Anything else is 421, no body.
 *  - Origin: CORS reflects an allowlisted Origin and nothing else. There is no wildcard.
 *  - State:  a POST/PUT/PATCH/DELETE under /api is refused when its Origin is present and
 *            not allowlisted (`Origin: null` included), or when Sec-Fetch-Site says the
 *            request is not same-origin (this is what blocks another localhost port).
 *  - Proof:  routes that decide something on a human's behalf (approve, reject, grants,
 *            client tokens) additionally need an allowlisted Origin AND
 *            `Sec-Fetch-Site: same-origin`. That stops a naive `curl` from an MCP client's
 *            shell tool; it does not stop deliberate header forgery (threat model section 7).
 *
 * Nothing here touches a database. Every function reads `process.env` unless an env
 * object is passed, so tests can flip WILSON_DASHBOARD_DEV per request.
 */

import { isIPv4 } from 'node:net';

type Env = Record<string, string | undefined>;

/** The vite dev server's origins. Allowed only when `WILSON_DASHBOARD_DEV=1`. */
const DEV_ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173'];
const LOOPBACK_HOSTNAMES = ['localhost', '127.0.0.1', '[::1]'];
const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function listEnv(env: Env, key: string): string[] {
  return (env[key] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Origins that may talk to the dashboard on `port`, in a stable order. */
export function allowedOrigins(port: number, env: Env = process.env): string[] {
  const own = [`http://localhost:${port}`, `http://127.0.0.1:${port}`, `http://[::1]:${port}`];
  const dev = env.WILSON_DASHBOARD_DEV === '1' ? DEV_ORIGINS : [];
  const extra = listEnv(env, 'WILSON_DASHBOARD_ALLOWED_ORIGINS').map((o) => o.replace(/\/+$/, ''));
  return [...new Set([...own, ...dev, ...extra])];
}

export function isAllowedOrigin(origin: string | null, port: number, env: Env = process.env): boolean {
  return origin !== null && allowedOrigins(port, env).includes(origin);
}

/**
 * Grants are bound to an origin string. The dev server's page (`:5173`) and the
 * dashboard itself (`:<port>`) are the same tab as far as the user is concerned,
 * and the same tab's later GETs arrive with no Origin and the dashboard's Host,
 * so both resolve to `http://localhost:<port>`.
 */
export function canonicalOrigin(origin: string, port: number, _env: Env = process.env): string {
  return DEV_ORIGINS.includes(origin) ? `http://localhost:${port}` : origin;
}

/** Split a Host header into hostname and port (`''` when absent): `[::1]:3141` -> `['[::1]', '3141']`. */
function splitHost(hostHeader: string): { hostname: string; port: string } {
  const host = hostHeader.trim().toLowerCase();
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    if (end === -1) return { hostname: host, port: '' };
    return { hostname: host.slice(0, end + 1), port: host.slice(end + 1).replace(/^:/, '') };
  }
  const colon = host.indexOf(':');
  return colon === -1 ? { hostname: host, port: '' } : { hostname: host.slice(0, colon), port: host.slice(colon + 1) };
}

/**
 * A loopback name is only ours when it also carries this server's port: the
 * dev proxy without `changeOrigin` forwards `localhost:5173`, which names the
 * vite server, not the dashboard. A LAN name listed in
 * `WILSON_DASHBOARD_ALLOWED_HOSTS` matches by hostname (or exact `host:port`).
 */
function isAllowedHost(hostHeader: string | null, port: number, env: Env): boolean {
  if (!hostHeader) return false;
  const host = hostHeader.trim().toLowerCase();
  const { hostname, port: hostPort } = splitHost(host);
  if (LOOPBACK_HOSTNAMES.includes(hostname)) return (hostPort || '80') === String(port);
  const extra = listEnv(env, 'WILSON_DASHBOARD_ALLOWED_HOSTS').map((h) => h.toLowerCase());
  return extra.includes(host) || extra.includes(hostname);
}

/** A literal IPv4 address in 127.0.0.0/8. Hostnames that merely start with `127.` do not qualify. */
function isLoopbackIPv4(h: string): boolean {
  if (!isIPv4(h)) return false;
  return h.split('.')[0] === '127';
}

/**
 * True for a bind address that only this machine can reach: the literal names
 * `localhost` / `::1`, or an IPv4 literal in 127.0.0.0/8. Anything else (a
 * hostname such as `127.example.com`, `0.0.0.0`, a LAN address) is LAN mode.
 */
export function isLoopbackBind(hostname: string): boolean {
  const h = hostname.trim().toLowerCase();
  return h === 'localhost' || h === '::1' || h === '[::1]' || isLoopbackIPv4(h);
}

/** True when a peer address (as `requestIP` reports it) is this machine. */
export function isLoopbackPeer(address: string | undefined): boolean {
  if (!address) return false;
  const a = address.trim().toLowerCase().replace(/^::ffff:/, '');
  return a === '::1' || isLoopbackIPv4(a);
}

/** 421 with no body for a Host that is not allowlisted (DNS rebinding), else null. Applies to every path. */
export function checkHost(req: Request, port: number, env: Env = process.env): Response | null {
  return isAllowedHost(req.headers.get('Host'), port, env) ? null : new Response(null, { status: 421 });
}

/**
 * CORS headers for one request: the Origin reflected when it is allowlisted
 * (the dev-server aliases excluded), otherwise nothing. Never a wildcard; a request with no Origin is not CORS.
 */
export function corsHeaders(port: number, origin: string | null, env: Env = process.env): Record<string, string> {
  // The vite dev aliases are trusted for state changes and browser proof (the dev proxy makes
  // them same-origin) but never get CORS: reading is a cross-origin act, and any other app on
  // :5173 would otherwise read the ledger. Only this server's own origins and explicit extras do.
  if (origin === null || !isAllowedOrigin(origin, port, env)) return {};
  const extra = listEnv(env, 'WILSON_DASHBOARD_ALLOWED_ORIGINS').map((o) => o.replace(/\/+$/, ''));
  if (DEV_ORIGINS.includes(origin) && !extra.includes(origin)) return {};
  return { 'Access-Control-Allow-Origin': origin as string, Vary: 'Origin' };
}

function forbidden(code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status: 403 });
}

/**
 * 403 for a state-changing `/api/*` request that a browser would have sent
 * cross-origin. A request with neither header (a non-browser client) passes
 * here; the routes that need proof ask `requireBrowserProof`. `/mcp` is not
 * under `/api` and authenticates with its own token.
 */
export function checkStateChange(req: Request, route: string, port: number, env: Env = process.env): Response | null {
  if (!route.startsWith('/api/') || !STATE_CHANGING_METHODS.has(req.method)) return null;
  const origin = req.headers.get('Origin');
  if (origin !== null && !isAllowedOrigin(origin, port, env)) {
    return forbidden('origin_forbidden', 'This request came from an origin that is not allowed to use the dashboard.');
  }
  const site = req.headers.get('Sec-Fetch-Site');
  if (site !== null && site !== 'same-origin' && site !== 'none') {
    return forbidden('origin_forbidden', 'Cross-origin requests cannot change dashboard data.');
  }
  return null;
}

/**
 * The origin a grant is bound to for this browser request, or null when the
 * request does not look like it came from the dashboard page (the route answers
 * 403 `origin_required`).
 *  1. an allowlisted `Origin` (dev aliases canonicalized);
 *  2. otherwise `Sec-Fetch-Site: same-origin` with an allowed Host, deriving `http://<Host>`.
 * `Origin: null` counts as present and not allowlisted. There is no localhost fallback.
 */
export function resolveBrowserOrigin(req: Request, port: number, env: Env = process.env): string | null {
  const origin = req.headers.get('Origin');
  if (origin !== null) {
    return isAllowedOrigin(origin, port, env) ? canonicalOrigin(origin, port, env) : null;
  }
  const host = req.headers.get('Host');
  if (req.headers.get('Sec-Fetch-Site') === 'same-origin' && isAllowedHost(host, port, env)) {
    return `http://${(host as string).trim().toLowerCase()}`;
  }
  return null;
}

/** The port a request was addressed to, for callers that have no server handle. */
function portOf(req: Request): number {
  try {
    const url = new URL(req.url);
    return Number(url.port) || (url.protocol === 'https:' ? 443 : 80);
  } catch {
    return 0;
  }
}

/**
 * Browser proof for a route that acts on a human's behalf: an allowlisted
 * `Origin` AND `Sec-Fetch-Site: same-origin`. Returns the 403 `origin_required`
 * response, or null when the proof holds. `port` defaults to the request's own.
 */
export function requireBrowserProof(req: Request, port: number = portOf(req), env: Env = process.env): Response | null {
  const proven = isAllowedOrigin(req.headers.get('Origin'), port, env) && req.headers.get('Sec-Fetch-Site') === 'same-origin';
  return proven ? null : forbidden('origin_required', 'This action must come from the dashboard page in a browser.');
}
