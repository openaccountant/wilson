/**
 * /api/prelabel/* handlers (specs/open-jev-labeler.md §9).
 *
 * `handlePrelabelRoute` returns null for any path it does not own so server.ts
 * keeps its normal 404. Every response goes through the §9.0 gate: the shared
 * `headers` object is copied (never mutated), its wildcard CORS header is
 * dropped, and only an own origin is reflected.
 *
 * Errors are `{error:{code,message}}` with a real HTTP status.
 */

import { z } from 'zod';
import type { Database } from '../db/compat-sqlite.js';
import {
  PRELABEL_MODEL,
  PRELABEL_ENABLED_KEY,
  PRELABEL_MARGIN_CUT_KEY,
  PRELABEL_MAX_ROWS_PER_RUN,
  MARGIN_CUT_MIN,
  MARGIN_CUT_MAX,
  prelabelEnabled,
  prelabelMarginCut,
} from './config.js';
import { getPrelabelLabels } from './label-set.js';
import { checkHost, corsHeaders, isAllowedOrigin, isLoopbackPeer, requireBrowserProof, resolveBrowserOrigin } from './origin-gate-interim.js';
import { setSetting } from '../utils/config.js';

export interface PrelabelRouteContext {
  db: Database;
  /** The server's shared response headers; copied here, never mutated. */
  headers: Record<string, string>;
  authEnabled: boolean;
  currentUser: { role: 'admin' | 'viewer' } | null;
  canWrite: (role: 'admin' | 'viewer') => boolean;
  /** Actual bound port (server.port), for the origin allowlist. */
  port: number;
  /** Active profile name. */
  profile: string;
  /** The socket's peer address (`server.requestIP(req)?.address`); undefined when unknown, which is refused. */
  peerAddress: string | undefined;
}

/** `/api/prelabel/gold` returns at most this many rows (spec §9.1). */
const GOLD_MAX_LIMIT = 500;

const SettingsBody = z
  .object({
    enabled: z.boolean().optional(),
    marginCut: z.number().min(MARGIN_CUT_MIN).max(MARGIN_CUT_MAX).optional(),
  })
  .strict();

function errorResponse(status: number, code: string, message: string, headers: Record<string, string>, extra?: Record<string, string>): Response {
  return Response.json({ error: { code, message } }, { status, headers: { ...headers, ...extra } });
}

export async function handlePrelabelRoute(req: Request, url: URL, ctx: PrelabelRouteContext): Promise<Response | null> {
  const path = url.pathname;
  if (!path.startsWith('/api/prelabel/')) return null;
  if (path !== '/api/prelabel/config' && path !== '/api/prelabel/gold' && path !== '/api/prelabel/settings') return null;

  // §9.0 rule 0 (round 3): who is on the socket, not what the headers claim. A Host that
  // is not ours is a DNS-rebinding page (421, no body); a peer that is not this machine
  // can forge Origin / Sec-Fetch-Site / Host perfectly, so it gets nothing at all.
  // Remove with the interim gate once judge P0b gates the whole server.
  const hostDenied = checkHost(req, ctx.port);
  if (hostDenied) return hostDenied;
  if (!isLoopbackPeer(ctx.peerAddress)) {
    return Response.json(
      { error: { code: 'loopback_required', message: 'The pre-labeler is only available from this machine.' } },
      { status: 403, headers: { 'Content-Type': 'application/json' } },
    );
  }

  // §9.0 rule 1: never the wildcard; reflect an own origin only.
  const headers: Record<string, string> = { ...ctx.headers };
  delete headers['Access-Control-Allow-Origin'];
  Object.assign(headers, corsHeaders(ctx.port, req.headers.get('Origin')));
  /** The shared gate's bare 403, carrying this route's (non-wildcard) headers. */
  const withHeaders = (res: Response): Response => new Response(res.body, { status: res.status, headers: { ...headers, 'Content-Type': 'application/json' } });

  const mayWrite = !(ctx.authEnabled && ctx.currentUser && !ctx.canWrite(ctx.currentUser.role));

  if (path === '/api/prelabel/config') {
    if (req.method !== 'GET') return errorResponse(405, 'method_not_allowed', 'Use GET', headers, { Allow: 'GET' });
    const { labels, labelSetVersion } = getPrelabelLabels(ctx.db);
    return Response.json(
      {
        enabled: prelabelEnabled(),
        profile: ctx.profile,
        pins: { ...PRELABEL_MODEL },
        labels,
        labelSetVersion,
        marginCut: prelabelMarginCut(),
        maxRowsPerRun: PRELABEL_MAX_ROWS_PER_RUN,
        approxDownloadBytes: PRELABEL_MODEL.approxDownloadBytes,
      },
      { headers },
    );
  }

  if (path === '/api/prelabel/gold') {
    if (req.method !== 'GET') return errorResponse(405, 'method_not_allowed', 'Use GET', headers, { Allow: 'GET' });
    // §9.0 rule 2: this route returns up to 500 verified transactions, so it needs
    // browser proof (an own Origin, or Sec-Fetch-Site: same-origin to an allowed Host).
    // A header-less caller (curl on the LAN, a DNS-rebinding page) gets 403.
    if (resolveBrowserOrigin(req, ctx.port) === null) {
      const origin = req.headers.get('Origin');
      const site = req.headers.get('Sec-Fetch-Site');
      const foreign = (origin !== null && !isAllowedOrigin(origin, ctx.port)) || site === 'cross-site' || site === 'same-site';
      return foreign
        ? errorResponse(403, 'origin_denied', 'Origin not allowed', headers)
        : errorResponse(403, 'origin_required', 'This data is only served to the dashboard page in a browser', headers);
    }
    if (!mayWrite) return errorResponse(403, 'forbidden', 'Forbidden', headers);
    // Read-only: human-verified rows only, newest first. Used by the measurement
    // panel in the browser; nothing is persisted or sent anywhere.
    const raw = Number.parseInt(url.searchParams.get('limit') ?? '', 10);
    const limit = Number.isFinite(raw) ? Math.min(GOLD_MAX_LIMIT, Math.max(1, raw)) : GOLD_MAX_LIMIT;
    const rows = ctx.db
      .prepare(
        `SELECT id AS txnId, description, amount, date, category AS label
         FROM transactions
         WHERE user_verified = 1 AND category IS NOT NULL AND category <> ''
         ORDER BY date DESC, id DESC
         LIMIT @limit`,
      )
      .all({ limit });
    return Response.json({ rows }, { headers });
  }

  // PUT /api/prelabel/settings
  if (req.method !== 'PUT') return errorResponse(405, 'method_not_allowed', 'Use PUT', headers, { Allow: 'PUT' });
  // §9.0 rule 3: JSON only (forces a CORS preflight, blocks text/plain form CSRF)...
  const contentType = (req.headers.get('Content-Type') ?? '').split(';')[0].trim().toLowerCase();
  if (contentType !== 'application/json') {
    return errorResponse(415, 'unsupported_media_type', 'Content-Type must be application/json', headers);
  }
  // ...from the dashboard page itself.
  const denied = requireBrowserProof(req, ctx.port);
  if (denied) return withHeaders(denied);
  if (!mayWrite) return errorResponse(403, 'forbidden', 'Forbidden', headers);

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return errorResponse(400, 'invalid_body', 'Body must be valid JSON', headers);
  }
  const parsed = SettingsBody.safeParse(raw);
  if (!parsed.success) {
    return errorResponse(400, 'invalid_body', parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '), headers);
  }
  const { enabled, marginCut } = parsed.data;
  if (enabled !== undefined && !setSetting(PRELABEL_ENABLED_KEY, enabled)) {
    return errorResponse(500, 'write_failed', 'Could not write settings', headers);
  }
  if (marginCut !== undefined && !setSetting(PRELABEL_MARGIN_CUT_KEY, marginCut)) {
    return errorResponse(500, 'write_failed', 'Could not write settings', headers);
  }
  return Response.json({ enabled: prelabelEnabled(), marginCut: prelabelMarginCut() }, { headers });
}
