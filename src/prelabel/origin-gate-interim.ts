/**
 * Interim request gate for /api/prelabel/* (specs/open-jev-labeler.md §9.0, critic C1).
 *
 * The dashboard answers every route with `Access-Control-Allow-Origin: *`, binds
 * all interfaces and, with auth off, treats every caller as admin. Judge P0b
 * fixes that server-wide but is not merged, so B1 gates its own routes.
 *
 * Every export here has the NAME and SIGNATURE of the one in P0b's
 * `src/dashboard/origin-gate.ts`, and the same behaviour for the subset B1 uses
 * (`allowedOrigins`, `isAllowedOrigin`, `corsHeaders`, `resolveBrowserOrigin`,
 * `requireBrowserProof`, and, since round 3, `isLoopbackPeer` and `checkHost`),
 * so that when P0b merges this file becomes a plain re-export, the same pattern
 * as agent-present.ts. Do not add helpers here that P0b lacks; put route-specific
 * policy in routes.ts.
 *
 * TODO(P0b): REPLACE THIS FILE WITH A RE-EXPORT WHEN P0b LANDS:
 *   export { allowedOrigins, isAllowedOrigin, corsHeaders, resolveBrowserOrigin,
 *            requireBrowserProof, isLoopbackPeer, checkHost } from '../dashboard/origin-gate.js';
 *
 *   isAllowedOrigin(origin, port, env?)
 *   corsHeaders(port, origin, env?)
 *   resolveBrowserOrigin(req, port, env?)
 *   requireBrowserProof(req, port?, env?)
 *   isLoopbackPeer(address)          // requestIP(req)?.address
 *   checkHost(req, port, env?)       // 421 (no body) for a Host that is not ours
 *
 * Headers prove nothing about WHO sent the request: a LAN script can forge Origin,
 * Sec-Fetch-Site and Host. `isLoopbackPeer` looks at the socket instead, and
 * routes.ts requires it on every /api/prelabel route.

 * A request with no Origin is not a CORS request at all, and a browser request
 * is reflected only when it matches this server's own origin.
 */

import { isIPv4 } from 'node:net';

type Env = Record<string, string | undefined>;

/** The vite dev server's origins. Allowed only when `WILSON_DASHBOARD_DEV=1`. */
const DEV_ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173'];
const LOOPBACK_HOSTNAMES = ['localhost', '127.0.0.1', '[::1]'];

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

/** True when `origin` is allowlisted. `null` and the literal string `"null"` are not. */
export function isAllowedOrigin(origin: string | null, port: number, env: Env = process.env): boolean {
  return origin !== null && allowedOrigins(port, env).includes(origin);
}

/**
 * Grants are bound to an origin string. The dev server's page (`:5173`) and the
 * dashboard itself (`:<port>`) are the same tab as far as the user is concerned.
 */
function canonicalOrigin(origin: string, port: number): string {
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
 * A loopback name is only ours when it also carries this server's port. A LAN
 * name listed in `WILSON_DASHBOARD_ALLOWED_HOSTS` matches by hostname (or exact
 * `host:port`). Anything else (DNS rebinding) is not allowed.
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

/** True when a peer address (as `requestIP` reports it) is this machine. */
export function isLoopbackPeer(address: string | undefined): boolean {
  if (!address) return false;
  const a = address.trim().toLowerCase().replace(/^::ffff:/, '');
  return a === '::1' || isLoopbackIPv4(a);
}

/** 421 with no body for a Host that is not allowlisted (DNS rebinding), else null. */
export function checkHost(req: Request, port: number, env: Env = process.env): Response | null {
  return isAllowedHost(req.headers.get('Host'), port, env) ? null : new Response(null, { status: 421 });
}

/**
 * CORS headers for one request: the Origin reflected when it is allowlisted
 * (the dev-server aliases excluded), otherwise nothing. Never a wildcard; a
 * request with no Origin is not CORS.
 */
export function corsHeaders(port: number, origin: string | null, env: Env = process.env): Record<string, string> {
  if (origin === null || !isAllowedOrigin(origin, port, env)) return {};
  const extra = listEnv(env, 'WILSON_DASHBOARD_ALLOWED_ORIGINS').map((o) => o.replace(/\/+$/, ''));
  if (DEV_ORIGINS.includes(origin) && !extra.includes(origin)) return {};
  return { 'Access-Control-Allow-Origin': origin as string, Vary: 'Origin' };
}

/**
 * The origin of a browser request that came from the dashboard page, or null.
 *  1. an allowlisted `Origin` (dev aliases canonicalized);
 *  2. otherwise `Sec-Fetch-Site: same-origin` with an allowed Host. A browser sends
 *     no `Origin` on a same-origin GET, only `Sec-Fetch-Site`.
 * `Origin: null` counts as present and not allowlisted. A header-less caller
 * (curl, a LAN script) and a rebinding Host both get null.
 */
export function resolveBrowserOrigin(req: Request, port: number, env: Env = process.env): string | null {
  const origin = req.headers.get('Origin');
  if (origin !== null) {
    return isAllowedOrigin(origin, port, env) ? canonicalOrigin(origin, port) : null;
  }
  const host = req.headers.get('Host');
  if (req.headers.get('Sec-Fetch-Site') === 'same-origin' && isAllowedHost(host, port, env)) {
    return `http://${(host as string).trim().toLowerCase()}`;
  }
  return null;
}

function forbidden(code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status: 403 });
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
 * A local process can still forge headers; only dashboard auth closes that.
 */
export function requireBrowserProof(req: Request, port: number = portOf(req), env: Env = process.env): Response | null {
  const proven = isAllowedOrigin(req.headers.get('Origin'), port, env) && req.headers.get('Sec-Fetch-Site') === 'same-origin';
  return proven ? null : forbidden('origin_required', 'This action must come from the dashboard page in a browser.');
}
