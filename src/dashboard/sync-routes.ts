/**
 * Read routes for the offline mirror's v4 sync (specs/browser-subagent.md
 * section 7.2, Round-2 security fixes):
 *
 *   GET /api/sync/accounts            active accounts, mirror columns only
 *   GET /api/sync/balance-snapshots   balance_snapshots of ACTIVE accounts
 *   GET /api/sync/loans               loans of ACTIVE accounts
 *
 * Why they exist instead of GET /api/accounts: that route returns SELECT * (notes,
 * plaid_account_id, account_number_last4), which no mirror executor reads. These
 * project only the columns the executors use (store/mirror-networth.ts,
 * mirror-forecast.ts). loans.notes, plaid ids and account numbers never leave the
 * server.
 *
 * Access: behind the same auth middleware as every /api route, GET only (anything
 * else is 405), and behind a strict same-origin gate. With auth off the dashboard
 * answers every other route with `Access-Control-Allow-Origin: *`; these routes
 * return raw financial rows, so they never do. A request must prove it comes from
 * the dashboard page itself:
 *   - Host is this server's loopback name:port (or WILSON_DASHBOARD_ALLOWED_HOSTS),
 *     which defeats DNS rebinding;
 *   - a present Origin is allowlisted (own origins, the vite dev origins only when
 *     WILSON_DASHBOARD_DEV=1, WILSON_DASHBOARD_ALLOWED_ORIGINS), `null` and foreign
 *     origins are refused;
 *   - Sec-Fetch-Site, when present, is never cross-site/none;
 *   - and there is proof: an allowlisted Origin, or Sec-Fetch-Site: same-origin
 *     (a same-origin GET carries no Origin). A bare curl has neither and is refused.
 * This stops other web pages and other localhost ports; it does not stop
 * deliberate header forgery by a local process (the same limit as the dashboard's
 * other interim gates).
 *
 * Mounted with a single line in server.ts, following the handleMcpRoute pattern.
 */

import type { Database } from '../db/compat-sqlite.js';

type Env = Record<string, string | undefined>;

export interface SyncRouteContext {
  activeDb: Database;
  /** The server's response headers; any wildcard CORS grant in them is dropped here. */
  headers: Record<string, string>;
  /** The port this server is bound to (server.port, not the requested one). */
  port: number;
  env?: Env;
}

const DEV_ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173'];
const LOOPBACK_HOSTNAMES = ['localhost', '127.0.0.1', '[::1]'];

function listEnv(env: Env, key: string): string[] {
  return (env[key] ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

/** Origins that may read the sync routes, in a stable order. */
export function syncAllowedOrigins(port: number, env: Env = process.env): string[] {
  const own = [`http://localhost:${port}`, `http://127.0.0.1:${port}`, `http://[::1]:${port}`];
  const dev = env.WILSON_DASHBOARD_DEV === '1' ? DEV_ORIGINS : [];
  const extra = listEnv(env, 'WILSON_DASHBOARD_ALLOWED_ORIGINS').map((o) => o.replace(/\/+$/, ''));
  return [...new Set([...own, ...dev, ...extra])];
}

function splitHost(host: string): { hostname: string; port: string } {
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    if (end === -1) return { hostname: host, port: '' };
    return { hostname: host.slice(0, end + 1), port: host.slice(end + 1).replace(/^:/, '') };
  }
  const colon = host.indexOf(':');
  return colon === -1 ? { hostname: host, port: '' } : { hostname: host.slice(0, colon), port: host.slice(colon + 1) };
}

function isAllowedHost(hostHeader: string | null, port: number, env: Env): boolean {
  if (!hostHeader) return false;
  const host = hostHeader.trim().toLowerCase();
  const { hostname, port: hostPort } = splitHost(host);
  if (LOOPBACK_HOSTNAMES.includes(hostname)) return (hostPort || '80') === String(port);
  const extra = listEnv(env, 'WILSON_DASHBOARD_ALLOWED_HOSTS').map((h) => h.toLowerCase());
  return extra.includes(host) || extra.includes(hostname);
}

/**
 * CORS headers for a sync request: the request's Origin, reflected, only when it
 * is allowlisted. Never a wildcard; a request with no Origin is not CORS.
 */
export function syncCorsHeaders(port: number, origin: string | null, env: Env = process.env): Record<string, string> {
  if (origin === null || !syncAllowedOrigins(port, env).includes(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    Vary: 'Origin',
  };
}

function refuse(code: string, message: string, headers: Record<string, string>): Response {
  return Response.json({ error: { code, message } }, { status: 403, headers });
}

/** 403 unless the request proves it came from the dashboard page (see the header). Null means allowed. */
export function checkSyncGate(req: Request, port: number, env: Env = process.env, headers: Record<string, string> = {}): Response | null {
  if (!isAllowedHost(req.headers.get('Host'), port, env)) {
    return refuse('host_forbidden', 'This host is not allowed to use the dashboard.', headers);
  }
  const origin = req.headers.get('Origin');
  const site = req.headers.get('Sec-Fetch-Site');
  const originOk = origin !== null && syncAllowedOrigins(port, env).includes(origin);
  if (origin !== null && !originOk) {
    return refuse('origin_forbidden', 'This origin is not allowed to read the sync routes.', headers);
  }
  if (site !== null && site !== 'same-origin' && !(originOk && site === 'same-site')) {
    return refuse('origin_forbidden', 'Cross-site requests cannot read the sync routes.', headers);
  }
  if (!originOk && site !== 'same-origin') {
    return refuse('origin_required', 'The sync routes must be read from the dashboard page in a browser.', headers);
  }
  return null;
}

/** accounts rows, active only, with the columns the mirror executors read (no notes, plaid id or account number). */
export function syncAccountRows(db: Database): Record<string, unknown>[] {
  return db
    .prepare(
      `SELECT id, name, account_type, account_subtype, institution, current_balance,
              currency, is_active, entity_id, created_at, updated_at
       FROM accounts
       WHERE is_active = 1
       ORDER BY id`
    )
    .all() as Record<string, unknown>[];
}

/** balance_snapshots rows of active accounts (id, account, balance, date only), oldest id first. */
export function syncBalanceSnapshotRows(db: Database): Record<string, unknown>[] {
  return db
    .prepare(
      `SELECT bs.id, bs.account_id, bs.balance, bs.snapshot_date FROM balance_snapshots bs
       JOIN accounts a ON a.id = bs.account_id
       WHERE a.is_active = 1
       ORDER BY bs.id`
    )
    .all() as Record<string, unknown>[];
}

/** loans rows whose account is active (no notes), oldest id first. */
export function syncLoanRows(db: Database): Record<string, unknown>[] {
  return db
    .prepare(
      `SELECT l.id, l.account_id, l.original_principal, l.interest_rate, l.term_months,
              l.start_date, l.extra_payment, l.linked_asset_id, l.created_at, l.updated_at
       FROM loans l
       JOIN accounts a ON a.id = l.account_id
       WHERE a.is_active = 1
       ORDER BY l.id`
    )
    .all() as Record<string, unknown>[];
}

const SYNC_ROUTES: Record<string, (db: Database) => Record<string, unknown>[]> = {
  '/api/sync/accounts': syncAccountRows,
  '/api/sync/balance-snapshots': syncBalanceSnapshotRows,
  '/api/sync/loans': syncLoanRows,
};

/**
 * Try to handle `path` as a sync route. Returns null when it matches nothing
 * here, so the caller falls through to its own routing.
 */
export function handleSyncRoute(req: Request, path: string, ctx: SyncRouteContext): Response | null {
  const rows = SYNC_ROUTES[path];
  if (!rows) return null;
  // The server's shared headers carry a wildcard ACAO; drop it and reflect only an allowlisted Origin.
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(ctx.headers)) {
    if (!k.toLowerCase().startsWith('access-control-')) headers[k] = v;
  }
  Object.assign(headers, syncCorsHeaders(ctx.port, req.headers.get('Origin'), ctx.env ?? process.env));
  if (req.method !== 'GET') {
    return Response.json({ error: 'Method not allowed' }, { status: 405, headers });
  }
  const refused = checkSyncGate(req, ctx.port, ctx.env ?? process.env, headers);
  if (refused) return refused;
  return Response.json(rows(ctx.activeDb), { headers });
}
