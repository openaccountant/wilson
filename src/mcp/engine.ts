/**
 * Orchestrates grants + the prepare/commit protocol on top of src/mcp/store.ts
 * and src/mcp/tool-catalog.ts. This is the single code path both transports
 * (in-page WebMCP registration and the Streamable-HTTP /mcp fallback) call
 * into — see the module docstring in tool-catalog.ts for why that matters.
 *
 * `callTool` is the one function that authorizes an agent tool call:
 *
 *   kill switch (process-global: agent-access.json)
 *     -> tool exists and is offered on this transport
 *     -> parseToolArgs (zod strict + string hygiene)
 *     -> validateGrant (also dead if created before the kill switch's epoch)
 *     -> role (the tool's minRole against the live role)
 *     -> policy (the user's Off / Ask / Allow for this tool)
 *     -> rate limits (per principal and per user) + daily read budget
 *     -> dispatch by the CATALOG's classification and the policy:
 *          read, allow -> executeRead(db, ...) -> capped, sanitized envelope
 *          read, ask   -> pending `kind='read'` operation (runs only when approved)
 *          page        -> authorized and audited here; the page does the work (ask: a card first).
 *                         A page tool with `pageData` also reads one row for the page, like a read
 *          mutating    -> prepareMutation -> pending operation (never a write)
 *     -> finally: one audit row
 *
 * Clients never classify a call, and nothing here branches on the
 * client-reported `transport` for authorization.
 */
import type { Database } from '../db/compat-sqlite.js';
import {
  createGrants,
  getGrant,
  listGrantsForSession,
  revokeGrant,
  revokeGrantsForSession,
  recentGrantSessions,
  validateGrant,
  createOperation,
  getOperation,
  listPendingOperations,
  markOperationStatus,
  issueApprovalToken,
  consumeApprovalToken,
  expireStaleOperations,
  isDashboardAuthEnabled,
  grantOwnerAllowed,
  isOperationExpired,
  pendingCountForPrincipal,
  pendingCountForUser,
  clearReadOutcome,
  readDeliveryRefusal,
  dbTimeMs,
  revokeAllGrants,
  rejectPendingAgentOperations,
  type GrantOwner,
  type McpGrant,
  type McpOperation,
  type Role,
} from './store.js';
import {
  MCP_TOOL_CATALOG,
  getToolDef,
  jsonSchemaFor,
  schemaDigest,
  classify,
  parseToolArgs,
  executeRead,
  executeReadSync,
  readEstimate,
  tabOpenHint,
  prepareMutation,
  prepareProposal,
  commitMutation,
  toolAnnotations,
  isWriteTool,
  NotFoundError,
  PrepareError,
  RubricChangedError,
  type McpToolDef,
  type ToolTransport,
} from './tool-catalog.js';
import { appendAudit, previewArgs, principalFor, userPrincipal, type AuditDecision, type Principal } from './audit.js';
import { isAuthEnabled } from '../dashboard/auth.js';
import type { TabId } from '../dashboard/webmcp-session.js';
import { retiredNameHint } from './tool-names.js';
import { CursorError, DEFAULT_OUTPUT_CAP, argsHash, sanitizeUntrustedText } from './output.js';
import { sanitizeStoredOutcomeForAgent } from './operation-view.js';
import { getEffectivePolicy } from './policies.js';
import { getGrantTtlMinutes, getJudgeDailyLimit } from './agent-settings.js';
import { insertProposals, judgeRowsToday, type InsertProposalsResult } from '../training/annotations.js';
import { KILL_SWITCH_MESSAGE, getKillSwitchEpoch, isAgentAccessEnabled, setGlobalAgentState } from './global-state.js';
import {
  limiterFor,
  userKeyOf,
  LIMIT_GRANTS_POST,
  LIMIT_PRINCIPAL_ALL,
  LIMIT_PRINCIPAL_PREPARES,
  LIMIT_PRINCIPAL_TOOL,
  LIMIT_USER_JUDGE_CALLS,
  LIMIT_USER_PREPARES,
  LIMIT_USER_READS,
  MAX_NEW_SESSIONS_PER_HOUR,
  MAX_PENDING_PER_PRINCIPAL,
  MAX_PENDING_PER_USER,
  type RateLimiter,
} from './rate-limit.js';

export interface RequestScope {
  role: Role;
  userId: number | null;
  profile: string;
  origin: string;
  /** Client-supplied for tabs; never trusted to say who the caller is (the audit principal is hashed from it). */
  sessionGeneration: string;
  /**
   * The client token behind the call. Set ONLY by `/mcp` after `resolveClientToken` found a live
   * token; nothing a client sends can set it. It makes the audit principal `client_token:<id>`.
   */
  tokenId?: string;
}

export { KILL_SWITCH_MESSAGE };

/** Label for every tool name that is not in the catalog, so a client cannot mint audit rows by inventing names. */
export const UNKNOWN_TOOL_LABEL = '<unknown>';

export type ErrorCode =
  | 'invalid_args'
  | 'unknown_tool'
  | 'not_found'
  | 'grant_invalid'
  | 'role_forbidden'
  | 'rate_limited'
  | 'read_budget_exceeded'
  | 'expired'
  | 'origin_required'
  | 'lan_auth_required'
  | 'policy_off'
  | 'kill_switch'
  | 'approval_too_fast'
  | 'rubric_changed'
  | 'internal';

export interface EngineError {
  ok: false;
  status: number;
  code: ErrorCode;
  /** Actionable message. Routes return it as `error.message`. */
  error: string;
  hint?: string;
  /** Seconds, for `Retry-After` on 429. */
  retryAfterSec?: number;
  /** Extra machine-readable fields for `error` in the REST body (today: `currentRubricVersion` on `rubric_changed`). */
  data?: Record<string, string>;
}

function fail(status: number, code: ErrorCode, error: string, extra: { hint?: string; retryAfterSec?: number; data?: Record<string, string> } = {}): EngineError {
  return { ok: false, status, code, error, ...extra };
}

/**
 * Ownership is decided when a grant or operation is written, not when the
 * request started: if auth was turned on while this request was in flight,
 * a scope derived without a login (user_id null) is refused.
 */
function ownerlessWhileAuthOn(db: Database, scope: RequestScope): EngineError | null {
  if (scope.userId === null && isDashboardAuthEnabled(db)) {
    return fail(401, 'grant_invalid', 'Unauthorized: dashboard auth is on; log in and try again');
  }
  return null;
}

function grantScopeParams(scope: RequestScope) {
  return {
    userId: scope.userId,
    role: scope.role,
    profile: scope.profile,
    origin: scope.origin,
    sessionGeneration: scope.sessionGeneration,
  };
}

function ownerOf(scope: RequestScope): GrantOwner {
  return { userId: scope.userId, profile: scope.profile, origin: scope.origin };
}

/** Static catalog metadata for the dashboard's grant picker UI — not the same as what's exposed to an agent. */
export function listCatalog(): Array<{
  name: string;
  description: string;
  classification: string;
  minRole: string;
  transports: readonly ToolTransport[];
  exposure: string;
  inputSchema: unknown;
  annotations: ReturnType<typeof toolAnnotations>;
}> {
  return MCP_TOOL_CATALOG.map((def) => ({
    name: def.name,
    description: def.description,
    classification: def.classification,
    minRole: def.minRole,
    transports: def.transports,
    exposure: def.exposure,
    inputSchema: jsonSchemaFor(def.name),
    annotations: toolAnnotations(def.name),
  }));
}

// ── Grant management ─────────────────────────────────────────────────────────

export function grantLocalAccess(
  db: Database,
  scope: RequestScope,
  toolNames: string[]
): { ok: true; grants: McpGrant[] } | EngineError {
  if (!isAgentAccessEnabled()) return fail(403, 'kill_switch', KILL_SWITCH_MESSAGE);
  const unauthenticated = ownerlessWhileAuthOn(db, scope);
  if (unauthenticated) return unauthenticated;
  const unknown = toolNames.filter((name) => !getToolDef(name));
  if (unknown.length > 0) {
    return fail(unknown.some((n) => retiredNameHint(n)) ? 404 : 400, 'unknown_tool', `Unknown tool(s): ${unknown.map((n) => unknownToolLabel(n)).join(', ')}`);
  }
  // A tab can only use what its transport offers; `get_operation_result`, for one, belongs to /mcp tokens.
  const notForTabs = toolNames.filter((name) => !getToolDef(name)!.transports.includes('webmcp'));
  if (notForTabs.length > 0) {
    return fail(400, 'invalid_args', `${notForTabs[0]} is not available in the dashboard tab. External clients get it with a client token.`);
  }
  // Viewers may grant themselves read-only access, but never a mutating tool or a judge proposal tool —
  // mirrors the existing canWrite() RBAC gate on the plain REST routes.
  if (scope.role !== 'admin') {
    const mutating = toolNames.filter((name) => isWriteTool(getToolDef(name)!));
    if (mutating.length > 0) {
      return fail(403, 'role_forbidden', `Viewer role cannot grant mutating tool(s): ${mutating.join(', ')}`);
    }
  }

  // A tool the user turned Off cannot be granted: Off means not grantable and not registered.
  const turnedOff = [...new Set(toolNames)].filter((name) => getEffectivePolicy(db, scope.userId, name) === 'off');
  if (turnedOff.length > 0) {
    return fail(400, 'policy_off', `${turnedOff.map((n) => `"${n}"`).join(', ')} ${turnedOff.length === 1 ? 'is' : 'are'} turned off in your policies. Set ${turnedOff.length === 1 ? 'it' : 'them'} to Ask or Allow in Settings → Agent access first.`);
  }

  // The client picks its own session id, so cap how many distinct ones a user
  // can bring into use per hour: otherwise rotating it would mint fresh
  // per-principal rate-limit buckets without limit.
  const recent = recentGrantSessions(db, scope.userId, scope.sessionGeneration);
  if (!recent.includesThis && recent.distinct >= MAX_NEW_SESSIONS_PER_HOUR) {
    return fail(429, 'rate_limited', `Too many new agent sessions this hour (limit ${MAX_NEW_SESSIONS_PER_HOUR}). Reuse this tab's session or wait.`, { retryAfterSec: 3600 });
  }

  const grants = createGrants(db, {
    ...grantScopeParams(scope),
    tools: [...new Set(toolNames)].map((name) => ({ name, schemaDigest: schemaDigest(name) })),
    // Per profile (15 min, 1 h, 4 h or 12 h). Only new grants: existing ones keep the expiry they were made with.
    ttlMs: getGrantTtlMinutes() * 60_000,
  });
  return { ok: true, grants };
}

/**
 * `anyOwner`: the caller is an admin with auth on, who may act on every user's grants (owner-or-admin, #156).
 * Everyone else is filtered to their own user, profile and origin.
 */
interface GrantOwnerOptions {
  anyOwner?: boolean;
}

function ownerFilter(scope: RequestScope, opts: GrantOwnerOptions): GrantOwner | undefined {
  return opts.anyOwner ? undefined : ownerOf(scope);
}

/** Grants for one session, filtered to the caller's own user, profile and origin (any owner for an admin). */
export function listActiveGrants(db: Database, scope: RequestScope, opts: GrantOwnerOptions = {}): McpGrant[] {
  return listGrantsForSession(db, scope.sessionGeneration, ownerFilter(scope, opts));
}

/** Revoke one grant the caller owns. Returns false when it does not exist or belongs to someone else (the route answers 404 for both). */
export function revokeLocalGrant(db: Database, scope: RequestScope, grantId: string, opts: GrantOwnerOptions = {}): boolean {
  return revokeGrant(db, grantId, ownerFilter(scope, opts)) > 0;
}

export function revokeAllForSession(db: Database, scope: RequestScope, opts: GrantOwnerOptions = {}): number {
  return revokeGrantsForSession(db, scope.sessionGeneration, ownerFilter(scope, opts));
}

/** Per-user cap on grant creation (`POST /api/mcp/grants`). */
export function checkGrantCreationRate(db: Database, scope: RequestScope): EngineError | null {
  const decision = limiterFor(db).take(`grants:${userKeyOf(scope.userId)}`, LIMIT_GRANTS_POST);
  return decision.ok ? null : fail(429, 'rate_limited', 'Too many grant requests — wait a moment.', { retryAfterSec: decision.retryAfterSec });
}

export interface ExposedTool {
  name: string;
  description: string;
  inputSchema: unknown;
  annotations: ReturnType<typeof toolAnnotations>;
  classification: string;
  /** `imperative`: the bridge registers it. `declarative`: only the page's form exposes it. */
  exposure: 'imperative' | 'declarative';
  /** The form is auto-submitted by the browser once the agent filled it (read and page forms only). */
  autosubmit: boolean;
  /**
   * The user's effective policy (Off tools are never listed). A form holds an agent's values back until the server
   * authorizes the call when this is `ask`.
   */
  policy: 'allow' | 'ask';
  /** `global`, or the one tab the tool belongs to: the bridge registers a tab's tools only while it shows. */
  surface: 'global' | { tab: TabId };
  /** For a tab tool: what to tell an agent that calls it while the tab is not showing. */
  openHint?: string;
  grantId: string;
}

/** What the WebMCP bridge / HTTP-MCP client should actually register — empty until grants exist. */
export function exposedTools(db: Database, scope: RequestScope, transport: ToolTransport = 'webmcp'): ExposedTool[] {
  if (!isAgentAccessEnabled()) return [];
  const grants = listGrantsForSession(db, scope.sessionGeneration).filter(
    (g) =>
      g.profile === scope.profile &&
      g.origin === scope.origin &&
      g.role === scope.role &&
      g.user_id === scope.userId &&
      grantOwnerAllowed(db, g)
  );
  const out: ExposedTool[] = [];
  for (const grant of grants) {
    const def = getToolDef(grant.tool_name);
    if (!def || !def.transports.includes(transport)) continue;
    if (grant.schema_digest !== schemaDigest(def.name)) continue; // stale grant: not callable, so not offered
    const policy = getEffectivePolicy(db, scope.userId, def.name);
    if (policy === 'off') continue; // Off: not registered, whatever grant is left
    out.push({
      name: def.name,
      description: def.description,
      inputSchema: jsonSchemaFor(def.name),
      annotations: toolAnnotations(def.name),
      classification: def.classification,
      exposure: def.exposure,
      autosubmit: def.autosubmit === true,
      policy,
      surface: def.surface,
      ...(def.surface === 'global' ? {} : { openHint: tabOpenHint(def.surface.tab) }),
      grantId: grant.id,
    });
  }
  return out;
}

// ── The single call path ─────────────────────────────────────────────────────

/** Client-reported for `/api/mcp/call`; `http-mcp` is derived by the server for `/mcp`. Never used for authorization. */
export type CallTransport = 'imperative' | 'declarative' | 'page' | 'http-mcp';

export type CallResult =
  | { ok: true; kind: 'read'; data: unknown }
  | { ok: true; kind: 'operation'; operation: McpOperation }
  /** A page tool: authorized and audited. The page does the work and answers the agent itself. */
  | { ok: true; kind: 'page'; pageData?: unknown }
  | EngineError;

export interface CallContext {
  /** Defaults to the database's own limiter. */
  limiter?: RateLimiter;
}

interface AuditNote {
  decision: AuditDecision;
  errorCode?: string;
  resultChars?: number;
  pageIndex?: number;
  operationId?: string;
  detail?: string;
}

function toolTransportFor(transport: CallTransport): ToolTransport {
  return transport === 'http-mcp' ? 'http-mcp' : 'webmcp';
}

/**
 * Authorize and run one agent tool call. See the file header for the order of
 * checks. Always writes exactly one audit row (noise decisions fold into a
 * per-minute aggregate).
 */
export async function callTool(
  db: Database,
  scope: RequestScope,
  grantId: string | null,
  toolName: string,
  args: unknown,
  transport: CallTransport,
  ctx: CallContext = {}
): Promise<CallResult> {
  const started = Date.now();
  const tabPrincipal: Principal = scope.tokenId ? { kind: 'client_token', id: scope.tokenId } : principalFor(scope.sessionGeneration);
  // Until the grant has been validated the claimed session means nothing, so
  // refusals before that point are keyed by the server-derived user instead.
  // Otherwise rotating the session id would open a fresh noise row per rotation.
  let principal: Principal = userPrincipal(scope.userId);
  const def = getToolDef(toolName);
  const note: AuditNote = { decision: 'error' };
  let previewSource: unknown = args;

  try {
    return await run();
  } catch (err) {
    // Anything unexpected becomes a generic 500; the detail goes to the audit log only.
    note.decision = 'error';
    note.errorCode = 'internal';
    note.detail = err instanceof Error ? err.message.slice(0, 120) : 'unknown error';
    return fail(500, 'internal', 'Internal error');
  } finally {
    writeCallAudit();
  }

  function writeCallAudit(): void {
    try {
      appendAudit(db, {
        transport,
        principalKind: principal.kind,
        principalId: principal.id,
        userId: scope.userId,
        role: scope.role,
        origin: scope.origin,
        toolName: def ? def.name : UNKNOWN_TOOL_LABEL,
        classification: def ? def.classification : 'unknown',
        decision: note.decision,
        operationId: note.operationId ?? null,
        grantId,
        argsPreview: note.detail ? `${previewArgs(previewSource)} | ${sanitizeUntrustedText(note.detail, 120)}`.slice(0, 512) : previewArgs(previewSource),
        resultChars: note.resultChars ?? null,
        pageIndex: note.pageIndex ?? null,
        durationMs: Date.now() - started,
        errorCode: note.errorCode ?? null,
      });
    } catch (err) {
      // An audit failure must not turn a decided call into a crash, but it must not be silent either.
      console.error('[mcp-audit] failed to write audit row:', err);
    }
  }

  function deny(decision: AuditDecision, error: EngineError): EngineError {
    note.decision = decision;
    note.errorCode = error.code;
    return error;
  }

  async function run(): Promise<CallResult> {
    // Process-global and read from agent-access.json, never from a profile setting: it holds with no active profile.
    if (!isAgentAccessEnabled()) return deny('denied_kill_switch', fail(403, 'kill_switch', KILL_SWITCH_MESSAGE));

    if (!def || !def.transports.includes(toolTransportFor(transport))) {
      return deny('invalid_args', fail(404, 'unknown_tool', `Unknown tool "${sanitizeUntrustedText(toolName, 30)}"${retiredHintSuffix(toolName)}`));
    }

    const parsed = parseToolArgs(toolName, args);
    if (!parsed.ok) return deny('invalid_args', fail(400, 'invalid_args', parsed.message));
    const callArgs = parsed.args;
    previewSource = callArgs;

    if (!grantId) return deny('denied_grant', fail(403, 'grant_invalid', 'Grant invalid: no grant provided'));
    const validation = validateGrant(db, grantId, toolName, schemaDigest(toolName), grantScopeParams(scope));
    if (!validation.ok) {
      return deny('denied_grant', fail(403, 'grant_invalid', `Grant invalid: ${validation.reason}`));
    }
    principal = tabPrincipal; // the grant is valid for this session: from here on the call is attributable to the tab or token
    // Ownership is decided now, not when the request started: auth may have come on while it was in flight, and
    // nothing (an operation, a read-ask) may then be minted for a scope with no owner.
    const unauthenticated = ownerlessWhileAuthOn(db, scope);
    if (unauthenticated) return deny('denied_grant', unauthenticated);

    // An external client can only propose changes when a dashboard login exists to approve them: with
    // auth off it could approve its own card with `curl`. Tokens cannot be minted that way, and one
    // minted before auth was turned off stops carrying its write tools.
    if (transport === 'http-mcp' && isWriteTool(def) && !isAuthEnabled(db)) {
      return deny('denied_grant', fail(403, 'grant_invalid', 'Grant invalid: external clients can only read while dashboard auth is off'));
    }

    if (def.minRole === 'admin' && scope.role !== 'admin') {
      return deny('denied_role', fail(403, 'role_forbidden', `${def.name} requires the admin role`));
    }

    // The grant row only proves what was true when it was minted. Re-read the
    // live account so a deactivated or demoted user (or a no-owner grant left
    // over from before auth was enabled) stops working at once, on every transport.
    const live = liveCallerCheck(db, scope.userId, def.minRole);
    if (live) {
      return deny(live.code === 'role_forbidden' ? 'denied_role' : 'denied_grant', live);
    }

    const policy = getEffectivePolicy(db, scope.userId, def.name);
    if (policy === 'off') {
      return deny('denied_policy', fail(403, 'policy_off', `${def.name} is turned off in the user's policies. Ask the user to set it to Ask or Allow in Settings → Agent access.`));
    }

    const limiter = ctx.limiter ?? limiterFor(db);
    const userKey = userKeyOf(scope.userId);
    const limited = (bucket: { ok: boolean; retryAfterSec?: number }, message: string): EngineError | null =>
      bucket.ok ? null : fail(429, 'rate_limited', message, { retryAfterSec: bucket.retryAfterSec });

    const allCalls = limited(limiter.take(`p:${principal.id}`, LIMIT_PRINCIPAL_ALL), 'Too many tool calls from this session — slow down.');
    if (allCalls) return deny('rate_limited', allCalls);

    if (def.classification === 'proposal') {
      // The judge's write path. Nothing here can touch a human annotation or any financial data: the only thing it
      // ever produces is an inert `proposed` row. Allow inserts it now; Ask parks it behind a card first.
      const judgeLimit = limited(limiter.take(`judge:${userKey}`, LIMIT_USER_JUDGE_CALLS), 'Too many judgement calls in the last minute (limit 6) — wait before retrying.');
      if (judgeLimit) return deny('rate_limited', judgeLimit);

      let prepared;
      try {
        prepared = prepareProposal(db, toolName, callArgs);
      } catch (err) {
        if (err instanceof RubricChangedError) {
          return deny('invalid_args', fail(409, 'rubric_changed', err.message, {
            hint: 'Call get_judge_rubric and judge by the version it returns.',
            ...(err.currentVersion ? { data: { currentRubricVersion: err.currentVersion } } : {}),
          }));
        }
        if (err instanceof NotFoundError) {
          note.decision = 'error';
          note.errorCode = 'not_found';
          return fail(404, 'not_found', err.message);
        }
        if (err instanceof PrepareError) return deny('invalid_args', fail(400, 'invalid_args', `${def.name}: ${err.message}`));
        note.detail = err instanceof Error ? err.message.slice(0, 120) : 'unknown error';
        return deny('error', fail(500, 'internal', 'Internal error'));
      }

      const dailyLimit = getJudgeDailyLimit();
      const used = judgeRowsToday(db);
      if (used + prepared.items.length > dailyLimit) {
        return deny('rate_limited', fail(429, 'rate_limited', judgeLimitMessage(dailyLimit), { retryAfterSec: secondsToUtcMidnight() }));
      }

      if (policy === 'ask') {
        if (pendingCountForPrincipal(db, scope.sessionGeneration) >= MAX_PENDING_PER_PRINCIPAL ||
            pendingCountForUser(db, scope.userId) >= MAX_PENDING_PER_USER) {
          return deny('rate_limited', fail(429, 'rate_limited', 'Too many pending approvals — resolve or wait', { retryAfterSec: 30 }));
        }
        const operation = createOperation(db, {
          source: transport === 'http-mcp' ? 'http-mcp' : 'webmcp',
          grantId,
          toolName,
          // What commit inserts, normalized: the same items, the declared model, the rubric the call cited.
          args: { judgeModel: prepared.judgeModel, rubricVersion: prepared.rubricVersion, items: prepared.items },
          before: null,
          after: prepared.after,
          summary: prepared.summary,
          kind: 'proposal',
          transactionId: null,
          revisionAtPrepare: null,
          profile: scope.profile,
          origin: scope.origin,
          sessionGeneration: scope.sessionGeneration,
          userId: scope.userId,
          role: scope.role,
        });
        note.decision = 'operation_created';
        note.operationId = operation.id;
        return { ok: true, kind: 'operation', operation };
      }

      const inserted = insertProposals(db, {
        principalId: principal.id,
        createdVia: proposalCreatedVia(def, transport === 'http-mcp' ? 'http-mcp' : 'webmcp'),
        judgeModel: prepared.judgeModel,
        rubricVersion: prepared.rubricVersion,
        items: prepared.items,
        dailyLimit,
      });
      if (!inserted.ok) return deny('rate_limited', fail(429, 'rate_limited', judgeLimitMessage(inserted.limit), { retryAfterSec: secondsToUtcMidnight() }));
      const data = proposalAnswer(def, inserted);
      note.decision = 'allowed';
      note.resultChars = JSON.stringify(data).length;
      return { ok: true, kind: 'read', data };
    }

    if ((def.classification === 'read' || def.classification === 'page') && policy === 'ask') {
      // Ask every time: park the read (or page call) as an operation. It runs only when a human approves.
      const askLimit = limited(limiter.take(`pt:${principal.id}:${def.name}`, LIMIT_PRINCIPAL_TOOL), `Too many ${def.name} calls in the last minute — wait before retrying.`);
      if (askLimit) return deny('rate_limited', askLimit);
      if (pendingCountForPrincipal(db, scope.sessionGeneration) >= MAX_PENDING_PER_PRINCIPAL ||
          pendingCountForUser(db, scope.userId) >= MAX_PENDING_PER_USER) {
        return deny('rate_limited', fail(429, 'rate_limited', 'Too many pending approvals — resolve or wait', { retryAfterSec: 30 }));
      }
      const operation = createOperation(db, {
        source: transport === 'http-mcp' ? 'http-mcp' : 'webmcp',
        grantId,
        toolName,
        args: callArgs,
        before: null,
        after: null,
        summary: null,
        kind: 'read',
        transactionId: null,
        revisionAtPrepare: null,
        profile: scope.profile,
        origin: scope.origin,
        sessionGeneration: scope.sessionGeneration,
        userId: scope.userId,
        role: scope.role,
      });
      note.decision = 'operation_created';
      note.operationId = operation.id;
      return { ok: true, kind: 'operation', operation };
    }

    if (def.classification === 'page' && !def.pageData) {
      // Nothing to run on the server and nothing to return: the grant, role, policy and limits above are the
      // authorization, and the audit row says the page was allowed to act.
      const tooMany = limited(limiter.take(`pt:${principal.id}:${def.name}`, LIMIT_PRINCIPAL_TOOL), `Too many ${def.name} calls in the last minute — wait before retrying.`);
      if (tooMany) return deny('rate_limited', tooMany);
      note.decision = 'allowed';
      return { ok: true, kind: 'page' };
    }

    // A page tool with `pageData` reads one row for the page: it is user data leaving the server, so it takes the
    // same user-wide limits and daily budget as a read, and its output is capped and sanitized the same way.
    const isPageRead = def.classification === 'page';
    if (def.classification === 'read' || isPageRead) {
      const tooMany =
        limited(limiter.take(`pt:${principal.id}:${def.name}`, LIMIT_PRINCIPAL_TOOL), `Too many ${def.name} calls in the last minute — wait before retrying.`) ??
        limited(limiter.take(`ur:${userKey}`, LIMIT_USER_READS), 'Too many reads for this user in the last minute — wait before retrying.');
      if (tooMany) return deny('rate_limited', tooMany);

      // Reserve before the await and true up after it, so concurrent reads cannot all pass one stale check.
      const reservation = limiter.reserveRead(userKey, readEstimate(def, callArgs));
      if (!reservation.ok) {
        return deny('rate_limited', fail(429, 'read_budget_exceeded', "Today's read budget is used up. It resets at 00:00 UTC.", { retryAfterSec: reservation.retryAfterSec }));
      }

      let data: unknown;
      try {
        data = isPageRead
          ? def.pageData!(db, callArgs)
          : def.name === 'get_operation_result'
            ? readOperationResult(db, scope, callArgs)
            : await executeRead(db, toolName, callArgs, { principalId: principal.id });
      } catch (err) {
        reservation.settle();
        if (err instanceof NotFoundError) {
          note.decision = 'error';
          note.errorCode = 'not_found';
          return fail(404, 'not_found', err.message);
        }
        if (err instanceof CursorError || err instanceof PrepareError) return deny('invalid_args', fail(400, 'invalid_args', `${def.name}: ${err.message}`));
        note.detail = err instanceof Error ? err.message.slice(0, 120) : 'unknown error';
        return deny('error', fail(500, 'internal', 'Internal error'));
      }

      const resultChars = JSON.stringify(data).length;
      const items = (data as { items?: unknown[] } | null)?.items;
      reservation.settle({ rows: Array.isArray(items) ? items.length : 1, chars: resultChars });

      // Pages are distinct cursors: deriving a page number from offset / limit under-counts when pages come back short.
      let pageIndex = 0;
      if (typeof callArgs.cursor === 'string') {
        const paged = limiter.trackPage(principal.id, argsHash(callArgs), callArgs.cursor);
        pageIndex = paged.calls;
        if (paged.flagged) writeDeepPagingSentinel(db, scope, principal, def.name, transport);
      }

      note.decision = 'allowed';
      note.resultChars = resultChars;
      note.pageIndex = pageIndex;
      return isPageRead ? { ok: true, kind: 'page', pageData: data } : { ok: true, kind: 'read', data };
    }

    // mutating: prepare only. Nothing is written until a human approves the card.
    const prepareLimit =
      limited(limiter.take(`pp:${principal.id}`, LIMIT_PRINCIPAL_PREPARES), 'Too many change proposals from this session — wait before retrying.') ??
      limited(limiter.take(`up:${userKey}`, LIMIT_USER_PREPARES), 'Too many change proposals for this user — wait before retrying.');
    if (prepareLimit) return deny('rate_limited', prepareLimit);
    if (pendingCountForPrincipal(db, scope.sessionGeneration) >= MAX_PENDING_PER_PRINCIPAL ||
        pendingCountForUser(db, scope.userId) >= MAX_PENDING_PER_USER) {
      return deny('rate_limited', fail(429, 'rate_limited', 'Too many pending approvals — resolve or wait', { retryAfterSec: 30 }));
    }

    let delta;
    try {
      delta = prepareMutation(db, toolName, callArgs);
    } catch (err) {
      if (err instanceof NotFoundError) {
        note.decision = 'error';
        note.errorCode = 'not_found';
        return fail(404, 'not_found', err.message);
      }
      if (err instanceof PrepareError) return deny('invalid_args', fail(400, 'invalid_args', `${def.name}: ${err.message}`));
      note.detail = err instanceof Error ? err.message.slice(0, 120) : 'unknown error';
      return deny('error', fail(500, 'internal', 'Internal error'));
    }

    const operation = createOperation(db, {
      source: transport === 'http-mcp' ? 'http-mcp' : 'webmcp',
      grantId,
      toolName,
      args: delta.args,
      before: delta.before,
      after: delta.after,
      summary: delta.summary,
      bankData: delta.bankData ?? null,
      transactionId: delta.transactionId,
      revisionAtPrepare: delta.revision,
      profile: scope.profile,
      origin: scope.origin,
      sessionGeneration: scope.sessionGeneration,
      userId: scope.userId,
      role: scope.role,
    });
    note.decision = 'operation_created';
    note.operationId = operation.id;
    return { ok: true, kind: 'operation', operation };
  }
}

/**
 * `get_operation_result`: the outcome of an operation THIS client token created.
 * Anyone else's operation, or an id that does not exist, is the same 404, so ids cannot be probed.
 * The result carries no transaction text beyond what a committed outcome's sanitizer allows.
 */
function readOperationResult(db: Database, scope: RequestScope, args: Record<string, unknown>): unknown {
  const op = getOperationById(db, String(args.operationId));
  if (!op || op.source !== 'http-mcp' || op.session_generation !== scope.sessionGeneration) {
    throw new NotFoundError('No operation with that id was created by this client.');
  }
  if (op.kind === 'read' && op.status === 'committed' && op.outcome_json !== null && readDeliveryRefusal(db, op) !== null) {
    // The grant behind the read died (or the kill switch flipped) after the human approved: status only, data dropped.
    clearReadOutcome(db, op.id);
    return { operationId: op.id, outcome: op.status, expires_at: op.expires_at };
  }
  if (op.kind === 'read' && op.status === 'committed' && op.outcome_json !== null) {
    // A read the user allowed: the capped data itself (what the direct read would have returned), delivered once.
    const data = JSON.parse(op.outcome_json) as unknown;
    clearReadOutcome(db, op.id);
    return data;
  }
  const result = op.status === 'pending' ? undefined : sanitizeStoredOutcomeForAgent(db, op.outcome_json);
  const body = { operationId: op.id, outcome: op.status, expires_at: op.expires_at, ...(result === undefined ? {} : { result }) };
  // An outcome is a few fields; if one is ever larger than a tool result may be, the status alone still answers.
  return JSON.stringify(body).length <= DEFAULT_OUTPUT_CAP ? body : { operationId: op.id, outcome: op.status, expires_at: op.expires_at };
}

/**
 * Re-check the caller against `dashboard_users` (and the auth switch) at call
 * time. `null` means the caller is still allowed.
 *  - an owned grant needs an active user who still holds the tool's minimum role;
 *  - a grant with no owner (`user_id` NULL, minted while auth was off) is only
 *    honoured while auth is still off.
 */
function liveCallerCheck(db: Database, userId: number | null, minRole: Role): EngineError | null {
  if (userId === null) {
    return isAuthEnabled(db) ? fail(403, 'grant_invalid', 'Grant invalid: authentication was enabled after this grant was issued') : null;
  }
  const user = db.prepare('SELECT role, is_active FROM dashboard_users WHERE id = @id').get({ id: userId }) as
    | { role: Role; is_active: number }
    | undefined;
  if (!user || !user.is_active) return fail(403, 'grant_invalid', 'Grant invalid: the granting user is no longer active');
  if (minRole === 'admin' && user.role !== 'admin') return fail(403, 'role_forbidden', 'This tool requires the admin role');
  return null;
}

/** `: renamed to "x" in 0.10.0` for a retired tool name, else empty. Grants nothing: it only tells the caller the new name. */
function retiredHintSuffix(name: string): string {
  const hint = retiredNameHint(name);
  return hint ? `: ${hint}` : '';
}

function unknownToolLabel(name: string): string {
  return `${sanitizeUntrustedText(name, 30)}${retiredHintSuffix(name)}`;
}

/** `created_via` for a proposal row. Derived from the TOOL, never from the client-reported transport: only `/mcp` is server-derived. */
function proposalCreatedVia(def: Pick<McpToolDef, 'classification' | 'exposure'> | undefined, via: 'webmcp' | 'http-mcp'): 'webmcp' | 'declarative' | 'http-mcp' {
  return isDeclarativeProposal(def) ? 'declarative' : via;
}

/** The form's one-item proposal. Derived from the def, never a name literal: a one-letter slip between the twins must not move rows in or out of the blind-agreement metric. */
function isDeclarativeProposal(def: Pick<McpToolDef, 'classification' | 'exposure'> | undefined): boolean {
  return def?.classification === 'proposal' && def.exposure === 'declarative';
}

function judgeLimitMessage(limit: number): string {
  return `Daily judge limit reached (${limit}). Resume tomorrow or ask an admin to raise it in Settings.`;
}

function secondsToUtcMidnight(now: Date = new Date()): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
}

/** What the agent is told after proposals were inserted: counts and ids only, never any label or text. */
function proposalAnswer(def: Pick<McpToolDef, 'classification' | 'exposure'> | undefined, inserted: Extract<InsertProposalsResult, { ok: true }>): unknown {
  if (isDeclarativeProposal(def)) return { created: inserted.created, ...(inserted.ids[0] === undefined ? {} : { id: inserted.ids[0] }) };
  return { created: inserted.created, ids: inserted.ids, skipped: inserted.skipped };
}

/** The audit principal of the agent behind an operation: the tab's hashed session, or the client token's id. */
function principalOfOperation(op: Pick<McpOperation, 'source' | 'session_generation'>): Principal {
  if (op.source === 'http-mcp' && op.session_generation.startsWith('tok:')) return { kind: 'client_token', id: op.session_generation.slice(4) };
  return principalFor(op.session_generation);
}

function writeDeepPagingSentinel(db: Database, scope: RequestScope, principal: Principal, tool: string, transport: CallTransport): void {
  try {
    appendAudit(db, {
      transport,
      principalKind: principal.kind,
      principalId: principal.id,
      userId: scope.userId,
      role: scope.role,
      origin: scope.origin,
      toolName: tool,
      classification: 'read',
      decision: 'deep_paging',
      argsPreview: 'one principal paged through more than 20 pages of the same query',
    });
  } catch (err) {
    console.error('[mcp-audit] failed to write deep_paging sentinel:', err);
  }
}

// ── Operations: visibility, approval, rejection, cancel ──────────────────────

/** Who is looking at / acting on an operation. `authEnabled=false` means every local session is the same (admin) viewer. */
export interface OperationActor {
  userId: number | null;
  role: Role;
  authEnabled: boolean;
}

/**
 * With auth on, an operation belongs to the user who raised it: only that
 * user may see or act on it, and operations with no owner (`user_id` NULL,
 * raised while auth was off) are invisible to everyone. With auth off every
 * local session sees every operation (the accepted residual in the threat
 * model: only enabling auth closes it).
 */
export function isOperationVisible(op: McpOperation, actor: OperationActor): boolean {
  if (!actor.authEnabled) return true;
  return op.user_id !== null && op.user_id === actor.userId;
}

export function getPendingOperations(db: Database): McpOperation[] {
  expireStaleOperations(db);
  return listPendingOperations(db);
}

/** Fetch one operation, first marking any whose window has closed as expired. */
export function getOperationById(db: Database, id: string): McpOperation | null {
  expireStaleOperations(db);
  return getOperation(db, id);
}

export interface TypedOutcome {
  outcome: 'committed' | 'rejected' | 'stale' | 'unknown' | 'expired' | 'forbidden' | 'cancelled' | 'approval_too_fast';
  after?: unknown;
  /** Why an operation went stale (`owner_changed`, `grant_invalid:...`). */
  reason?: string;
}

/** The JSON a stored column holds, or undefined when it is empty or unreadable. */
function parseStored(json: string | null): unknown {
  if (json === null) return undefined;
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return undefined;
  }
}

function resolvedOutcome(operation: McpOperation): TypedOutcome {
  if (operation.status === 'expired') return { outcome: 'expired' };
  if (operation.status === 'committed' || operation.status === 'rejected' || operation.status === 'stale') {
    // A read's data belongs to the agent that asked and is delivered once through `?view=agent`; no outcome ever carries it.
    if (operation.kind === 'read') return { outcome: operation.status };
    return { outcome: operation.status, after: operation.outcome_json ? JSON.parse(operation.outcome_json) : undefined };
  }
  return { outcome: 'unknown' };
}

function lifecycleAudit(
  db: Database,
  op: McpOperation,
  decision: AuditDecision,
  actor?: OperationActor,
  detail?: string
): void {
  try {
    const userId = actor ? actor.userId : op.user_id;
    appendAudit(db, {
      transport: 'rest',
      principalKind: 'user',
      principalId: `user:${userId ?? 'anon'}`,
      userId,
      role: actor?.role ?? op.role,
      origin: op.origin,
      toolName: op.tool_name,
      classification: classify(op.tool_name) ?? 'mutating',
      decision,
      operationId: op.id,
      grantId: op.grant_id,
      argsPreview: detail ?? null,
    });
  } catch (err) {
    console.error('[mcp-audit] failed to write lifecycle row:', err);
  }
}

/** The operation's owner must still exist, be active, and still hold the tool's minimum role. */
function ownerStillAllowed(db: Database, op: McpOperation): boolean {
  if (op.user_id === null) return true;
  const owner = db.prepare('SELECT role, is_active FROM dashboard_users WHERE id = @id').get({ id: op.user_id }) as
    | { role: Role; is_active: number }
    | undefined;
  if (!owner || !owner.is_active) return false;
  const minRole = getToolDef(op.tool_name)?.minRole ?? 'admin';
  return minRole !== 'admin' || owner.role === 'admin';
}

// ── Approval dwell floor (threat T16) ────────────────────────────────────────

/**
 * An approval that arrives less than this long after the card was created is
 * refused (`approval_too_fast`) and the operation stays pending. A page-driving
 * agent that clicks Approve the instant its own card appears cannot beat it,
 * and a human cannot have read the card in that time either. The card enables
 * its button after 800 ms and wants a 600 ms hold, so a person is never held
 * back by this floor; it is the server-side backstop for everything that is not
 * the card.
 */
export const DEFAULT_APPROVAL_DWELL_MS = 1000;
let approvalDwellMs = DEFAULT_APPROVAL_DWELL_MS;

/** Override the floor (tests relax it to 0), or restore the default with `null`. */
export function setApprovalDwellMs(ms: number | null): void {
  approvalDwellMs = ms === null ? DEFAULT_APPROVAL_DWELL_MS : Math.max(0, ms);
}

/** True while the operation is younger than the dwell floor. */
export function isApprovalTooFast(op: Pick<McpOperation, 'created_at'>, now: number = Date.now()): boolean {
  if (approvalDwellMs <= 0) return false;
  const created = dbTimeMs(op.created_at);
  return Number.isFinite(created) && now - created < approvalDwellMs;
}

/**
 * Approve a pending WebMCP/HTTP-MCP operation: mints a one-shot token and
 * immediately consumes it to commit. The token still exists as a real,
 * time-boxed, single-use row — a second "approve" or a replayed commit call
 * against the same operation can't succeed twice (see consumeApprovalToken's
 * compare-and-swap). Chat-sourced operations are handled by the dashboard
 * chat module itself (server.ts wires that branch) since they resolve
 * through the agent's own approval promise, not a DB-applied mutation here.
 *
 * Checks, in order: the operation exists and is visible to the approver; an
 * already-resolved one is read back; one past `expires_at` is `expired` and
 * never commits; with auth on the approver must hold the write role.
 * `approver` is omitted by callers with no auth (local, single admin).
 */
export function approveWebMcpOperation(db: Database, operationId: string, currentProfile: string, approver?: OperationActor): TypedOutcome {
  const operation = getOperation(db, operationId);
  if (!operation) return { outcome: 'unknown' };
  if (approver && !isOperationVisible(operation, approver)) return { outcome: 'unknown' };
  if (operation.status !== 'pending') {
    return resolvedOutcome(operation);
  }
  if (isOperationExpired(operation)) {
    markOperationStatus(db, operationId, 'expired');
    lifecycleAudit(db, operation, 'expired', approver);
    return { outcome: 'expired' };
  }
  // A change needs the write role. A read the user was asked to allow may be approved by its owner even as a
  // viewer: they could read that data directly anyway.
  if (operation.kind !== 'read' && approver?.authEnabled && approver.role !== 'admin') {
    return { outcome: 'forbidden' };
  }
  if (isApprovalTooFast(operation)) return { outcome: 'approval_too_fast' };

  lifecycleAudit(db, operation, 'approved', approver);
  const { token } = issueApprovalToken(db, operationId);
  return commitWebMcpOperation(db, operationId, token, currentProfile, approver);
}

export function rejectOperation(db: Database, operationId: string, actor?: OperationActor): TypedOutcome {
  const operation = getOperation(db, operationId);
  if (!operation) return { outcome: 'unknown' };
  if (actor && !isOperationVisible(operation, actor)) return { outcome: 'unknown' };
  if (operation.status !== 'pending') return resolvedOutcome(operation);
  if (isOperationExpired(operation)) {
    markOperationStatus(db, operationId, 'expired');
    lifecycleAudit(db, operation, 'expired', actor);
    return { outcome: 'expired' };
  }
  markOperationStatus(db, operationId, 'rejected');
  lifecycleAudit(db, operation, 'rejected', actor);
  return { outcome: 'rejected' };
}

/**
 * The requesting principal withdraws its own pending operation (the agent's
 * `execute` was aborted). Only the same session may cancel; anyone else gets
 * null (the route answers 404).
 */
export function cancelOperation(db: Database, scope: RequestScope, operationId: string): TypedOutcome | null {
  const operation = getOperation(db, operationId);
  if (!operation || operation.source === 'chat') return null;
  if (operation.session_generation !== scope.sessionGeneration || operation.user_id !== scope.userId) return null;
  if (operation.status !== 'pending') return resolvedOutcome(operation);
  markOperationStatus(db, operationId, 'rejected', { reason: 'cancelled_by_agent' });
  lifecycleAudit(db, operation, 'cancelled', { userId: scope.userId, role: scope.role, authEnabled: scope.userId !== null });
  return { outcome: 'cancelled' };
}

/**
 * Commit is idempotent per operation id: if it already resolved (e.g. the
 * caller's connection dropped after a prior commit succeeded server-side),
 * this returns the stored outcome instead of re-applying anything —
 * "reconcile by operation id", never a silent replay.
 *
 * The grant is re-validated here, not just at prepare time: prepare and
 * approve are two separate moments, and anything that can invalidate a
 * grant (revoke, logout, profile switch, origin/schema change) can happen
 * in between. Without this re-check, a revoked-before-commit grant would
 * still let the earlier prepared operation go through on approve. The same
 * goes for the operation's owner (re-read from dashboard_users: a deactivated
 * or demoted owner makes the operation stale) and for its confirmation window.
 *
 * `currentProfile` is passed in rather than re-derived here so this stays
 * testable without a live profile-manager singleton — it must be the
 * *current* active profile, not the one recorded on the operation (which
 * trivially matches itself and would never catch a profile switch).
 */
export function commitWebMcpOperation(
  db: Database,
  operationId: string,
  approvalToken: string,
  currentProfile: string,
  actor?: OperationActor
): TypedOutcome {
  const operation = getOperation(db, operationId);
  if (!operation) return { outcome: 'unknown' };
  if (operation.status !== 'pending') {
    return resolvedOutcome(operation);
  }
  if (isOperationExpired(operation)) {
    markOperationStatus(db, operationId, 'expired');
    lifecycleAudit(db, operation, 'expired', actor);
    return { outcome: 'expired' };
  }

  const consumed = consumeApprovalToken(db, approvalToken);
  if (!consumed.ok || consumed.operationId !== operationId) {
    return { outcome: 'unknown' };
  }

  if (!ownerStillAllowed(db, operation)) {
    markOperationStatus(db, operationId, 'stale', { reason: 'owner_changed' });
    lifecycleAudit(db, operation, 'stale', actor, 'owner_changed');
    return { outcome: 'stale', reason: 'owner_changed' };
  }

  // The user may have turned this tool Off (or flipped the kill switch in another process) since the card was raised:
  // Off beats an approval, whatever the card still says.
  if (getEffectivePolicy(db, operation.user_id, operation.tool_name) === 'off') {
    markOperationStatus(db, operationId, 'stale', { reason: 'policy_off' });
    lifecycleAudit(db, operation, 'stale', actor, 'policy_off');
    return { outcome: 'stale', reason: 'policy_off' };
  }

  // An external client's change was only ever allowed to be proposed because a human would answer it from
  // an authenticated dashboard. With auth off, anyone local (including that client's own shell) could approve it.
  // (Reads are different: with auth off an external client may read, so a read it asked to run may be answered.)
  if (operation.source === 'http-mcp' && operation.kind !== 'read' && !isAuthEnabled(db)) {
    markOperationStatus(db, operationId, 'stale', { reason: 'auth_disabled' });
    lifecycleAudit(db, operation, 'stale', actor, 'auth_disabled');
    return { outcome: 'stale', reason: 'auth_disabled' };
  }

  if (operation.grant_id) {
    const validation = validateGrant(db, operation.grant_id, operation.tool_name, schemaDigest(operation.tool_name), {
      userId: operation.user_id,
      role: operation.role,
      profile: currentProfile,
      origin: operation.origin,
      sessionGeneration: operation.session_generation,
    });
    if (!validation.ok) {
      const reason = `grant_invalid:${validation.reason}`;
      markOperationStatus(db, operationId, 'stale', { reason });
      lifecycleAudit(db, operation, 'stale', actor, reason);
      return { outcome: 'stale', reason };
    }
  }

  const args = JSON.parse(operation.args_json) as Record<string, unknown>;
  if (operation.kind === 'read') return commitReadOperation(db, operation, args, actor);
  if (operation.kind === 'proposal') return commitProposalOperation(db, operation, args, actor);

  const result = commitMutation(db, operation.tool_name, args, operation.revision_at_prepare, parseStored(operation.before_json));
  const status = result.outcome === 'committed' ? 'committed' : result.outcome === 'stale' ? 'stale' : 'unknown';
  markOperationStatus(db, operationId, status, result.after);
  lifecycleAudit(db, operation, status === 'committed' ? 'committed' : status === 'stale' ? 'stale' : 'error', actor);
  return { outcome: status, after: result.after };
}

/**
 * Approve a judge proposal card: insert the proposals, as `proposed` rows and nothing else. The daily limit is
 * checked again here (a card can sit for minutes, and the user may have lowered the limit). Skipped items
 * (an interaction deleted since) are reported in the outcome, not as an error.
 */
function commitProposalOperation(db: Database, operation: McpOperation, args: Record<string, unknown>, actor?: OperationActor): TypedOutcome {
  const def = getToolDef(operation.tool_name);
  if (!def || def.classification !== 'proposal' || !Array.isArray(args.items)) {
    markOperationStatus(db, operation.id, 'stale', { reason: 'unknown_tool' });
    lifecycleAudit(db, operation, 'stale', actor, 'unknown_tool');
    return { outcome: 'stale', reason: 'unknown_tool' };
  }
  const inserted = insertProposals(db, {
    principalId: principalOfOperation(operation).id,
    createdVia: proposalCreatedVia(def, operation.source === 'http-mcp' ? 'http-mcp' : 'webmcp'),
    judgeModel: args.judgeModel as string,
    rubricVersion: args.rubricVersion as string,
    items: args.items as Parameters<typeof insertProposals>[1]['items'],
    dailyLimit: getJudgeDailyLimit(),
  });
  if (!inserted.ok) {
    markOperationStatus(db, operation.id, 'stale', { reason: 'daily_limit' });
    lifecycleAudit(db, operation, 'stale', actor, 'daily_limit');
    return { outcome: 'stale', reason: 'daily_limit' };
  }
  const data = proposalAnswer(def, inserted);
  markOperationStatus(db, operation.id, 'committed', data);
  lifecycleAudit(db, operation, 'committed', actor, `${inserted.created} proposed`);
  return { outcome: 'committed', after: data };
}

/**
 * Run an allowed read-ask operation. The human said yes, so the read runs now,
 * against the live database, spending from the owner's daily read budget like
 * any other read. The capped data is stored on the operation for the REQUESTING
 * principal only (it is nulled after first delivery, or 5 minutes after this).
 * The approver's response never carries it (see the approve route).
 */
function commitReadOperation(db: Database, operation: McpOperation, args: Record<string, unknown>, actor?: OperationActor): TypedOutcome {
  const def = getToolDef(operation.tool_name);
  const isPage = def?.classification === 'page';
  if (def && isPage && !def.pageData) {
    // The human allowed the page to act. There is no server data: the agent learns it may go ahead.
    const data = { authorized: true };
    markOperationStatus(db, operation.id, 'committed', data);
    lifecycleAudit(db, operation, 'committed', actor, 'page call allowed');
    return { outcome: 'committed', after: data };
  }
  if (!def || (def.classification !== 'read' && !isPage)) {
    markOperationStatus(db, operation.id, 'stale', { reason: 'unknown_tool' });
    lifecycleAudit(db, operation, 'stale', actor, 'unknown_tool');
    return { outcome: 'stale', reason: 'unknown_tool' };
  }
  const reservation = limiterFor(db).reserveRead(userKeyOf(operation.user_id), readEstimate(def, args));
  if (!reservation.ok) {
    markOperationStatus(db, operation.id, 'stale', { reason: 'read_budget_exceeded' });
    lifecycleAudit(db, operation, 'stale', actor, 'read_budget_exceeded');
    return { outcome: 'stale', reason: 'read_budget_exceeded' };
  }
  let data: unknown;
  try {
    // A page tool's row (`pageData`) is read now, against the live database, exactly like a read's data.
    data = isPage ? def.pageData!(db, args) : executeReadSync(db, operation.tool_name, args, { principalId: principalOfOperation(operation).id });
  } catch (err) {
    reservation.settle();
    const reason = err instanceof CursorError ? 'cursor_invalid' : err instanceof NotFoundError ? 'not_found' : err instanceof PrepareError ? 'invalid_args' : 'read_failed';
    markOperationStatus(db, operation.id, 'stale', { reason });
    lifecycleAudit(db, operation, 'stale', actor, reason);
    return { outcome: 'stale', reason };
  }
  const resultChars = JSON.stringify(data).length;
  const items = (data as { items?: unknown[] } | null)?.items;
  reservation.settle({ rows: Array.isArray(items) ? items.length : 1, chars: resultChars });
  markOperationStatus(db, operation.id, 'committed', data);
  lifecycleAudit(db, operation, 'committed', actor, `${resultChars} characters`);
  return { outcome: 'committed', after: data };
}

// ── Kill switch ──────────────────────────────────────────────────────────────

export interface KillSwitchResult {
  revokedGrants: number;
  rejectedOperations: number;
}

/**
 * The global kill switch. `enabled=false` writes the process-global state
 * (agent-access.json: `enabled=false`, `killSwitchEpoch=now`), revokes every
 * active grant and client token and rejects every pending agent operation (`{reason:'kill_switch'}`)
 * in `db`; from then on `callTool`, `exposedTools` and `/mcp` tools/list refuse in
 * EVERY profile. The epoch also kills grants left in other profiles' databases, even after
 * the switch is turned back on. `enabled=true` only lifts the refusal: nothing
 * revoked comes back.
 *
 * Authorization (admin) is the caller's: the settings route.
 */
export function setKillSwitch(db: Database, enabled: boolean): KillSwitchResult {
  if (enabled) {
    setGlobalAgentState({ enabled: true });
    return { revokedGrants: 0, rejectedOperations: 0 };
  }
  const stamp = Date.now();
  setGlobalAgentState({ enabled: false, killSwitchEpoch: stamp });
  // A grant made after this call must carry a later millisecond than the epoch, or `validateGrant` would call it dead.
  while (Date.now() <= stamp) { /* at most one millisecond */ }

  const rejected = rejectPendingAgentOperations(db, 'kill_switch');
  for (const id of rejected) {
    const op = getOperation(db, id);
    if (op) lifecycleAudit(db, op, 'rejected', undefined, 'kill_switch');
  }
  const revokedGrants = revokeAllGrants(db);
  // Data a user allowed but the agent has not fetched yet must not be delivered after "no tools are exposed".
  db.prepare("UPDATE mcp_operations SET outcome_json = NULL WHERE kind = 'read' AND outcome_json IS NOT NULL").run();
  // The credentials too: with only their grants gone, turning the switch back on would let the same bearer be
  // handed fresh grants from the tools editor. "Nothing revoked comes back."
  db.prepare('UPDATE mcp_client_tokens SET revoked_at = @now WHERE revoked_at IS NULL').run({ now: new Date().toISOString() });
  return { revokedGrants, rejectedOperations: rejected.length };
}

/** Whether agent access is on right now (the global switch). Re-exported for the routes. */
export { isAgentAccessEnabled, getKillSwitchEpoch };
