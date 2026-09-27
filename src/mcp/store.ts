/**
 * Persisted grant + prepare/commit-operation store for the WebMCP bridge.
 *
 * Mirrors the dashboard_sessions/cleanExpiredSessions pattern in
 * src/dashboard/auth.ts: every scope check reads back from durable rows
 * (never trusts an in-memory cache), so a grant or approval can't outlive
 * its bound context by surviving a server restart, and two dashboard
 * processes sharing a DB would still agree on what's valid.
 *
 * Terminology:
 * - "grant": a standing, scoped permission for one tool, created by an
 *   explicit local user gesture. Bound to {tool+schema digest, user/role,
 *   profile, origin, session generation, expiry}.
 * - "operation": one prepared mutation (prepare/commit protocol). Carries
 *   its own copy of the scope it was prepared under, plus the before/after
 *   delta the confirmation UI renders.
 * - "approval token": a one-shot credential minted only when a human
 *   approves a pending operation via the trusted dashboard UI. commit()
 *   consumes it exactly once.
 */
import type { Database } from '../db/compat-sqlite.js';

// ── Types ────────────────────────────────────────────────────────────────────

export type Role = 'admin' | 'viewer';
export type OperationSource = 'webmcp' | 'http-mcp' | 'chat';
export type OperationStatus = 'pending' | 'committed' | 'rejected' | 'stale' | 'unknown' | 'expired';

export interface McpGrant {
  id: string;
  batch_id: string;
  tool_name: string;
  schema_digest: string;
  user_id: number | null;
  role: Role;
  profile: string;
  origin: string;
  session_generation: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
}

export interface McpOperation {
  id: string;
  source: OperationSource;
  grant_id: string | null;
  tool_name: string;
  args_json: string;
  before_json: string | null;
  after_json: string | null;
  /** Server-computed human summary from prepareMutation — what the confirmation card names the change by. */
  summary: string | null;
  transaction_id: number | null;
  revision_at_prepare: number | null;
  profile: string;
  origin: string;
  session_generation: string;
  user_id: number | null;
  role: Role;
  status: OperationStatus;
  outcome_json: string | null;
  created_at: string;
  expires_at: string;
  resolved_at: string | null;
}

export interface GrantScope {
  userId: number | null;
  role: Role;
  profile: string;
  origin: string;
  sessionGeneration: string;
}

export interface GrantValidationFailure {
  ok: false;
  reason: 'not_found' | 'revoked' | 'expired' | 'scope_mismatch' | 'schema_changed';
}

export type GrantValidationResult = { ok: true; grant: McpGrant } | GrantValidationFailure;

const GRANT_TTL_MS = 12 * 60 * 60 * 1000; // 12h — a working session, not a standing credential
const OPERATION_TTL_MS = 5 * 60 * 1000; // confirmation window before a prepared op goes stale
const APPROVAL_TOKEN_TTL_MS = 2 * 60 * 1000; // one-shot token lifetime after a human clicks approve

function randomId(): string {
  return crypto.randomUUID();
}

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function isoIn(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

// ── Grants ───────────────────────────────────────────────────────────────────

/**
 * Create one grant row per requested tool, all sharing a batch id so a
 * single user gesture ("allow WebMCP access for these tools") can be
 * revoked or looked up as one unit.
 */
export function createGrants(
  db: Database,
  params: {
    tools: Array<{ name: string; schemaDigest: string }>;
    userId: number | null;
    role: Role;
    profile: string;
    origin: string;
    sessionGeneration: string;
    ttlMs?: number;
  }
): McpGrant[] {
  const batchId = randomId();
  const expiresAt = isoIn(params.ttlMs ?? GRANT_TTL_MS);
  const insert = db.prepare(`
    INSERT INTO mcp_grants (id, batch_id, tool_name, schema_digest, user_id, role, profile, origin, session_generation, expires_at)
    VALUES (@id, @batchId, @toolName, @schemaDigest, @userId, @role, @profile, @origin, @sessionGeneration, @expiresAt)
  `);

  const grants: McpGrant[] = [];
  for (const tool of params.tools) {
    const id = randomId();
    insert.run({
      id,
      batchId,
      toolName: tool.name,
      schemaDigest: tool.schemaDigest,
      userId: params.userId,
      role: params.role,
      profile: params.profile,
      origin: params.origin,
      sessionGeneration: params.sessionGeneration,
      expiresAt,
    });
    const grant = getGrant(db, id);
    if (grant) grants.push(grant);
  }
  return grants;
}

export function getGrant(db: Database, id: string): McpGrant | null {
  const row = db.prepare('SELECT * FROM mcp_grants WHERE id = @id').get({ id }) as McpGrant | undefined;
  return row ?? null;
}

export function listGrantsForSession(db: Database, sessionGeneration: string): McpGrant[] {
  return db.prepare(`
    SELECT * FROM mcp_grants
    WHERE session_generation = @sessionGeneration AND revoked_at IS NULL AND expires_at > datetime('now')
    ORDER BY tool_name
  `).all({ sessionGeneration }) as McpGrant[];
}

export function revokeGrant(db: Database, id: string): void {
  db.prepare("UPDATE mcp_grants SET revoked_at = datetime('now') WHERE id = @id").run({ id });
}

export function revokeGrantsForSession(db: Database, sessionGeneration: string): number {
  const result = db.prepare(
    "UPDATE mcp_grants SET revoked_at = datetime('now') WHERE session_generation = @sessionGeneration AND revoked_at IS NULL"
  ).run({ sessionGeneration });
  return (result as { changes: number }).changes;
}

/** Called on logout / token revocation so every grant tied to that dashboard user dies with the session. */
export function revokeGrantsForUser(db: Database, userId: number): number {
  const result = db.prepare(
    "UPDATE mcp_grants SET revoked_at = datetime('now') WHERE user_id = @userId AND revoked_at IS NULL"
  ).run({ userId });
  return (result as { changes: number }).changes;
}

export function cleanExpiredGrants(db: Database): number {
  const result = db.prepare("DELETE FROM mcp_grants WHERE expires_at <= datetime('now')").run();
  return (result as { changes: number }).changes;
}

/**
 * The single scope check every tool call goes through, WebMCP or HTTP-MCP.
 * Deliberately re-derives everything from the DB row rather than trusting
 * the caller's claimed scope for anything but the lookup key (grant id) —
 * profile switches, logout, schema changes, and explicit revokes all show
 * up here automatically because they mutate or delete the row this reads.
 */
export function validateGrant(
  db: Database,
  grantId: string,
  toolName: string,
  currentSchemaDigest: string,
  scope: GrantScope
): GrantValidationResult {
  const grant = getGrant(db, grantId);
  if (!grant) return { ok: false, reason: 'not_found' };
  if (grant.revoked_at) return { ok: false, reason: 'revoked' };
  if (new Date(grant.expires_at).getTime() <= Date.now()) return { ok: false, reason: 'expired' };
  if (grant.tool_name !== toolName) return { ok: false, reason: 'scope_mismatch' };
  if (grant.schema_digest !== currentSchemaDigest) return { ok: false, reason: 'schema_changed' };
  if (
    grant.role !== scope.role ||
    grant.profile !== scope.profile ||
    grant.origin !== scope.origin ||
    grant.session_generation !== scope.sessionGeneration ||
    grant.user_id !== scope.userId
  ) {
    return { ok: false, reason: 'scope_mismatch' };
  }
  return { ok: true, grant };
}

// ── Operations (prepare/commit) ──────────────────────────────────────────────

export function createOperation(
  db: Database,
  params: {
    source: OperationSource;
    grantId: string | null;
    toolName: string;
    args: unknown;
    before: unknown;
    after: unknown;
    summary?: string | null;
    transactionId: number | null;
    revisionAtPrepare: number | null;
    profile: string;
    origin: string;
    sessionGeneration: string;
    userId: number | null;
    role: Role;
    ttlMs?: number;
  }
): McpOperation {
  const id = randomId();
  const expiresAt = isoIn(params.ttlMs ?? OPERATION_TTL_MS);
  db.prepare(`
    INSERT INTO mcp_operations (
      id, source, grant_id, tool_name, args_json, before_json, after_json, summary,
      transaction_id, revision_at_prepare, profile, origin, session_generation,
      user_id, role, status, expires_at
    ) VALUES (
      @id, @source, @grantId, @toolName, @argsJson, @beforeJson, @afterJson, @summary,
      @transactionId, @revisionAtPrepare, @profile, @origin, @sessionGeneration,
      @userId, @role, 'pending', @expiresAt
    )
  `).run({
    id,
    source: params.source,
    grantId: params.grantId,
    toolName: params.toolName,
    argsJson: JSON.stringify(params.args),
    beforeJson: params.before === undefined ? null : JSON.stringify(params.before),
    afterJson: params.after === undefined ? null : JSON.stringify(params.after),
    summary: params.summary ?? null,
    transactionId: params.transactionId,
    revisionAtPrepare: params.revisionAtPrepare,
    profile: params.profile,
    origin: params.origin,
    sessionGeneration: params.sessionGeneration,
    userId: params.userId,
    role: params.role,
    expiresAt,
  });
  return getOperation(db, id)!;
}

export function getOperation(db: Database, id: string): McpOperation | null {
  const row = db.prepare('SELECT * FROM mcp_operations WHERE id = @id').get({ id }) as McpOperation | undefined;
  return row ?? null;
}

/** Pending operations across every source (WebMCP tabs, HTTP-MCP clients, chat) — the single confirmation queue. */
export function listPendingOperations(db: Database): McpOperation[] {
  return db.prepare(`
    SELECT * FROM mcp_operations WHERE status = 'pending' AND expires_at > datetime('now') ORDER BY created_at ASC
  `).all() as McpOperation[];
}

export function markOperationStatus(
  db: Database,
  id: string,
  status: OperationStatus,
  outcome?: unknown
): void {
  db.prepare(`
    UPDATE mcp_operations SET status = @status, outcome_json = @outcomeJson, resolved_at = datetime('now')
    WHERE id = @id
  `).run({ id, status, outcomeJson: outcome === undefined ? null : JSON.stringify(outcome) });
  resolveWaiters(id);
}

/** Sweep pending operations whose confirmation window has elapsed with nobody acting on them. */
export function expireStaleOperations(db: Database): number {
  const rows = db.prepare(
    "SELECT id FROM mcp_operations WHERE status = 'pending' AND expires_at <= datetime('now')"
  ).all() as { id: string }[];
  for (const row of rows) {
    markOperationStatus(db, row.id, 'expired');
  }
  return rows.length;
}

// ── One-shot approval tokens ─────────────────────────────────────────────────

export function issueApprovalToken(db: Database, operationId: string): { token: string; expiresAt: string } {
  const token = randomToken();
  const expiresAt = isoIn(APPROVAL_TOKEN_TTL_MS);
  db.prepare(`
    INSERT INTO mcp_approval_tokens (token, operation_id, expires_at) VALUES (@token, @operationId, @expiresAt)
  `).run({ token, operationId, expiresAt });
  return { token, expiresAt };
}

export type ConsumeTokenResult =
  | { ok: true; operationId: string }
  | { ok: false; reason: 'not_found' | 'already_used' | 'expired' };

/**
 * Atomically claim a one-shot approval token. The UPDATE's WHERE clause
 * doubles as the compare-and-swap: two concurrent commit attempts racing on
 * the same token can only ever have one `changes === 1`, so a duplicate
 * commit attempt always loses even under concurrent requests.
 */
export function consumeApprovalToken(db: Database, token: string): ConsumeTokenResult {
  const row = db.prepare('SELECT * FROM mcp_approval_tokens WHERE token = @token').get({ token }) as
    | { token: string; operation_id: string; expires_at: string; used_at: string | null }
    | undefined;
  if (!row) return { ok: false, reason: 'not_found' };
  if (row.used_at) return { ok: false, reason: 'already_used' };
  if (new Date(row.expires_at).getTime() <= Date.now()) return { ok: false, reason: 'expired' };

  const result = db.prepare(`
    UPDATE mcp_approval_tokens SET used_at = datetime('now')
    WHERE token = @token AND used_at IS NULL
  `).run({ token });
  if ((result as { changes: number }).changes === 0) {
    return { ok: false, reason: 'already_used' };
  }
  return { ok: true, operationId: row.operation_id };
}

// ── In-process pub/sub for the blocking HTTP-MCP wait ───────────────────────
//
// The Streamable-HTTP `/mcp` tool call for a mutating tool blocks until a
// human resolves the operation through the dashboard's confirmation UI
// (the same queue WebMCP and chat use). This is an in-memory notification
// only — the DB row is always the source of truth; a waiter that misses the
// notification (e.g. server restart) still gets the right answer via its
// own timeout + a final read of the row.

type Waiter = (status: OperationStatus) => void;
const waiters = new Map<string, Set<Waiter>>();

function resolveWaiters(operationId: string): void {
  const set = waiters.get(operationId);
  if (!set) return;
  waiters.delete(operationId);
  // Status is re-read by the caller from the DB; this is purely a wake-up signal.
  for (const cb of set) cb('pending');
}

export function waitForOperationResolution(
  db: Database,
  operationId: string,
  timeoutMs: number
): Promise<McpOperation | null> {
  return new Promise((resolve) => {
    const finish = () => resolve(getOperation(db, operationId));

    const current = getOperation(db, operationId);
    if (!current || current.status !== 'pending') {
      finish();
      return;
    }

    let set = waiters.get(operationId);
    if (!set) {
      set = new Set();
      waiters.set(operationId, set);
    }
    const activeSet = set;

    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      activeSet.delete(onResolved);
      finish();
    }, timeoutMs);

    const onResolved: Waiter = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      finish();
    };

    activeSet.add(onResolved);
  });
}
