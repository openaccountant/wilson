/**
 * Streamable-HTTP `/mcp` fallback transport, mounted on the dashboard's own
 * Bun.serve router (src/dashboard/server.ts). This is the compatibility path
 * for any generic MCP client — including Hronaut — that doesn't speak the
 * native WebMCP browser API. It calls into the exact same grant + prepare/
 * commit engine as the in-page bridge (src/mcp/engine.ts): there is no
 * separate, weaker code path here.
 *
 * A fresh McpServer + transport pair is built per HTTP request (stateless
 * mode). That's deliberate, not just simple: the caller's bearer token is
 * resolved to its grants *before* any tool is registered, so a client with
 * zero grants genuinely sees zero tools in `tools/list` — the tool surface
 * itself reflects the grant, rather than every tool existing but erroring
 * out when called.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { Database } from '../db/compat-sqlite.js';
import { MCP_TOOL_CATALOG, isMutatingCall } from './tool-catalog.js';
import { listGrantsForSession } from './store.js';
import { waitForOperationResolution } from './store.js';
import { callReadTool, prepareOperation, type RequestScope } from './engine.js';

/** Fixed origin bound into grants created for HTTP-MCP clients (there is no browser Origin for them). */
export const HTTP_MCP_ORIGIN = 'http-mcp-client';

const MUTATION_APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

function extractBearerToken(req: Request): string | null {
  const header = req.headers.get('Authorization');
  if (header?.startsWith('Bearer ')) return header.slice(7);
  return null;
}

function toolErrorResult(message: string) {
  return { content: [{ type: 'text' as const, text: message }], isError: true };
}

function toolTextResult(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

/**
 * Resolve a bearer token to the scope + grant set it's entitled to, using
 * the token itself as the grant "session generation". A token with no
 * grants (never issued one, revoked, or expired) resolves to an empty tool
 * set — that's the zero-exposure-by-default guarantee for this transport.
 */
function resolveScope(db: Database, token: string | null): { scope: RequestScope; grantByTool: Map<string, string> } | null {
  if (!token) return null;
  const grants = listGrantsForSession(db, token);
  if (grants.length === 0) return null;
  const first = grants[0];
  const grantByTool = new Map<string, string>();
  for (const g of grants) grantByTool.set(g.tool_name, g.id);
  return {
    scope: {
      role: first.role,
      userId: first.user_id,
      profile: first.profile,
      origin: first.origin,
      sessionGeneration: token,
    },
    grantByTool,
  };
}

function buildServerForRequest(db: Database, token: string | null): McpServer {
  const server = new McpServer({ name: 'wilson-dashboard', version: '1.0.0' });
  const resolved = resolveScope(db, token);

  if (!resolved) {
    // No valid grants for this bearer token: expose the tools capability
    // with an empty list rather than erroring — the SDK only wires up the
    // tools/list + tools/call handlers the first time a tool is registered,
    // so register-then-remove a throwaway tool purely to arm those
    // handlers. tools/list then genuinely returns [], matching what most
    // MCP clients (Hronaut included) expect from "no access granted" rather
    // than a raw protocol error.
    const placeholder = server.registerTool('__no_tools_granted__', { description: 'placeholder' }, async () => ({ content: [] }));
    placeholder.remove();
    return server;
  }

  const { scope, grantByTool } = resolved;
  let registeredAny = false;

  for (const def of MCP_TOOL_CATALOG) {
    const grantId = grantByTool.get(def.name);
    if (!grantId) continue; // no grant for this specific tool — not exposed
    registeredAny = true;

    server.registerTool(
      def.name,
      { description: def.description, inputSchema: def.zodShape },
      async (args: Record<string, unknown>) => {
        if (!isMutatingCall(def.name, args)) {
          const result = await callReadTool(db, scope, grantId, def.name, args);
          if (!result.ok) return toolErrorResult(result.error);
          return toolTextResult(result.data);
        }

        const prepared = prepareOperation(db, scope, 'http-mcp', grantId, def.name, args);
        if (!prepared.ok) return toolErrorResult(prepared.error);

        // Block until a human resolves it via the dashboard's confirmation
        // queue (the same one WebMCP and chat feed into), or time out.
        const resolvedOp = await waitForOperationResolution(db, prepared.operation.id, MUTATION_APPROVAL_TIMEOUT_MS);
        if (!resolvedOp || resolvedOp.status === 'pending' || resolvedOp.status === 'expired') {
          return toolTextResult({ outcome: 'unknown', operationId: prepared.operation.id, reason: 'No response within the approval window — reconcile by operationId.' });
        }
        const outcome = resolvedOp.outcome_json ? JSON.parse(resolvedOp.outcome_json) : undefined;
        return toolTextResult({ outcome: resolvedOp.status, operationId: resolvedOp.id, result: outcome });
      }
    );
  }

  if (!registeredAny) {
    const placeholder = server.registerTool('__no_tools_granted__', { description: 'placeholder' }, async () => ({ content: [] }));
    placeholder.remove();
  }

  return server;
}

/**
 * Handle one HTTP request against the `/mcp` endpoint. Stateless: builds a
 * fresh server + transport, connects, delegates to the transport, then lets
 * both get garbage collected once the response is sent.
 */
export async function handleMcpHttpRequest(db: Database, req: Request): Promise<Response> {
  const token = extractBearerToken(req);
  const server = buildServerForRequest(db, token);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless: no cross-request session state to manage
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return transport.handleRequest(req);
}
