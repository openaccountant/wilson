/**
 * Orchestrates grants + the prepare/commit protocol on top of src/mcp/store.ts
 * and src/mcp/tool-catalog.ts. This is the single code path both transports
 * (in-page WebMCP registration and the Streamable-HTTP /mcp fallback) call
 * into — see the module docstring in tool-catalog.ts for why that matters.
 */
import type { Database } from '../db/compat-sqlite.js';
import {
  createGrants,
  listGrantsForSession,
  revokeGrant,
  revokeGrantsForSession,
  validateGrant,
  createOperation,
  getOperation,
  listPendingOperations,
  markOperationStatus,
  issueApprovalToken,
  consumeApprovalToken,
  expireStaleOperations,
  type McpGrant,
  type McpOperation,
  type Role,
  type OperationSource,
} from './store.js';
import {
  MCP_TOOL_CATALOG,
  getToolDef,
  jsonSchemaFor,
  schemaDigest,
  isMutatingCall,
  executeRead,
  prepareMutation,
  commitMutation,
  toolAnnotations,
  PrepareError,
} from './tool-catalog.js';

export interface RequestScope {
  role: Role;
  userId: number | null;
  profile: string;
  origin: string;
  sessionGeneration: string;
}

export interface EngineError {
  ok: false;
  status: number;
  error: string;
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

/** Static catalog metadata for the dashboard's grant picker UI — not the same as what's exposed to an agent. */
export function listCatalog(): Array<{ name: string; description: string; classification: string; inputSchema: unknown; annotations: ReturnType<typeof toolAnnotations> }> {
  return MCP_TOOL_CATALOG.map((def) => ({
    name: def.name,
    description: def.description,
    classification: def.classification,
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
  const unknown = toolNames.filter((name) => !getToolDef(name));
  if (unknown.length > 0) {
    return { ok: false, status: 400, error: `Unknown tool(s): ${unknown.join(', ')}` };
  }
  // Viewers may grant themselves read-only access, but never a mutating tool —
  // mirrors the existing canWrite() RBAC gate on the plain REST routes.
  if (scope.role !== 'admin') {
    const mutating = toolNames.filter((name) => getToolDef(name)!.classification === 'mutating');
    if (mutating.length > 0) {
      return { ok: false, status: 403, error: `Viewer role cannot grant mutating tool(s): ${mutating.join(', ')}` };
    }
  }

  const grants = createGrants(db, {
    ...grantScopeParams(scope),
    tools: toolNames.map((name) => ({ name, schemaDigest: schemaDigest(name) })),
  });
  return { ok: true, grants };
}

export function listActiveGrants(db: Database, sessionGeneration: string): McpGrant[] {
  return listGrantsForSession(db, sessionGeneration);
}

export function revokeLocalGrant(db: Database, grantId: string): void {
  revokeGrant(db, grantId);
}

export function revokeAllForSession(db: Database, sessionGeneration: string): number {
  return revokeGrantsForSession(db, sessionGeneration);
}

export interface ExposedTool {
  name: string;
  description: string;
  inputSchema: unknown;
  annotations: ReturnType<typeof toolAnnotations>;
  grantId: string;
}

/** What the WebMCP bridge / HTTP-MCP client should actually register — empty until grants exist. */
export function exposedTools(db: Database, scope: RequestScope): ExposedTool[] {
  const grants = listGrantsForSession(db, scope.sessionGeneration).filter(
    (g) => g.profile === scope.profile && g.origin === scope.origin && g.role === scope.role && g.user_id === scope.userId
  );
  const out: ExposedTool[] = [];
  for (const grant of grants) {
    const def = getToolDef(grant.tool_name);
    if (!def) continue;
    out.push({
      name: def.name,
      description: def.description,
      inputSchema: jsonSchemaFor(def.name),
      annotations: toolAnnotations(def.name),
      grantId: grant.id,
    });
  }
  return out;
}

// ── Read tools ───────────────────────────────────────────────────────────────

export async function callReadTool(
  db: Database,
  scope: RequestScope,
  grantId: string,
  toolName: string,
  args: Record<string, unknown>
): Promise<{ ok: true; data: unknown } | EngineError> {
  const def = getToolDef(toolName);
  if (!def) return { ok: false, status: 404, error: 'Unknown tool' };
  if (isMutatingCall(toolName, args)) {
    return { ok: false, status: 400, error: 'Use prepare/commit for a mutating call' };
  }
  const validation = validateGrant(db, grantId, toolName, schemaDigest(toolName), grantScopeParams(scope));
  if (!validation.ok) {
    return { ok: false, status: 403, error: `Grant invalid: ${validation.reason}` };
  }
  try {
    const data = await executeRead(db, toolName, args);
    return { ok: true, data };
  } catch (err) {
    return { ok: false, status: 500, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Mutation prepare/commit ──────────────────────────────────────────────────

export function prepareOperation(
  db: Database,
  scope: RequestScope,
  source: OperationSource,
  grantId: string | null,
  toolName: string,
  args: Record<string, unknown>
): { ok: true; operation: McpOperation } | EngineError {
  const def = getToolDef(toolName);
  if (!def) return { ok: false, status: 404, error: 'Unknown tool' };
  if (!isMutatingCall(toolName, args)) {
    return { ok: false, status: 400, error: 'This call does not require confirmation — use the read path' };
  }

  // Chat-originated operations are gated by the existing dashboard chat/RBAC
  // flow, not a WebMCP grant (there is no browser-side grant to check there).
  if (source !== 'chat') {
    if (!grantId) return { ok: false, status: 403, error: 'No grant provided' };
    const validation = validateGrant(db, grantId, toolName, schemaDigest(toolName), grantScopeParams(scope));
    if (!validation.ok) {
      return { ok: false, status: 403, error: `Grant invalid: ${validation.reason}` };
    }
  }

  let delta;
  try {
    delta = prepareMutation(db, toolName, args);
  } catch (err) {
    if (err instanceof PrepareError) return { ok: false, status: 400, error: err.message };
    return { ok: false, status: 500, error: err instanceof Error ? err.message : String(err) };
  }

  const operation = createOperation(db, {
    source,
    grantId,
    toolName,
    args,
    before: delta.before,
    after: delta.after,
    summary: delta.summary,
    transactionId: delta.transactionId,
    revisionAtPrepare: delta.revision,
    profile: scope.profile,
    origin: scope.origin,
    sessionGeneration: scope.sessionGeneration,
    userId: scope.userId,
    role: scope.role,
  });
  return { ok: true, operation };
}

export function getPendingOperations(db: Database): McpOperation[] {
  expireStaleOperations(db);
  return listPendingOperations(db);
}

export function getOperationById(db: Database, id: string): McpOperation | null {
  return getOperation(db, id);
}

export interface TypedOutcome {
  outcome: 'committed' | 'rejected' | 'stale' | 'unknown';
  after?: unknown;
}

/**
 * Approve a pending WebMCP/HTTP-MCP operation: mints a one-shot token and
 * immediately consumes it to commit. The token still exists as a real,
 * time-boxed, single-use row — a second "approve" or a replayed commit call
 * against the same operation can't succeed twice (see consumeApprovalToken's
 * compare-and-swap). Chat-sourced operations are handled by the dashboard
 * chat module itself (server.ts wires that branch) since they resolve
 * through the agent's own approval promise, not a DB-applied mutation here.
 */
export function approveWebMcpOperation(db: Database, operationId: string, currentProfile: string): TypedOutcome {
  const operation = getOperation(db, operationId);
  if (!operation) return { outcome: 'unknown' };
  if (operation.status !== 'pending') {
    return resolvedOutcome(operation);
  }

  const { token } = issueApprovalToken(db, operationId);
  return commitWebMcpOperation(db, operationId, token, currentProfile);
}

export function rejectOperation(db: Database, operationId: string): TypedOutcome {
  const operation = getOperation(db, operationId);
  if (!operation) return { outcome: 'unknown' };
  if (operation.status !== 'pending') return resolvedOutcome(operation);
  markOperationStatus(db, operationId, 'rejected');
  return { outcome: 'rejected' };
}

function resolvedOutcome(operation: McpOperation): TypedOutcome {
  if (operation.status === 'committed' || operation.status === 'rejected' || operation.status === 'stale') {
    return { outcome: operation.status, after: operation.outcome_json ? JSON.parse(operation.outcome_json) : undefined };
  }
  return { outcome: 'unknown' };
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
 * still let the earlier prepared operation go through on approve.
 *
 * `currentProfile` is passed in rather than re-derived here so this stays
 * testable without a live profile-manager singleton — it must be the
 * *current* active profile, not the one recorded on the operation (which
 * trivially matches itself and would never catch a profile switch).
 */
export function commitWebMcpOperation(db: Database, operationId: string, approvalToken: string, currentProfile: string): TypedOutcome {
  const operation = getOperation(db, operationId);
  if (!operation) return { outcome: 'unknown' };
  if (operation.status !== 'pending') {
    return resolvedOutcome(operation);
  }

  const consumed = consumeApprovalToken(db, approvalToken);
  if (!consumed.ok || consumed.operationId !== operationId) {
    return { outcome: 'unknown' };
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
      markOperationStatus(db, operationId, 'stale', { reason: `grant_invalid:${validation.reason}` });
      return { outcome: 'stale' };
    }
  }

  const args = JSON.parse(operation.args_json) as Record<string, unknown>;
  const result = commitMutation(db, operation.tool_name, args, operation.revision_at_prepare);
  const status = result.outcome === 'committed' ? 'committed' : result.outcome === 'stale' ? 'stale' : 'unknown';
  markOperationStatus(db, operationId, status, result.after);
  return { outcome: status, after: result.after };
}
