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
import type { DashboardUser } from './auth.js';
import { getCurrentProfileName } from './db-manager.js';
import { getPendingChatOperation, respondToChatOperation } from './chat.js';
import {
  listCatalog,
  grantLocalAccess,
  listActiveGrants,
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
import type { McpOperation } from '../mcp/store.js';

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

/** Operations visible to the current dashboard user — never someone else's pending mutation. */
function visibleOperation(op: McpOperation | null, ctx: McpRouteContext): McpOperation | null {
  if (!op) return null;
  if (ctx.authEnabled && ctx.currentUser && op.user_id !== null && op.user_id !== ctx.currentUser.id) {
    return null;
  }
  return op;
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
    return json({ grants: listActiveGrants(activeDb, sessionGeneration) }, 200, headers);
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
    revokeLocalGrant(activeDb, revokeOneMatch[1]);
    return json({ success: true }, 200, headers);
  }

  if (path === '/api/mcp/grants/revoke-session' && req.method === 'POST') {
    const body = (await req.json()) as { sessionGeneration?: string };
    if (!body.sessionGeneration) return json({ error: 'sessionGeneration is required' }, 400, headers);
    const count = revokeAllForSession(activeDb, body.sessionGeneration);
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
    if (op.source === 'chat') {
      const ok = respondToChatOperation(activeDb, id, 'allow-once');
      return json({ outcome: ok ? 'committed' : 'unknown' }, 200, headers);
    }
    return json(approveWebMcpOperation(activeDb, id, getCurrentProfileName()), 200, headers);
  }

  const rejectMatch = path.match(/^\/api\/mcp\/operations\/([^/]+)\/reject$/);
  if (rejectMatch && req.method === 'POST') {
    const id = rejectMatch[1];
    const op = visibleOperation(getOperationById(activeDb, id), ctx);
    if (!op) return json({ error: 'Not found' }, 404, headers);
    if (op.source === 'chat') {
      const ok = respondToChatOperation(activeDb, id, 'deny');
      return json({ outcome: ok ? 'rejected' : 'unknown' }, 200, headers);
    }
    return json(rejectOperation(activeDb, id), 200, headers);
  }

  return null;
}
