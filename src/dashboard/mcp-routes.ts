/**
 * HTTP routes for the WebMCP bridge, mounted from src/dashboard/server.ts.
 * Handles grant management, the read/prepare path, and the single
 * confirmation queue that WebMCP, the HTTP-MCP fallback, and the dashboard
 * chat's approval hang fix all share.
 *
 * Every route here re-derives scope (role, profile, origin, session
 * generation) from the current request rather than trusting anything the
 * client claims about its own privileges — see src/mcp/engine.ts and
 * src/mcp/store.ts for why that's the actual security boundary.
 */
import type { Database } from '../db/compat-sqlite.js';
import { canWrite, isAuthEnabled, type DashboardUser } from './auth.js';
import { getCurrentProfileName } from './db-manager.js';
import { getPendingChatOperation, respondToChatOperation } from './chat.js';
import {
  listCatalog,
  grantLocalAccess,
  listActiveGrants,
  getLocalGrant,
  revokeLocalGrant,
  revokeAllForSession,
  exposedTools,
  callReadTool,
  prepareOperation,
  getPendingOperations,
  getOperationById,
  approveWebMcpOperation,
  rejectOperation,
  type RequestScope,
} from '../mcp/engine.js';
import type { McpGrant, McpOperation } from '../mcp/store.js';

export interface McpRouteContext {
  activeDb: Database;
  currentUser: DashboardUser | null;
  authEnabled: boolean;
  port: number;
  headers: Record<string, string>;
}

function deriveScope(req: Request, ctx: McpRouteContext, sessionGeneration: string): RequestScope {
  const origin = req.headers.get('Origin') ?? `http://localhost:${ctx.port}`;
  return {
    role: ctx.authEnabled && ctx.currentUser ? ctx.currentUser.role : 'admin',
    userId: ctx.authEnabled && ctx.currentUser ? ctx.currentUser.id : null,
    profile: getCurrentProfileName(),
    origin,
    sessionGeneration,
  };
}

function json(data: unknown, status: number, headers: Record<string, string>): Response {
  return Response.json(data, { status, headers });
}

/**
 * Operations visible to the current dashboard user — never someone else's
 * pending mutation. With auth on, an operation with no owner (prepared
 * under a grant minted while auth was off) belongs to no one in particular,
 * so only an admin may see or answer it; a viewer gets the same 404 as for
 * another user's operation.
 */
function visibleOperation(op: McpOperation | null, ctx: McpRouteContext): McpOperation | null {
  if (!op) return null;
  if (ctx.authEnabled && ctx.currentUser) {
    if (op.user_id === null) return ctx.currentUser.role === 'admin' ? op : null;
    if (op.user_id !== ctx.currentUser.id) return null;
  }
  return op;
}

/**
 * Whether the caller may see or revoke this grant. With auth on, a non-admin
 * acts only on grants bound to their own user id; an admin on any grant.
 * With auth off there is one implicit user, who owns everything.
 */
function ownsGrant(grant: Pick<McpGrant, 'user_id'>, ctx: McpRouteContext): boolean {
  if (!ctx.authEnabled || !ctx.currentUser) return true;
  return ctx.currentUser.role === 'admin' || grant.user_id === ctx.currentUser.id;
}

/**
 * Try to handle `path` as an MCP bridge route. Returns null if it doesn't
 * match anything here, so the caller (dashboard server.ts) falls through to
 * its own routing.
 */
export async function handleMcpRoute(req: Request, url: URL, path: string, ctx: McpRouteContext): Promise<Response | null> {
  const { activeDb, headers } = ctx;

  if (path === '/api/mcp/catalog' && req.method === 'GET') {
    return json({ tools: listCatalog() }, 200, headers);
  }

  if (path === '/api/mcp/tools' && req.method === 'GET') {
    const sessionGeneration = url.searchParams.get('sessionGeneration');
    if (!sessionGeneration) return json({ error: 'sessionGeneration is required' }, 400, headers);
    const scope = deriveScope(req, ctx, sessionGeneration);
    return json({ tools: exposedTools(activeDb, scope) }, 200, headers);
  }

  if (path === '/api/mcp/grants' && req.method === 'GET') {
    const sessionGeneration = url.searchParams.get('sessionGeneration');
    if (!sessionGeneration) return json({ error: 'sessionGeneration is required' }, 400, headers);
    const grants = listActiveGrants(activeDb, sessionGeneration).filter((g) => ownsGrant(g, ctx));
    return json({ grants }, 200, headers);
  }

  if (path === '/api/mcp/grants' && req.method === 'POST') {
    const body = (await req.json()) as { sessionGeneration?: string; tools?: string[] };
    if (!body.sessionGeneration || !body.tools?.length) {
      return json({ error: 'sessionGeneration and tools are required' }, 400, headers);
    }
    const scope = deriveScope(req, ctx, body.sessionGeneration);
    const result = grantLocalAccess(activeDb, scope, body.tools);
    if (!result.ok) return json({ error: result.error }, result.status, headers);
    return json({ grants: result.grants }, 200, headers);
  }

  const revokeOneMatch = path.match(/^\/api\/mcp\/grants\/([^/]+)$/);
  if (revokeOneMatch && req.method === 'DELETE') {
    // Someone else's grant gets the same 404 as one that does not exist.
    const grant = getLocalGrant(activeDb, revokeOneMatch[1]);
    if (!grant || !ownsGrant(grant, ctx)) return json({ error: 'Not found' }, 404, headers);
    revokeLocalGrant(activeDb, grant.id);
    return json({ success: true }, 200, headers);
  }

  if (path === '/api/mcp/grants/revoke-session' && req.method === 'POST') {
    const body = (await req.json()) as { sessionGeneration?: string };
    if (!body.sessionGeneration) return json({ error: 'sessionGeneration is required' }, 400, headers);
    // Auth may have come on while this request awaited its body; it passed
    // the middleware with no login, so it cannot act as the implicit admin.
    if (!ctx.authEnabled && isAuthEnabled(activeDb)) return json({ error: 'Unauthorized' }, 401, headers);
    const onlyUserId =
      ctx.authEnabled && ctx.currentUser && ctx.currentUser.role !== 'admin' ? ctx.currentUser.id : undefined;
    const count = revokeAllForSession(activeDb, body.sessionGeneration, onlyUserId);
    return json({ revoked: count }, 200, headers);
  }

  if (path === '/api/mcp/read' && req.method === 'POST') {
    const body = (await req.json()) as { sessionGeneration?: string; grantId?: string; tool?: string; args?: Record<string, unknown> };
    if (!body.sessionGeneration || !body.grantId || !body.tool) {
      return json({ error: 'sessionGeneration, grantId, and tool are required' }, 400, headers);
    }
    const scope = deriveScope(req, ctx, body.sessionGeneration);
    const result = await callReadTool(activeDb, scope, body.grantId, body.tool, body.args ?? {});
    if (!result.ok) return json({ error: result.error }, result.status, headers);
    return json({ data: result.data }, 200, headers);
  }

  if (path === '/api/mcp/prepare' && req.method === 'POST') {
    const body = (await req.json()) as { sessionGeneration?: string; grantId?: string; tool?: string; args?: Record<string, unknown> };
    if (!body.sessionGeneration || !body.grantId || !body.tool) {
      return json({ error: 'sessionGeneration, grantId, and tool are required' }, 400, headers);
    }
    const scope = deriveScope(req, ctx, body.sessionGeneration);
    const result = prepareOperation(activeDb, scope, 'webmcp', body.grantId, body.tool, body.args ?? {});
    if (!result.ok) return json({ error: result.error }, result.status, headers);
    return json({ operation: result.operation }, 200, headers);
  }

  if (path === '/api/mcp/operations' && req.method === 'GET') {
    const operations = getPendingOperations(activeDb).filter((op) => visibleOperation(op, ctx) !== null);
    const chatOp = getPendingChatOperation(activeDb, {
      profile: getCurrentProfileName(),
      userId: ctx.authEnabled && ctx.currentUser ? ctx.currentUser.id : null,
      role: ctx.authEnabled && ctx.currentUser ? ctx.currentUser.role : 'admin',
    });
    const chatVisible = visibleOperation(chatOp, ctx);
    if (chatVisible && !operations.some((op) => op.id === chatVisible.id)) {
      operations.push(chatVisible);
    }
    return json({ operations }, 200, headers);
  }

  const opMatch = path.match(/^\/api\/mcp\/operations\/([^/]+)$/);
  if (opMatch && req.method === 'GET') {
    const op = visibleOperation(getOperationById(activeDb, opMatch[1]), ctx);
    if (!op) return json({ error: 'Not found' }, 404, headers);
    return json({ operation: op }, 200, headers);
  }

  const approveMatch = path.match(/^\/api\/mcp\/operations\/([^/]+)\/approve$/);
  if (approveMatch && req.method === 'POST') {
    const id = approveMatch[1];
    const op = visibleOperation(getOperationById(activeDb, id), ctx);
    if (!op) return json({ error: 'Not found' }, 404, headers);
    // Approving any operation — a chat card, a WebMCP tab's or an HTTP-MCP
    // client's — commits a write, so it takes the same canWrite rule as the
    // direct REST write routes (#156): a viewer gets 403 and the operation
    // stays pending, unanswered. The grant an operation was prepared under
    // never stands in for the approver's own role. (Rejecting stays open: a
    // denial never writes.)
    if (ctx.authEnabled && ctx.currentUser && !canWrite(ctx.currentUser.role)) {
      return json({ error: 'Forbidden: your role cannot approve changes' }, 403, headers);
    }
    if (op.source === 'chat') {
      // A chat card answers only the exact request it was created for; a
      // stale one is refused (409) and changes nothing.
      const result = respondToChatOperation(activeDb, id, 'allow-once');
      if (!result.ok) return json({ error: result.error, outcome: 'stale' }, 409, headers);
      return json({ outcome: result.status }, 200, headers);
    }
    return json(approveWebMcpOperation(activeDb, id, getCurrentProfileName()), 200, headers);
  }

  const rejectMatch = path.match(/^\/api\/mcp\/operations\/([^/]+)\/reject$/);
  if (rejectMatch && req.method === 'POST') {
    const id = rejectMatch[1];
    const op = visibleOperation(getOperationById(activeDb, id), ctx);
    if (!op) return json({ error: 'Not found' }, 404, headers);
    if (op.source === 'chat') {
      // A chat card answers only the exact request it was created for; a
      // stale one is refused (409) and changes nothing.
      const result = respondToChatOperation(activeDb, id, 'deny');
      if (!result.ok) return json({ error: result.error, outcome: 'stale' }, 409, headers);
      return json({ outcome: result.status }, 200, headers);
    }
    return json(rejectOperation(activeDb, id), 200, headers);
  }

  return null;
}
