/**
 * HTTP routes for the WebMCP bridge, mounted from src/dashboard/server.ts.
 * Handles grant management, the single `POST /api/mcp/call` tool path, and the
 * confirmation queue that WebMCP, the HTTP-MCP fallback, and the dashboard
 * chat's approval hang fix all share.
 *
 * Every route here re-derives scope (role, profile, origin, session
 * generation) from the current request rather than trusting anything the
 * client claims about its own privileges — see src/mcp/engine.ts and
 * src/mcp/store.ts for why that's the actual security boundary.
 *
 * The tab's session generation arrives in the `X-Wilson-Agent-Session` header
 * (a UUID v4). The `sessionGeneration` query/body parameter is still accepted
 * for one release and marked deprecated in the response headers.
 *
 * Errors are `{ error: { code, message, hint? } }` with a matching HTTP status
 * (and `Retry-After` on 429), so an agent gets text it can act on.
 *
 * Network boundary (src/dashboard/origin-gate.ts): a grant is bound to the origin
 * `resolveBrowserOrigin` proves (an allowlisted Origin, or Sec-Fetch-Site
 * same-origin on an allowed Host). There is no localhost fallback, so a
 * non-browser client is refused with 403 `origin_required`. Routes that decide
 * something on a human's behalf (approve, reject, grants, client tokens) need
 * `requireBrowserProof` on top.
 */
import type { z } from 'zod';
import type { Database } from '../db/compat-sqlite.js';
import { canWrite, isAuthEnabled, type DashboardUser } from './auth.js';
import { getCurrentProfileName } from './db-manager.js';
import { expireChatOperation, getPendingChatOperation, respondToChatOperation } from './chat.js';
import {
  listCatalog,
  grantLocalAccess,
  listActiveGrants,
  revokeLocalGrant,
  revokeAllForSession,
  exposedTools,
  callTool,
  checkGrantCreationRate,
  getPendingOperations,
  getOperationById,
  isOperationVisible,
  approveWebMcpOperation,
  rejectOperation,
  cancelOperation,
  isApprovalTooFast,
  isAgentAccessEnabled,
  setKillSwitch,
  type EngineError,
  type OperationActor,
  type RequestScope,
  type TypedOutcome,
} from '../mcp/engine.js';
import { clearReadOutcome, isOperationExpired, type McpGrant, type McpOperation } from '../mcp/store.js';
import { toAgentOperationView, toAgentResolvedView, toOperationView, type OperationViewer } from '../mcp/operation-view.js';
import { clientTokenName, listClientTokens, mintClientToken, revokeClientToken, rotateClientToken, updateClientTokenTools } from '../mcp/client-tokens.js';
import { listPolicies, setPolicy } from '../mcp/policies.js';
import { buildAgentState } from '../mcp/agent-state.js';
import { setGrantTtlMinutes, setJudgeDailyLimit } from '../mcp/agent-settings.js';
import { requireBrowserProof, resolveBrowserOrigin } from './origin-gate.js';
import { appendAudit, listAudit, previewArgs, userPrincipal } from '../mcp/audit.js';
import { UNKNOWN_TOOL_LABEL } from '../mcp/engine.js';
import { getToolDef } from '../mcp/tool-catalog.js';
import { limiterFor, userKeyOf, LIMIT_AUDIT_GET, LIMIT_CLIENT_TOKEN_MINT } from '../mcp/rate-limit.js';
import {
  AuditQuery,
  CallBody,
  ClientTokenBody,
  ClientTokenToolsBody,
  GrantsBody,
  PolicyBody,
  RevokeSessionBody,
  SettingsBody,
  SESSION_HEADER,
  describeZodError,
  isUuidV4,
} from '../mcp/schemas.js';

export interface McpRouteContext {
  activeDb: Database;
  currentUser: DashboardUser | null;
  authEnabled: boolean;
  port: number;
  headers: Record<string, string>;
}

/**
 * The scope of a browser request, or null when it does not prove it came from the
 * dashboard page (the caller answers 403 `origin_required`). The origin stored on
 * a grant is canonical: the dev server's :5173 page and the dashboard itself are one tab.
 */
function deriveScope(req: Request, ctx: McpRouteContext, sessionGeneration: string): RequestScope | null {
  const origin = resolveBrowserOrigin(req, ctx.port);
  if (origin === null) return null;
  return {
    role: ctx.authEnabled && ctx.currentUser ? ctx.currentUser.role : 'admin',
    userId: ctx.authEnabled && ctx.currentUser ? ctx.currentUser.id : null,
    profile: getCurrentProfileName(),
    origin,
    sessionGeneration,
  };
}

function actorOf(ctx: McpRouteContext): OperationActor {
  return {
    userId: ctx.authEnabled && ctx.currentUser ? ctx.currentUser.id : null,
    role: ctx.authEnabled && ctx.currentUser ? ctx.currentUser.role : 'admin',
    authEnabled: ctx.authEnabled,
  };
}

function json(data: unknown, status: number, headers: Record<string, string>): Response {
  return Response.json(data, { status, headers });
}

function errorResponse(
  status: number,
  code: string,
  message: string,
  headers: Record<string, string>,
  extra: { hint?: string; retryAfterSec?: number; body?: Record<string, unknown>; data?: Record<string, string> } = {}
): Response {
  const out: Record<string, string> = { ...headers };
  if (extra.retryAfterSec !== undefined) out['Retry-After'] = String(extra.retryAfterSec);
  return Response.json(
    { ...(extra.body ?? {}), error: { code, message, ...(extra.hint ? { hint: extra.hint } : {}), ...(extra.data ?? {}) } },
    { status, headers: out }
  );
}

function engineErrorResponse(err: EngineError, headers: Record<string, string>): Response {
  return errorResponse(err.status, err.code, err.error, headers, { hint: err.hint, retryAfterSec: err.retryAfterSec, data: err.data });
}

/**
 * Record a `/api/mcp/call` refusal that happened before `callTool` (bad JSON, bad body shape, bad session header).
 * Keyed by the server-derived user, never by anything the client sent; the tool label is a catalog name or a
 * fixed label, so invented names cannot mint rows. Noise rows fold into one row per minute.
 */
function auditCallRefusal(db: Database, ctx: McpRouteContext, raw: unknown): void {
  try {
    const body = (raw && typeof raw === 'object' ? raw : {}) as { tool?: unknown; args?: unknown };
    const def = typeof body.tool === 'string' ? getToolDef(body.tool) : undefined;
    const actor = actorOf(ctx);
    const principal = userPrincipal(actor.userId);
    appendAudit(db, {
      transport: 'imperative',
      principalKind: principal.kind,
      principalId: principal.id,
      userId: actor.userId,
      role: actor.role,
      origin: 'direct',
      toolName: def ? def.name : UNKNOWN_TOOL_LABEL,
      classification: def ? def.classification : 'unknown',
      decision: 'invalid_args',
      argsPreview: body.args === undefined ? null : previewArgs(body.args),
      errorCode: 'invalid_args',
    });
  } catch (err) {
    console.error('[mcp-audit] failed to write refused-call row:', err);
  }
}

const NOT_FOUND = (headers: Record<string, string>) => errorResponse(404, 'not_found', 'Not found', headers);

const ORIGIN_REQUIRED = (headers: Record<string, string>) =>
  errorResponse(403, 'origin_required', 'This request must come from the dashboard page in a browser.', headers, {
    hint: 'Open Wilson in a browser tab; requests with no browser Origin or Sec-Fetch-Site are refused.',
  });

/** The 403 `origin_required` response when the request is not provably from the dashboard page, else null. */
function browserProof(req: Request, ctx: McpRouteContext): Response | null {
  const denied = requireBrowserProof(req, ctx.port);
  if (!denied) return null;
  for (const [k, v] of Object.entries(ctx.headers)) denied.headers.set(k, v);
  return denied;
}

type Parsed<T> = { ok: true; data: T } | { ok: false; response: Response };

async function readBody<S extends z.ZodType>(req: Request, schema: S, headers: Record<string, string>): Promise<Parsed<z.infer<S>>> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return { ok: false, response: errorResponse(400, 'invalid_args', 'Request body must be valid JSON', headers) };
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    return { ok: false, response: errorResponse(400, 'invalid_args', describeZodError(result.error), headers) };
  }
  return { ok: true, data: result.data };
}

interface SessionResolution {
  /** null when the request names no session. */
  session: string | null;
  /** True when the (deprecated) query/body parameter was used. */
  deprecated: boolean;
  error?: Response;
}

/** Header first; a malformed header is a 400. The query/body parameter is the deprecated fallback. */
function resolveSession(req: Request, url: URL, bodySession: string | undefined, headers: Record<string, string>): SessionResolution {
  const header = req.headers.get(SESSION_HEADER);
  if (header !== null) {
    if (!isUuidV4(header)) {
      return {
        session: null,
        deprecated: false,
        error: errorResponse(400, 'invalid_args', `${SESSION_HEADER} must be a UUID v4`, headers),
      };
    }
    return { session: header, deprecated: false };
  }
  const legacy = bodySession ?? url.searchParams.get('sessionGeneration') ?? undefined;
  if (legacy) {
    // Held to the same rule as the header: a free-form string would let a client pick any session it likes.
    if (!isUuidV4(legacy)) {
      return {
        session: null,
        deprecated: true,
        error: errorResponse(400, 'invalid_args', 'sessionGeneration must be a UUID v4 (and is deprecated: send the header)', headers),
      };
    }
    return { session: legacy, deprecated: true };
  }
  return { session: null, deprecated: false };
}

function withDeprecation(headers: Record<string, string>, deprecated: boolean): Record<string, string> {
  if (!deprecated) return headers;
  return {
    ...headers,
    Deprecation: 'true',
    'X-Wilson-Deprecation': `The sessionGeneration query/body parameter is deprecated; send the ${SESSION_HEADER} header.`,
  };
}

const SESSION_REQUIRED = (headers: Record<string, string>) =>
  errorResponse(400, 'invalid_args', `${SESSION_HEADER} header is required`, headers, { hint: 'Send the tab session id (a UUID v4) in that header.' });

/** Grant rows as the browser sees them: never the session generation. */
function grantView(g: McpGrant) {
  return { id: g.id, tool_name: g.tool_name, created_at: g.created_at, expires_at: g.expires_at };
}

function outcomeResponse(out: TypedOutcome, headers: Record<string, string>): Response {
  if (out.outcome === 'expired') {
    return errorResponse(409, 'expired', 'This request expired before it was approved. Ask the agent to try again.', headers, {
      body: { outcome: 'expired' },
    });
  }
  if (out.outcome === 'approval_too_fast') {
    return errorResponse(409, 'approval_too_fast', 'Wait a moment before approving so you can read the card.', headers, {
      body: { outcome: 'approval_too_fast' },
    });
  }
  if (out.outcome === 'forbidden') {
    return errorResponse(403, 'role_forbidden', 'Your role cannot approve changes to financial data.', headers, {
      body: { outcome: 'forbidden' },
    });
  }
  return json(out, 200, headers);
}

/**
 * With auth on, an admin may see and revoke any user's grants (grant routes are owner-or-admin, #156); everyone
 * else acts only on their own. With auth off there is one implicit user, whose grants are all their own anyway.
 */
function adminActsOnAnyGrant(ctx: McpRouteContext): boolean {
  return ctx.authEnabled && ctx.currentUser?.role === 'admin';
}

/**
 * Try to handle `path` as an MCP bridge route. Returns null if it doesn't
 * match anything here, so the caller (dashboard server.ts) falls through to
 * its own routing.
 */
export async function handleMcpRoute(req: Request, url: URL, path: string, ctx: McpRouteContext): Promise<Response | null> {
  const { activeDb } = ctx;
  const headers = ctx.headers;
  const actor = actorOf(ctx);
  /** Who is looking at an operation: this tab's session, with token names resolved for external clients' cards. */
  const viewerFor = (session: string | null): OperationViewer => ({
    sessionGeneration: session,
    db: activeDb, // lets a read-ask card show the filter the server parsed
    tokenNameOf: (sg) => clientTokenName(activeDb, sg),
  });
  /** Every operation this user may see and act on: agent operations, plus the dashboard chat's pending one. */
  const visiblePending = (): McpOperation[] => {
    const operations: McpOperation[] = getPendingOperations(activeDb).filter((op) => isOperationVisible(op, actor));
    const chatOp = getPendingChatOperation(activeDb, {
      profile: getCurrentProfileName(),
      userId: actor.userId,
      role: actor.role,
    });
    if (chatOp && chatOp.status === 'pending' && isOperationVisible(chatOp, actor) && !operations.some((op) => op.id === chatOp.id)) {
      operations.push(chatOp);
    }
    return operations;
  };
  /** The current agent-access snapshot for this request. The tab session is optional: without one no grant matches. */
  const stateFor = (session: string | null, scope: RequestScope) =>
    buildAgentState(activeDb, { scope: { ...scope, sessionGeneration: session ?? '' }, actor, viewer: viewerFor(session), pending: visiblePending() });

  if (path === '/api/mcp/catalog' && req.method === 'GET') {
    return json({ tools: listCatalog() }, 200, headers);
  }

  if (path === '/api/mcp/tools' && req.method === 'GET') {
    const s = resolveSession(req, url, undefined, headers);
    if (s.error) return s.error;
    if (!s.session) return SESSION_REQUIRED(headers);
    const scope = deriveScope(req, ctx, s.session);
    if (!scope) return ORIGIN_REQUIRED(headers);
    return json({ tools: exposedTools(activeDb, scope) }, 200, withDeprecation(headers, s.deprecated));
  }

  if (path === '/api/mcp/grants' && req.method === 'GET') {
    const s = resolveSession(req, url, undefined, headers);
    if (s.error) return s.error;
    if (!s.session) return SESSION_REQUIRED(headers);
    const scope = deriveScope(req, ctx, s.session);
    if (!scope) return ORIGIN_REQUIRED(headers);
    return json({ grants: listActiveGrants(activeDb, scope, { anyOwner: adminActsOnAnyGrant(ctx) }).map(grantView) }, 200, withDeprecation(headers, s.deprecated));
  }

  if (path === '/api/mcp/grants' && req.method === 'POST') {
    const noProof = browserProof(req, ctx);
    if (noProof) return noProof;
    const body = await readBody(req, GrantsBody, headers);
    if (!body.ok) return body.response;
    const s = resolveSession(req, url, body.data.sessionGeneration, headers);
    if (s.error) return s.error;
    if (!s.session) return SESSION_REQUIRED(headers);
    const scope = deriveScope(req, ctx, s.session);
    if (!scope) return ORIGIN_REQUIRED(headers);
    const limited = checkGrantCreationRate(activeDb, scope);
    if (limited) return engineErrorResponse(limited, headers);
    const result = grantLocalAccess(activeDb, scope, body.data.tools);
    if (!result.ok) return engineErrorResponse(result, headers);
    return json({ grants: result.grants.map(grantView) }, 200, withDeprecation(headers, s.deprecated));
  }

  const revokeOneMatch = path.match(/^\/api\/mcp\/grants\/([^/]+)$/);
  if (revokeOneMatch && req.method === 'DELETE') {
    const noProof = browserProof(req, ctx);
    if (noProof) return noProof;
    const s = resolveSession(req, url, undefined, headers);
    if (s.error) return s.error;
    const scope = deriveScope(req, ctx, s.session ?? '');
    if (!scope) return ORIGIN_REQUIRED(headers);
    // 404 for a grant that does not exist and for one that belongs to someone else: no way to probe ids.
    if (!revokeLocalGrant(activeDb, scope, revokeOneMatch[1], { anyOwner: adminActsOnAnyGrant(ctx) })) return NOT_FOUND(headers);
    return json({ success: true }, 200, withDeprecation(headers, s.deprecated));
  }

  if (path === '/api/mcp/grants/revoke-session' && req.method === 'POST') {
    const noProof = browserProof(req, ctx);
    if (noProof) return noProof;
    const body = await readBody(req, RevokeSessionBody, headers);
    if (!body.ok) return body.response;
    // Auth may have come on while this request awaited its body; it passed
    // the middleware with no login, so it cannot act as the implicit admin.
    if (!ctx.authEnabled && isAuthEnabled(activeDb)) return json({ error: 'Unauthorized' }, 401, headers);
    const s = resolveSession(req, url, body.data.sessionGeneration, headers);
    if (s.error) return s.error;
    if (!s.session) return SESSION_REQUIRED(headers);
    const scope = deriveScope(req, ctx, s.session);
    if (!scope) return ORIGIN_REQUIRED(headers);
    const count = revokeAllForSession(activeDb, scope, { anyOwner: adminActsOnAnyGrant(ctx) });
    return json({ revoked: count }, 200, withDeprecation(headers, s.deprecated));
  }

  // The one tool path: the server classifies the call and answers with `kind`.
  // A refusal before `callTool` is still an agent tool call, so it leaves an `invalid_args` noise row.
  if (path === '/api/mcp/call' && req.method === 'POST') {
    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      auditCallRefusal(activeDb, ctx, undefined);
      return errorResponse(400, 'invalid_args', 'Request body must be valid JSON', headers);
    }
    const parsedBody = CallBody.safeParse(raw);
    if (!parsedBody.success) {
      auditCallRefusal(activeDb, ctx, raw);
      return errorResponse(400, 'invalid_args', describeZodError(parsedBody.error), headers);
    }
    const body = { data: parsedBody.data };
    const s = resolveSession(req, url, undefined, headers);
    if (s.error) {
      auditCallRefusal(activeDb, ctx, raw);
      return s.error;
    }
    if (!s.session) {
      auditCallRefusal(activeDb, ctx, raw);
      return SESSION_REQUIRED(headers);
    }
    const scope = deriveScope(req, ctx, s.session);
    if (!scope) {
      auditCallRefusal(activeDb, ctx, raw);
      return ORIGIN_REQUIRED(headers);
    }
    const result = await callTool(activeDb, scope, body.data.grantId, body.data.tool, body.data.args, body.data.transport);
    if (!result.ok) return engineErrorResponse(result, headers);
    if (result.kind === 'read') return json({ kind: 'read', data: result.data }, 200, headers);
    if (result.kind === 'page') return json({ kind: 'page', ...(result.pageData === undefined ? {} : { pageData: result.pageData }) }, 200, headers);
    return json({ kind: 'operation', operation: toAgentOperationView(activeDb, result.operation, viewerFor(s.session)) }, 200, headers);
  }

  if (path === '/api/mcp/operations' && req.method === 'GET') {
    const s = resolveSession(req, url, undefined, headers);
    if (s.error) return s.error;
    const viewer = viewerFor(s.session);
    const operations = visiblePending();
    return json({ operations: operations.map((op) => toOperationView(op, viewer)) }, 200, withDeprecation(headers, s.deprecated));
  }

  const opMatch = path.match(/^\/api\/mcp\/operations\/([^/]+)$/);
  if (opMatch && req.method === 'GET') {
    const s = resolveSession(req, url, undefined, headers);
    if (s.error) return s.error;
    const op = getOperationById(activeDb, opMatch[1]);
    if (!op || !isOperationVisible(op, actor)) return NOT_FOUND(headers);
    // `?view=agent` is what the page's agent bridge polls: no row text, a sanitized result.
    if (url.searchParams.get('view') === 'agent') {
      const view = toAgentResolvedView(activeDb, op, viewerFor(s.session));
      // A read's data is delivered once, to the principal that asked; the stored copy goes right after.
      if (view.data !== undefined) clearReadOutcome(activeDb, op.id);
      return json({ operation: view }, 200, withDeprecation(headers, s.deprecated));
    }
    return json({ operation: toOperationView(op, viewerFor(s.session)) }, 200, withDeprecation(headers, s.deprecated));
  }

  const approveMatch = path.match(/^\/api\/mcp\/operations\/([^/]+)\/approve$/);
  if (approveMatch && req.method === 'POST') {
    const noProof = browserProof(req, ctx);
    if (noProof) return noProof;
    const id = approveMatch[1];
    const op = getOperationById(activeDb, id);
    if (!op || !isOperationVisible(op, actor)) return NOT_FOUND(headers);
    // Approving any operation — a chat card, a WebMCP tab's or an HTTP-MCP
    // client's — commits a write, so it takes the same canWrite rule as the
    // direct REST write routes (#156): a viewer gets 403 and the operation
    // stays pending, unanswered. The grant an operation was prepared under
    // never stands in for the approver's own role. (Rejecting stays open: a
    // denial never writes.)
    if (ctx.authEnabled && ctx.currentUser && !canWrite(ctx.currentUser.role)) {
      return errorResponse(403, 'role_forbidden', 'Forbidden: your role cannot approve changes', headers);
    }
    if (op.source === 'chat') {
      // Same two gates a WebMCP operation gets: the window must still be open, and with auth on only a writer approves.
      if (op.status === 'expired' || (op.status === 'pending' && isOperationExpired(op))) {
        // Release the agent (denied) so it is not left blocked behind a card that can no longer be approved.
        expireChatOperation(activeDb, id);
        return outcomeResponse({ outcome: 'expired' }, headers);
      }
      if (actor.authEnabled && actor.role !== 'admin') return outcomeResponse({ outcome: 'forbidden' }, headers);
      if (isApprovalTooFast(op)) return outcomeResponse({ outcome: 'approval_too_fast' }, headers);
      // A chat card answers only the exact request it was created for; a
      // stale one is refused (409) and changes nothing.
      const result = respondToChatOperation(activeDb, id, 'allow-once');
      if (!result.ok) return json({ error: result.error, outcome: 'stale' }, 409, headers);
      return json({ outcome: result.status }, 200, headers);
    }
    const outcome = approveWebMcpOperation(activeDb, id, getCurrentProfileName(), actor);
    // The data of a read the user allowed belongs to the agent that asked (and is delivered through its own session);
    // the approver's answer is only whether it happened.
    if (op.kind === 'read') delete outcome.after;
    return outcomeResponse(outcome, headers);
  }

  const rejectMatch = path.match(/^\/api\/mcp\/operations\/([^/]+)\/reject$/);
  if (rejectMatch && req.method === 'POST') {
    const noProof = browserProof(req, ctx);
    if (noProof) return noProof;
    const id = rejectMatch[1];
    const op = getOperationById(activeDb, id);
    if (!op || !isOperationVisible(op, actor)) return NOT_FOUND(headers);
    if (op.source === 'chat') {
      if (op.status === 'expired' || (op.status === 'pending' && isOperationExpired(op))) {
        expireChatOperation(activeDb, id);
        return outcomeResponse({ outcome: 'expired' }, headers);
      }
      // A chat card answers only the exact request it was created for; a
      // stale one is refused (409) and changes nothing.
      const result = respondToChatOperation(activeDb, id, 'deny');
      if (!result.ok) return json({ error: result.error, outcome: 'stale' }, 409, headers);
      return json({ outcome: result.status }, 200, headers);
    }
    return outcomeResponse(rejectOperation(activeDb, id, actor), headers);
  }

  const cancelMatch = path.match(/^\/api\/mcp\/operations\/([^/]+)\/cancel$/);
  if (cancelMatch && req.method === 'POST') {
    const s = resolveSession(req, url, undefined, headers);
    if (s.error) return s.error;
    if (!s.session) return SESSION_REQUIRED(headers);
    const op = getOperationById(activeDb, cancelMatch[1]);
    if (!op || !isOperationVisible(op, actor)) return NOT_FOUND(headers);
    const scope = deriveScope(req, ctx, s.session);
    if (!scope) return ORIGIN_REQUIRED(headers);
    const out = cancelOperation(activeDb, scope, cancelMatch[1]);
    if (!out) return NOT_FOUND(headers);
    // Same as approve and reject: an operation whose window closed answers 409, not 200.
    if (out.outcome === 'expired') return outcomeResponse(out, withDeprecation(headers, s.deprecated));
    return json(out, 200, withDeprecation(headers, s.deprecated));
  }

  // ── Client tokens for external /mcp clients ──────────────────────────────────

  if (path === '/api/mcp/client-tokens' && req.method === 'GET') {
    // Never the plaintext, never the hash: listClientTokens returns neither.
    return json({ tokens: listClientTokens(activeDb, actor) }, 200, headers);
  }

  if (path === '/api/mcp/client-tokens' && req.method === 'POST') {
    const noProof = browserProof(req, ctx);
    if (noProof) return noProof;
    const body = await readBody(req, ClientTokenBody, headers);
    if (!body.ok) return body.response;
    const limited = limiterFor(activeDb).take(`token-mint:${userKeyOf(actor.userId)}`, LIMIT_CLIENT_TOKEN_MINT);
    if (!limited.ok) {
      return errorResponse(429, 'rate_limited', 'Too many client tokens minted this hour — wait before minting another.', headers, { retryAfterSec: limited.retryAfterSec });
    }
    const minted = mintClientToken(
      activeDb,
      { userId: actor.userId, role: actor.role, profile: getCurrentProfileName(), authEnabled: actor.authEnabled },
      body.data
    );
    if (!minted.ok) return errorResponse(minted.status, minted.code, minted.error, headers);
    // The plaintext appears in this response and nowhere else.
    return json({ token: minted.token, meta: minted.meta }, 200, { ...headers, 'Cache-Control': 'no-store' });
  }

  const tokenMatch = path.match(/^\/api\/mcp\/client-tokens\/([^/]+)(\/rotate)?$/);
  if (tokenMatch && ((tokenMatch[2] && req.method === 'POST') || (!tokenMatch[2] && req.method === 'DELETE'))) {
    const noProof = browserProof(req, ctx);
    if (noProof) return noProof;
    const id = tokenMatch[1];
    if (!tokenMatch[2]) {
      if (!revokeClientToken(activeDb, id, actor)) return NOT_FOUND(headers);
      return json({ revoked: true }, 200, headers);
    }
    const limited = limiterFor(activeDb).take(`token-mint:${userKeyOf(actor.userId)}`, LIMIT_CLIENT_TOKEN_MINT);
    if (!limited.ok) {
      return errorResponse(429, 'rate_limited', 'Too many client tokens minted this hour — wait before rotating another.', headers, { retryAfterSec: limited.retryAfterSec });
    }
    const rotated = rotateClientToken(activeDb, id, actor, getCurrentProfileName());
    if (!rotated) return NOT_FOUND(headers);
    if (!rotated.ok) return errorResponse(rotated.status, rotated.code, rotated.error, headers);
    return json({ token: rotated.token, meta: rotated.meta }, 200, { ...headers, 'Cache-Control': 'no-store' });
  }

  const tokenToolsMatch = path.match(/^\/api\/mcp\/client-tokens\/([^/]+)\/tools$/);
  if (tokenToolsMatch && req.method === 'PUT') {
    const noProof = browserProof(req, ctx);
    if (noProof) return noProof;
    const body = await readBody(req, ClientTokenToolsBody, headers);
    if (!body.ok) return body.response;
    const updated = updateClientTokenTools(activeDb, tokenToolsMatch[1], actor, body.data.tools, getCurrentProfileName());
    if (!updated) return NOT_FOUND(headers);
    if (!updated.ok) return errorResponse(updated.status, updated.code, updated.error, headers);
    return json({ meta: updated.meta }, 200, headers);
  }

  // ── Agent access control center (P1): one state, the kill switch, policies ───

  if (path === '/api/mcp/state' && req.method === 'GET') {
    const s = resolveSession(req, url, undefined, headers);
    if (s.error) return s.error;
    if (!s.session) return SESSION_REQUIRED(headers);
    const scope = deriveScope(req, ctx, s.session);
    if (!scope) return ORIGIN_REQUIRED(headers);
    return json(stateFor(s.session, scope), 200, { ...headers, 'Cache-Control': 'no-store' });
  }

  if (path === '/api/mcp/settings' && req.method === 'PUT') {
    const noProof = browserProof(req, ctx);
    if (noProof) return noProof;
    // The kill switch and the grant lifetime are the admin's. With auth off every local session is that admin.
    if (actor.authEnabled && actor.role !== 'admin') {
      return errorResponse(403, 'role_forbidden', 'Only an admin can change agent access settings.', headers);
    }
    const body = await readBody(req, SettingsBody, headers);
    if (!body.ok) return body.response;
    const s = resolveSession(req, url, undefined, headers);
    if (s.error) return s.error;
    if (body.data.grantTtlMinutes !== undefined && !setGrantTtlMinutes(body.data.grantTtlMinutes)) {
      return errorResponse(500, 'internal', 'Could not save the grant lifetime.', headers);
    }
    if (body.data.judgeDailyLimit !== undefined && !setJudgeDailyLimit(body.data.judgeDailyLimit)) {
      return errorResponse(500, 'internal', 'Could not save the judge limit.', headers);
    }
    // Only a real change flips the switch: turning off an already-off switch must not move the epoch.
    if (body.data.enabled !== undefined && body.data.enabled !== isAgentAccessEnabled()) {
      setKillSwitch(activeDb, body.data.enabled);
    }
    const scope = deriveScope(req, ctx, s.session ?? '');
    if (!scope) return ORIGIN_REQUIRED(headers);
    return json(stateFor(s.session, scope), 200, { ...headers, 'Cache-Control': 'no-store' });
  }

  if (path === '/api/mcp/policies' && req.method === 'GET') {
    return json({ policies: listPolicies(activeDb, actor.userId) }, 200, { ...headers, 'Cache-Control': 'no-store' });
  }

  const policyMatch = path.match(/^\/api\/mcp\/policies\/([^/]+)$/);
  if (policyMatch && req.method === 'PUT') {
    const noProof = browserProof(req, ctx);
    if (noProof) return noProof;
    const body = await readBody(req, PolicyBody, headers);
    if (!body.ok) return body.response;
    const result = setPolicy(activeDb, actor, decodeURIComponent(policyMatch[1]), body.data.policy);
    if (!result.ok) return errorResponse(result.status, result.code, result.error, headers);
    return json({ tool: result.tool, policy: result.policy, effective: result.effective }, 200, headers);
  }

  if (path === '/api/mcp/audit' && req.method === 'GET') {
    const limited = limiterFor(activeDb).take(`audit:${userKeyOf(actor.userId)}`, LIMIT_AUDIT_GET);
    if (!limited.ok) {
      return errorResponse(429, 'rate_limited', 'Too many audit requests — wait a moment.', headers, { retryAfterSec: limited.retryAfterSec });
    }
    const query = AuditQuery.safeParse(Object.fromEntries(url.searchParams));
    if (!query.success) return errorResponse(400, 'invalid_args', describeZodError(query.error), headers);
    // Admins (and everyone, while auth is off) see every row; a viewer sees only their own.
    const restrictToUserId = actor.authEnabled && actor.role !== 'admin' ? actor.userId : undefined;
    return json(listAudit(activeDb, { ...query.data, restrictToUserId }), 200, headers);
  }

  return null;
}
