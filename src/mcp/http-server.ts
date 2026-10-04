/**
 * Streamable-HTTP `/mcp` fallback transport, mounted on the dashboard's own
 * Bun.serve router (src/dashboard/server.ts). This is the compatibility path
 * for any generic MCP client — including Hronaut — that doesn't speak the
 * native WebMCP browser API. It calls into the exact same grant + prepare/
 * commit engine as the in-page bridge (src/mcp/engine.ts): there is no
 * separate, weaker code path here.
 *
 * Every request carries a dedicated client token (`wmcp_…`, minted in
 * Settings → Agent access; see ./client-tokens.ts). The tab's own session id is
 * NOT accepted. A request with a missing or invalid token is a 401 and never
 * reaches the MCP SDK.
 *
 * A fresh McpServer + transport pair is built per HTTP request (stateless
 * mode). That's deliberate, not just simple: the caller's token is resolved to
 * its grants *before* any tool is registered, so `tools/list` genuinely lists
 * only what the token may call right now (granted, offered on this transport,
 * current schema, and allowed for the owner's live role and the auth state) —
 * the tool surface itself reflects the grant, rather than every tool existing
 * but erroring out when called.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { Database } from '../db/compat-sqlite.js';
import { MCP_TOOL_CATALOG, getToolDef, isWriteTool, schemaDigest, toolAnnotations, type McpToolDef } from './tool-catalog.js';
import { clearReadOutcome, expireStaleOperations, getOperation, readDeliveryRefusal, waitForOperationResolution, type McpGrant, type Role } from './store.js';
import { getEffectivePolicy } from './policies.js';
import { KILL_SWITCH_MESSAGE, isAgentAccessEnabled } from './global-state.js';
import { callTool, UNKNOWN_TOOL_LABEL } from './engine.js';
import { appendAudit, previewArgs, ANONYMOUS_PRINCIPAL, type Principal } from './audit.js';
import { limiterFor, LIMIT_MCP_FAILED_BEARER, LIMIT_MCP_REFUSED_CALLS } from './rate-limit.js';
import { sanitizeStoredOutcomeForAgent } from './operation-view.js';
import { CLIENT_TOKEN_PREFIX, HTTP_MCP_ORIGIN, resolveClientToken, type ResolvedClientToken } from './client-tokens.js';
import { isAuthEnabled } from '../dashboard/auth.js';

export { HTTP_MCP_ORIGIN };

/**
 * How long a `/mcp` write call holds its connection open waiting for the human
 * to answer the card. It must stay under the server's 255 s idle timeout
 * (DASHBOARD_IDLE_TIMEOUT_S in src/dashboard/server.ts) or Bun would cut the
 * connection first. After it the call returns `unknown` with the operation id,
 * and the client asks `get_operation_result` later.
 */
export const MUTATION_APPROVAL_WAIT_MS = 240_000;

function toolErrorResult(message: string) {
  return { content: [{ type: 'text' as const, text: message }], isError: true };
}

function toolTextResult(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

/**
 * The tools `tools/list` shows for a token, in catalog order. A tool is listed
 * only when the token holds a grant for it with the CURRENT schema digest, it is
 * offered on `http-mcp`, and the live state still allows calling it: write tools
 * are hidden while dashboard auth is off, and admin-only tools when the owner
 * is no longer an admin. `callTool` enforces each of these again.
 */
export function visibleToolDefs(
  catalog: McpToolDef[],
  grants: Array<Pick<McpGrant, 'tool_name' | 'schema_digest'>>,
  ctx: { authEnabled: boolean; liveRole: Role },
  digestOf: (name: string) => string = schemaDigest
): McpToolDef[] {
  const digests = new Map(grants.map((g) => [g.tool_name, g.schema_digest]));
  return catalog.filter((def) => {
    if (!digests.has(def.name)) return false;
    if (!def.transports.includes('http-mcp')) return false;
    if (digests.get(def.name) !== digestOf(def.name)) return false;
    if (isWriteTool(def) && !ctx.authEnabled) return false;
    if (def.minRole === 'admin' && ctx.liveRole !== 'admin') return false;
    return true;
  });
}

/**
 * Wait for a human to resolve a pending operation, up to `waitMs`. A call that
 * is still pending afterwards (or whose window closed) answers with the
 * operation id so the client can reconcile with `get_operation_result`.
 */
export async function awaitOperationOutcome(
  db: Database,
  operationId: string,
  waitMs: number = MUTATION_APPROVAL_WAIT_MS
): Promise<Record<string, unknown>> {
  await waitForOperationResolution(db, operationId, waitMs);
  // An operation whose confirmation window closed while we waited is still 'pending' until something sweeps it.
  expireStaleOperations(db);
  const resolvedOp = getOperation(db, operationId);
  if (!resolvedOp || resolvedOp.status === 'pending') {
    return { outcome: 'unknown', operationId, reason: 'Still waiting for approval — call get_operation_result later.' };
  }
  if (resolvedOp.status === 'expired') {
    return { outcome: 'expired', operationId, reason: 'The approval window closed before the user answered. Propose the change again.' };
  }
  if (resolvedOp.kind === 'read' && resolvedOp.status === 'committed' && !isAgentAccessEnabled()) {
    return { outcome: 'forbidden', operationId, reason: KILL_SWITCH_MESSAGE };
  }
  if (resolvedOp.kind === 'read' && resolvedOp.status === 'committed' && readDeliveryRefusal(db, resolvedOp) !== null) {
    // The grant behind the read died (or the kill switch flipped) after the human approved: no data, status only.
    clearReadOutcome(db, operationId);
    return { outcome: 'forbidden', operationId, reason: 'The grant behind this read is no longer valid, so its data was discarded. Ask again.' };
  }
  if (resolvedOp.kind === 'read' && resolvedOp.status === 'committed' && resolvedOp.outcome_json !== null) {
    // The user allowed this read: the client gets the capped data itself, exactly what a direct read returns, once.
    const data = JSON.parse(resolvedOp.outcome_json) as Record<string, unknown>;
    clearReadOutcome(db, operationId);
    return data;
  }
  // The result an external agent gets has the same hygiene as a read: no raw row text.
  return { outcome: resolvedOp.status, operationId: resolvedOp.id, result: sanitizeStoredOutcomeForAgent(db, resolvedOp.outcome_json) };
}

/**
 * Which tool handlers (and so `callTool`, and so an audit row) ran for this
 * request, counted per tool name. A batch can have some calls reach a handler
 * and others be refused by the SDK first; only the refused ones still need a row.
 */
interface CallState {
  reached: Map<string, number>;
}

function buildServerForRequest(db: Database, resolved: ResolvedClientToken, state: CallState): McpServer {
  const server = new McpServer({ name: 'wilson-dashboard', version: '1.0.0' });
  const { scope, grantByTool } = resolved;
  // The kill switch hides everything, in every profile; a tool the owner turned Off is not listed either.
  const visible = isAgentAccessEnabled()
    ? visibleToolDefs(MCP_TOOL_CATALOG, resolved.grants, { authEnabled: isAuthEnabled(db), liveRole: resolved.liveRole })
        .filter((def) => getEffectivePolicy(db, scope.userId, def.name) !== 'off')
    : [];

  for (const def of visible) {
    const grantId = grantByTool.get(def.name)!;

    server.registerTool(
      def.name,
      // Strict, like the server-side validator: an unknown argument is refused, not silently dropped.
      { description: def.description, inputSchema: z.object(def.zodShape).strict(), annotations: toolAnnotations(def.name) },
      async (args: Record<string, unknown>) => {
        state.reached.set(def.name, (state.reached.get(def.name) ?? 0) + 1);
        const result = await callTool(db, scope, grantId, def.name, args, 'http-mcp');
        if (!result.ok) return toolErrorResult(result.error);
        if (result.kind === 'read') return toolTextResult(result.data);
        // A page tool is never offered on /mcp (tab-only), so this only satisfies the type.
        if (result.kind === 'page') return toolErrorResult(`${def.name} only works inside the dashboard tab.`);

        // Block until a human resolves it via the dashboard's confirmation queue (the same one
        // WebMCP and chat feed into), or give up after MUTATION_APPROVAL_WAIT_MS.
        return toolTextResult(await awaitOperationOutcome(db, result.operation.id));
      }
    );
  }

  if (visible.length === 0) {
    // The SDK only wires up tools/list + tools/call the first time a tool is registered, so register-then-remove
    // a throwaway tool purely to arm them. tools/list then genuinely returns [] rather than a protocol error.
    const placeholder = server.registerTool('__no_tools_granted__', { description: 'placeholder' }, async () => ({ content: [] }));
    placeholder.remove();
  }

  return server;
}

/** The `tools/call` messages in a JSON-RPC POST body (single or batch). */
function toolCallsIn(body: unknown): Array<{ name: string; args: unknown }> {
  const messages = Array.isArray(body) ? body : [body];
  const calls: Array<{ name: string; args: unknown }> = [];
  for (const message of messages) {
    const m = message as { method?: unknown; params?: { name?: unknown; arguments?: unknown } } | null;
    if (m && m.method === 'tools/call' && typeof m.params?.name === 'string') {
      calls.push({ name: m.params.name, args: m.params.arguments });
    }
  }
  return calls;
}

/** The calls in `calls` that did not reach a handler: each handler run accounts for one call of that name. */
function refusedCalls(calls: Array<{ name: string; args: unknown }>, reached: Map<string, number>): Array<{ name: string; args: unknown }> {
  const left = new Map(reached);
  const refused: Array<{ name: string; args: unknown }> = [];
  for (const call of calls) {
    const n = left.get(call.name) ?? 0;
    if (n > 0) left.set(call.name, n - 1);
    else refused.push(call);
  }
  return refused;
}

/**
 * The MCP SDK validates tool arguments against the registered schema before
 * our handler runs, and rejects calls to tools that are not granted before any
 * handler exists. Those calls never reach `callTool`, so record them here:
 * every agent tool call is audited, including the ones refused up front.
 *
 * This path is reachable without any credential (a request with a bad token
 * is audited here before its 401), so it is deliberately cheap and bounded: a
 * request collapses to at most one noise row per decision (carrying a
 * `count`), written in one transaction. The row's tool label is a catalog name
 * only when every call in the group named that one tool; otherwise a fixed
 * label, so invented names cannot mint rows. Without a live token the
 * principal is one constant.
 */
function auditRefusedCalls(db: Database, resolved: ResolvedClientToken | null, calls: Array<{ name: string; args: unknown }>): void {
  const principal: Principal = resolved ? { kind: 'client_token', id: resolved.id } : ANONYMOUS_PRINCIPAL;

  interface Group { count: number; names: Set<string>; firstArgs: unknown }
  const groups = new Map<'invalid_args' | 'denied_grant', Group>();
  for (const call of calls) {
    const def = getToolDef(call.name);
    const granted = !!def && !!resolved?.grantByTool.has(def.name);
    const decision = granted ? 'invalid_args' : 'denied_grant';
    const group = groups.get(decision) ?? { count: 0, names: new Set<string>(), firstArgs: call.args };
    group.count++;
    group.names.add(def ? def.name : UNKNOWN_TOOL_LABEL);
    groups.set(decision, group);
  }

  try {
    db.transaction(() => {
      for (const [decision, group] of groups) {
        const onlyName = group.names.size === 1 ? [...group.names][0] : '<multiple>';
        const def = getToolDef(onlyName);
        appendAudit(db, {
          transport: 'http-mcp',
          principalKind: principal.kind,
          principalId: principal.id,
          userId: resolved?.scope.userId ?? null,
          role: resolved?.scope.role ?? 'viewer',
          origin: HTTP_MCP_ORIGIN,
          toolName: onlyName,
          classification: def ? def.classification : 'unknown',
          decision,
          argsPreview: group.count === 1 ? previewArgs(group.firstArgs) : `${group.count} refused calls in one request`,
          errorCode: decision === 'invalid_args' ? 'invalid_args' : 'grant_invalid',
          count: group.count,
        });
      }
    })();
  } catch (err) {
    console.error('[mcp-audit] failed to write refused-call row:', err);
  }
}

/** A POST body larger than this is refused outright (413); no MCP client sends a tool call this large. */
const MAX_BODY_BYTES = 4 * 1_048_576;
/**
 * The request body as text, or null once more than `max` bytes have arrived (the rest is not read) or,
 * when `timeoutMs` is given, once the whole body has not arrived by then.
 * Counts bytes while streaming, so a body with no Content-Length cannot slip past the cap.
 */
async function readBodyCapped(req: Request, max: number, timeoutMs?: number): Promise<string | null> {
  if (!req.body) return '';
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  const deadline = timeoutMs === undefined ? Infinity : Date.now() + timeoutMs;
  let total = 0;
  for (;;) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const next = reader.read();
    const result =
      timeoutMs === undefined
        ? await next
        : await Promise.race([
            next,
            new Promise<'timeout'>((resolve) => {
              timer = setTimeout(() => resolve('timeout'), Math.max(0, deadline - Date.now()));
            }),
          ]);
    if (timer) clearTimeout(timer);
    if (result === 'timeout') {
      reader.cancel().catch(() => {}); // not awaited: a stalled socket may never settle it
      return null;
    }
    const { done, value } = result;
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/** A request with no valid token reads at most this much body (only to audit tool names), for at most the timeout. */
const UNAUTH_MAX_BODY_BYTES = 64 * 1024;
const UNAUTH_BODY_TIMEOUT_MS = 2_000;
/** Idle seconds an unauthenticated `/mcp` connection is kept; a real client with a token gets the server's long default. */
const UNAUTH_IDLE_TIMEOUT_S = 10;

const SETTINGS_PATH = 'Settings → Agent access → External MCP clients';

function extractBearerToken(req: Request): string | null {
  const header = req.headers.get('Authorization');
  return header?.startsWith('Bearer ') ? header.slice(7) : null;
}

/** Why a bearer did not resolve, in words that tell the client what to do. */
function unauthorizedMessage(bearer: string | null): string {
  if (!bearer) return `Missing client token. Mint one in ${SETTINGS_PATH} and send it as "Authorization: Bearer ${CLIENT_TOKEN_PREFIX}…".`;
  if (!bearer.startsWith(CLIENT_TOKEN_PREFIX)) {
    return `Wilson no longer accepts the tab session id as an MCP token. Mint a client token in ${SETTINGS_PATH}.`;
  }
  return `This client token is not valid: it was revoked, has expired, belongs to a user who is no longer active, or is from another profile. Mint a new one in ${SETTINGS_PATH}.`;
}

function unauthorized(message: string): Response {
  return Response.json(
    { jsonrpc: '2.0', error: { code: -32001, message }, id: null },
    { status: 401, headers: { 'WWW-Authenticate': 'Bearer realm="wilson-mcp"' } }
  );
}

/**
 * Handle one HTTP request against the `/mcp` endpoint. Stateless: builds a
 * fresh server + transport, connects, delegates to the transport, then lets
 * both get garbage collected once the response is sent.
 *
 * The bearer is resolved first (a sha256 lookup, the same cost whether the
 * token exists or not). A request without a live token is a 401 and never
 * reaches the SDK; only those failures spend from the per-address bucket
 * (10 per 60 s, keyed on the peer address the server saw, never a header), and
 * once it is empty that address gets a 429 before any body is read. Even under
 * the bucket, such a request reads at most 64 KB for 2 s (to audit tool names)
 * and holds its connection 10 s. A request carrying a valid token is never
 * limited by that bucket, so someone else on the same address cannot lock a
 * real client out; its own refused calls spend from a per-token bucket instead.
 *
 * `profile` is the active profile's name: a token's grants are bound to it.
 */
export async function handleMcpHttpRequest(
  db: Database,
  req: Request,
  remote: string | undefined,
  profile: string,
  opts: { setIdleTimeout?: (seconds: number) => void } = {}
): Promise<Response> {
  const limiter = limiterFor(db);
  const bearer = extractBearerToken(req);
  const resolved = resolveClientToken(db, bearer, profile);

  if (!resolved) {
    // Do not let a client with no credential hold the 255 s connection the server grants approval waits.
    opts.setIdleTimeout?.(UNAUTH_IDLE_TIMEOUT_S);
    const failed = limiter.take(`mcpb:${remote ?? 'unknown'}`, LIMIT_MCP_FAILED_BEARER);
    if (!failed.ok) {
      return Response.json(
        { jsonrpc: '2.0', error: { code: -32000, message: 'Too many requests with an invalid token — wait a minute.' }, id: null },
        { status: 429, headers: { 'Retry-After': '60' } }
      );
    }
    // The 401 does not depend on the body. It is read only so a refused tool call can still be audited by name:
    // never more than 64 KB, never longer than 2 s, and not at all when Content-Length already says it is bigger.
    // A body that cannot be read in those bounds gets one fixed-label noise row.
    let calls: Array<{ name: string; args: unknown }> = [];
    if (req.method === 'POST' && (req.headers.get('Content-Type') ?? '').toLowerCase().includes('application/json')) {
      const declared = Number(req.headers.get('Content-Length') ?? 0);
      const text = declared > UNAUTH_MAX_BODY_BYTES ? null : await readBodyCapped(req, UNAUTH_MAX_BODY_BYTES, UNAUTH_BODY_TIMEOUT_MS);
      if (text === null) {
        calls = [{ name: UNKNOWN_TOOL_LABEL, args: undefined }];
      } else {
        try {
          calls = toolCallsIn(JSON.parse(text));
        } catch {
          // Not JSON: nothing to audit.
        }
      }
    }
    // The arguments of an unauthenticated call are never previewed (nothing to attribute them to, and no reason to spend CPU on them).
    if (calls.length > 0) auditRefusedCalls(db, null, calls.map((c) => ({ name: c.name, args: undefined })));
    return unauthorized(unauthorizedMessage(bearer));
  }

  // A valid token's own refusals (bad arguments, tools it does not hold) have their own bucket, keyed by the
  // token, so a flood of them is bounded without touching any other client on the same address.
  const refusedKey = `mcpr:${createHash('sha256').update(bearer as string).digest('hex')}`;
  if (limiter.blocked(refusedKey, LIMIT_MCP_REFUSED_CALLS)) {
    return Response.json(
      { jsonrpc: '2.0', error: { code: -32000, message: 'Too many refused tool calls from this token — wait a minute.' }, id: null },
      { status: 429, headers: { 'Retry-After': '60' } }
    );
  }

  // Bounded body, whatever the framing. Content-Length is only a hint (a chunked body has none), so the
  // bytes are counted as they arrive and the read stops at the cap.
  const tooLarge = () =>
    Response.json({ jsonrpc: '2.0', error: { code: -32000, message: 'Request body too large' }, id: null }, { status: 413 });

  let calls: Array<{ name: string; args: unknown }> = [];
  let parsedBody: unknown;
  let bufferedBody: string | null = null;
  if (req.method === 'POST') {
    const cap = MAX_BODY_BYTES;
    if (Number(req.headers.get('Content-Length') ?? 0) > cap) return tooLarge();
    const contentType = req.headers.get('Content-Type') ?? '';
    // Only an `application/json` body is a JSON-RPC message; a no-cors text/plain POST is not read at all.
    if (contentType.toLowerCase().includes('application/json')) {
      bufferedBody = await readBodyCapped(req, cap);
      if (bufferedBody === null) return tooLarge();
      try {
        parsedBody = JSON.parse(bufferedBody);
        calls = toolCallsIn(parsedBody);
      } catch {
        // Not JSON: the transport will answer with its own protocol error.
      }
    }
  }

  const state: CallState = { reached: new Map() };
  const server = buildServerForRequest(db, resolved, state);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless: no cross-request session state to manage
    enableJsonResponse: true,
  });
  await server.connect(transport);
  // The body was consumed above; hand the transport what we already parsed (or a fresh Request over the same text).
  const forTransport = bufferedBody === null || parsedBody !== undefined
    ? req
    : new Request(req.url, { method: req.method, headers: req.headers, body: bufferedBody });
  const response = await transport.handleRequest(forTransport, parsedBody !== undefined ? { parsedBody } : undefined);
  const refused = refusedCalls(calls, state.reached);
  if (refused.length > 0) {
    auditRefusedCalls(db, resolved, refused);
    for (let i = 0; i < refused.length; i++) limiter.take(refusedKey, LIMIT_MCP_REFUSED_CALLS);
  }
  return response;
}
