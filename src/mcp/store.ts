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
import { appendAudit, principalFor } from './audit.js';
import { getKillSwitchEpoch } from './global-state.js';
import { getToolDef, schemaDigest } from './tool-catalog.js';

// ── Types ────────────────────────────────────────────────────────────────────

export type Role = 'admin' | 'viewer';
export type OperationSource = 'webmcp' | 'http-mcp' | 'chat';
export type OperationStatus = 'pending' | 'committed' | 'rejected' | 'stale' | 'unknown' | 'expired';
/** `mutation`: a change to confirm. `read`: a read the user must allow (policy Ask). `proposal`: reserved for judge batches. */
export type OperationKind = 'mutation' | 'read' | 'proposal';

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
  /** What the operation is (v31). Rows from before it are `mutation`. */
  kind: OperationKind;
  /** The quoted bank description the card shows on its own row (v31), kept out of `summary` (T10). */
  bank_data: string | null;
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
  reason: 'not_found' | 'revoked' | 'expired' | 'scope_mismatch' | 'schema_changed' | 'kill_switch' | 'unowned' | 'owner_inactive';
}

export type GrantValidationResult = { ok: true; grant: McpGrant } | GrantValidationFailure;

const GRANT_TTL_MS = 60 * 60 * 1000; // 1h default; Settings → Agent access picks 15 min, 1 h, 4 h or 12 h per profile
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

// expires_at is stored as ISO ('T' separator); datetime('now') uses a space, so
// comparing them as text is wrong for the whole UTC day. Queries compare via
// julianday() on both sides instead.
function isoIn(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

// ── Dashboard auth state ─────────────────────────────────────────────────────

/**
 * Whether dashboard auth is on, read from the DB at the moment of the call.
 * Anything that mints a grant or an operation decides ownership with this,
 * never with a value read when the request started: a request can sit in
 * `await req.json()` while another one turns auth on, and a scope derived
 * before that switch has no owner (user_id null, role admin).
 */
export function isDashboardAuthEnabled(db: Database): boolean {
  const row = db.prepare(
    "SELECT value FROM dashboard_config WHERE key = 'auth_enabled'"
  ).get() as { value: string } | undefined;
  return row?.value === 'true';
}

/** Thrown when something tries to store a grant or operation with no owner while dashboard auth is on. */
export class OwnerlessScopeError extends Error {
  constructor(what: string) {
    super(`Refusing to store an ownerless ${what} while dashboard auth is on`);
    this.name = 'OwnerlessScopeError';
  }
}

/**
 * Why a stored grant's owner can no longer use it, or null if it can. With
 * auth on, a grant with no owner (minted while auth was off) is dead even if
 * a row survived the switch; a grant whose user has been deactivated (or
 * deleted) is dead even if the revoke on deactivation was missed. No
 * transport can act under either.
 */
export function grantOwnerProblem(db: Database, grant: Pick<McpGrant, 'user_id'>): 'unowned' | 'owner_inactive' | null {
  if (grant.user_id === null) return isDashboardAuthEnabled(db) ? 'unowned' : null;
  const user = db.prepare('SELECT is_active FROM dashboard_users WHERE id = @id').get({ id: grant.user_id }) as
    | { is_active: number }
    | undefined;
  return user && user.is_active ? null : 'owner_inactive';
}

export function grantOwnerAllowed(db: Database, grant: Pick<McpGrant, 'user_id'>): boolean {
  return grantOwnerProblem(db, grant) === null;
}

/**
 * Expiry columns (`expires_at`) hold ISO-8601 timestamps ("2026-10-02T12:00:00.000Z").
 * SQLite's `datetime('now')` renders "2026-10-02 12:00:00", and as text 'T' sorts
 * after ' ', so comparing the two treats a row that expires today as still live
 * until midnight. Every expiry comparison therefore binds an ISO `now` instead.
 */
function nowIso(): string {
  return new Date().toISOString();
}

/**
 * A stored timestamp as epoch ms. Rows written before P1 hold SQLite's
 * `YYYY-MM-DD HH:MM:SS` (UTC, second resolution); new grant and operation rows
 * hold ISO-8601 with milliseconds. Both are UTC. NaN for anything else.
 */
export function dbTimeMs(value: string | null | undefined): number {
  if (!value) return NaN;
  const iso = value.includes('T') ? value : value.replace(' ', 'T');
  return new Date(/(Z|[+-]\d\d:?\d\d)$/.test(iso) ? iso : `${iso}Z`).getTime();
}

/** SQLite `datetime('now')` format for a JS instant, for comparing with columns that default to it. */
function sqliteTime(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
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
  // Defence in depth: whatever route or helper got here, an ownerless grant
  // is never written while auth is on.
  if (params.userId === null && isDashboardAuthEnabled(db)) throw new OwnerlessScopeError('grant');
  const batchId = randomId();
  const expiresAt = isoIn(params.ttlMs ?? GRANT_TTL_MS);
  // created_at carries milliseconds so it can be ordered against `killSwitchEpoch`; the column default only has seconds.
  const createdAt = nowIso();
  const insert = db.prepare(`
    INSERT INTO mcp_grants (id, batch_id, tool_name, schema_digest, user_id, role, profile, origin, session_generation, created_at, expires_at)
    VALUES (@id, @batchId, @toolName, @schemaDigest, @userId, @role, @profile, @origin, @sessionGeneration, @createdAt, @expiresAt)
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
      createdAt,
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

/** Ownership filter: a grant belongs to one {user, profile, origin}. `user_id IS` matches NULL (auth off) too. */
export interface GrantOwner {
  userId: number | null;
  profile: string;
  origin: string;
}

const OWNER_SQL = 'user_id IS @ownerUserId AND profile = @ownerProfile AND origin = @ownerOrigin';

function ownerParams(owner: GrantOwner) {
  return { ownerUserId: owner.userId, ownerProfile: owner.profile, ownerOrigin: owner.origin };
}

export function listGrantsForSession(db: Database, sessionGeneration: string, owner?: GrantOwner): McpGrant[] {
  const epoch = getKillSwitchEpoch();
  const rows = db.prepare(`
    SELECT * FROM mcp_grants
    WHERE session_generation = @sessionGeneration AND revoked_at IS NULL AND julianday(expires_at) > julianday(@now)
      ${owner ? `AND ${OWNER_SQL}` : ''}
    ORDER BY tool_name
  `).all({ sessionGeneration, now: nowIso(), ...(owner ? ownerParams(owner) : {}) }) as McpGrant[];
  // Same rule as validateGrant: a grant made at or before the last kill-switch flip is dead, including one in a
  // profile whose rows the flip never touched. Listing it would show (and register) a tool that always fails.
  return epoch > 0 ? rows.filter((g) => dbTimeMs(g.created_at) > epoch) : rows;
}

/** Revoke one grant. With `owner`, only a grant that owner holds is touched. Returns the number of rows revoked. */
export function revokeGrant(db: Database, id: string, owner?: GrantOwner): number {
  const result = db.prepare(
    `UPDATE mcp_grants SET revoked_at = datetime('now') WHERE id = @id AND revoked_at IS NULL ${owner ? `AND ${OWNER_SQL}` : ''}`
  ).run({ id, ...(owner ? ownerParams(owner) : {}) });
  return (result as { changes: number }).changes;
}

export function revokeGrantsForSession(db: Database, sessionGeneration: string, owner?: GrantOwner): number {
  const result = db.prepare(
    `UPDATE mcp_grants SET revoked_at = datetime('now')
     WHERE session_generation = @sessionGeneration AND revoked_at IS NULL ${owner ? `AND ${OWNER_SQL}` : ''}`
  ).run({ sessionGeneration, ...(owner ? ownerParams(owner) : {}) });
  return (result as { changes: number }).changes;
}

/**
 * How many distinct session generations received grants for this user in the
 * last hour, and whether `sessionGeneration` is one of them. Feeds the
 * "10 new sessionGenerations per hour" limit, so rotating the (client-chosen)
 * session id cannot mint unlimited fresh rate-limit buckets.
 */
export function recentGrantSessions(db: Database, userId: number | null, sessionGeneration: string): { distinct: number; includesThis: boolean } {
  const rows = db.prepare(`
    SELECT DISTINCT session_generation FROM mcp_grants
    WHERE user_id IS @userId AND ((created_at LIKE '%T%' AND created_at >= @cutoff) OR (created_at NOT LIKE '%T%' AND created_at >= @cutoffSqlite))
  `).all({ userId, cutoff: new Date(Date.now() - 3_600_000).toISOString(), cutoffSqlite: sqliteTime(Date.now() - 3_600_000) }) as { session_generation: string }[];
  return { distinct: rows.length, includesThis: rows.some((r) => r.session_generation === sessionGeneration) };
}

/** Called on logout / token revocation so every grant tied to that dashboard user dies with the session. */
export function revokeGrantsForUser(db: Database, userId: number): number {
  const result = db.prepare(
    "UPDATE mcp_grants SET revoked_at = datetime('now') WHERE user_id = @userId AND revoked_at IS NULL"
  ).run({ userId });
  return (result as { changes: number }).changes;
}

/**
 * Delete grants that expired more than `graceDays` ago. Recently expired rows
 * stay so Activity can still show what a lapsed grant covered.
 */
export function cleanExpiredGrants(db: Database, graceDays = 7): number {
  const cutoff = new Date(Date.now() - graceDays * 24 * 60 * 60 * 1000).toISOString();
  const result = db.prepare('DELETE FROM mcp_grants WHERE julianday(expires_at) <= julianday(@cutoff)').run({ cutoff });
  return (result as { changes: number }).changes;
}

/** Delete approval tokens past their expiry. A token is single-use and minutes-long, so nothing needs them after that. */
export function cleanExpiredApprovalTokens(db: Database): number {
  const result = db.prepare('DELETE FROM mcp_approval_tokens WHERE julianday(expires_at) <= julianday(@now)').run({ now: nowIso() });
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
  // The kill switch is process-global: a grant made at or before its last flip is dead in every profile,
  // including one whose rows were never touched when the switch went off (threat T35).
  if (dbTimeMs(grant.created_at) <= getKillSwitchEpoch()) return { ok: false, reason: 'kill_switch' };
  const ownerProblem = grantOwnerProblem(db, grant);
  if (ownerProblem) return { ok: false, reason: ownerProblem };
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
    /** The quoted bank description for the card's own row (never part of `summary`). */
    bankData?: string | null;
    /** Defaults to `mutation`. */
    kind?: OperationKind;
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
  // A WebMCP / HTTP-MCP operation always runs under a grant, so with auth on it
  // must have an owner, and this refuses one that has none. A chat card is the
  // caller's to attribute: dashboard/chat.ts refuses to create one without a run
  // owner while auth is on. Whatever row ends up ownerless with auth on is
  // invisible to everyone (isOperationVisible in mcp/engine.ts): it is not
  // routed to admins, and nobody can approve it.
  if (params.userId === null && params.source !== 'chat' && isDashboardAuthEnabled(db)) {
    throw new OwnerlessScopeError('operation');
  }
  const id = randomId();
  const expiresAt = isoIn(params.ttlMs ?? OPERATION_TTL_MS);
  // created_at carries milliseconds: the approval dwell floor (1 s) is measured from it.
  db.prepare(`
    INSERT INTO mcp_operations (
      id, source, grant_id, tool_name, args_json, before_json, after_json, summary, bank_data, kind,
      transaction_id, revision_at_prepare, profile, origin, session_generation,
      user_id, role, status, created_at, expires_at
    ) VALUES (
      @id, @source, @grantId, @toolName, @argsJson, @beforeJson, @afterJson, @summary, @bankData, @kind,
      @transactionId, @revisionAtPrepare, @profile, @origin, @sessionGeneration,
      @userId, @role, 'pending', @createdAt, @expiresAt
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
    bankData: params.bankData ?? null,
    kind: params.kind ?? 'mutation',
    createdAt: nowIso(),
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
    SELECT * FROM mcp_operations WHERE status = 'pending' AND julianday(expires_at) > julianday(@now) ORDER BY created_at ASC
  `).all({ now: nowIso() }) as McpOperation[];
}

/** True once an operation's confirmation window has closed. Compared as instants, never as text. */
export function isOperationExpired(op: Pick<McpOperation, 'expires_at'>): boolean {
  return new Date(op.expires_at).getTime() <= Date.now();
}

/**
 * Whether an agent has live access for this user in this profile right now: an unrevoked, unexpired tab grant
 * (made after the last kill-switch flip), or a pending operation an agent raised. Computed on the server from
 * state a forging client cannot hide (a request header could simply be left out). The human REST routes an
 * agent could drive through the page (review confirm and correct, budget and goal edits) record it in their
 * audit row, so an after-the-fact reader can tell a person's click from one made while an agent was connected.
 */
export function isAgentPresent(db: Database, userId: number | null, profile: string): boolean {
  const epoch = getKillSwitchEpoch();
  const grants = db.prepare(`
    SELECT created_at FROM mcp_grants
    WHERE user_id IS @userId AND profile = @profile AND revoked_at IS NULL AND julianday(expires_at) > julianday(@now)
  `).all({ userId, profile, now: nowIso() }) as { created_at: string }[];
  if (grants.some((g) => epoch <= 0 || dbTimeMs(g.created_at) > epoch)) return true;
  const pending = db.prepare(`
    SELECT expires_at FROM mcp_operations
    WHERE user_id IS @userId AND profile = @profile AND status = 'pending' AND source != 'chat'
  `).all({ userId, profile }) as { expires_at: string }[];
  return pending.some((op) => !isOperationExpired(op));
}

/**
 * Whether the audit principal (a tab's hashed session, or a client token's id) held ANY grant, live, expired or
 * revoked, that was created at or after `sinceMs`. Used by the judge review flag, which must still say "an agent was
 * around" after the grant lapsed, was revoked or was killed. The principal id is a one-way hash of the session, so
 * the match is made by hashing each recent grant's session generation (a client token's session is `tok:<id>`).
 */
export function principalHeldGrantSince(db: Database, principalId: string, sinceMs: number): boolean {
  const rows = db.prepare('SELECT DISTINCT session_generation, created_at FROM mcp_grants').all() as Array<{ session_generation: string; created_at: string | null }>;
  return rows.some((g) => {
    if (!(dbTimeMs(g.created_at) >= sinceMs)) return false;
    return g.session_generation === `tok:${principalId}` || principalFor(g.session_generation).id === principalId;
  });
}

/**
 * User-level counterpart of `principalHeldGrantSince`, for a human action that has no proposing principal (an
 * annotation): did an agent have access for this user in this profile at any point since `sinceMs`? True when the
 * user held ANY grant (live, expired or revoked) created at or after `sinceMs`, raised a non-chat operation (any
 * status) created at or after it, or the kill switch was flipped at or after it (a flip kills grants without
 * deleting the fact that an agent was around).
 */
export function userHeldAgentSince(db: Database, userId: number | null, profile: string, sinceMs: number): boolean {
  const epoch = getKillSwitchEpoch();
  if (epoch > 0 && epoch >= sinceMs) return true;
  const grants = db.prepare('SELECT created_at FROM mcp_grants WHERE user_id IS @userId AND profile = @profile').all({ userId, profile }) as Array<{ created_at: string | null }>;
  if (grants.some((g) => dbTimeMs(g.created_at) >= sinceMs)) return true;
  const ops = db.prepare("SELECT created_at FROM mcp_operations WHERE user_id IS @userId AND profile = @profile AND source != 'chat'").all({ userId, profile }) as Array<{ created_at: string | null }>;
  return ops.some((op) => dbTimeMs(op.created_at) >= sinceMs);
}

/** Pending, unexpired operations raised by one principal (a tab's session generation). Chat is excluded. */
export function pendingCountForPrincipal(db: Database, sessionGeneration: string): number {
  const row = db.prepare(`
    SELECT COUNT(*) AS n FROM mcp_operations
    WHERE status = 'pending' AND julianday(expires_at) > julianday(@now) AND source != 'chat' AND session_generation = @sessionGeneration
  `).get({ now: nowIso(), sessionGeneration }) as { n: number };
  return row.n;
}

/** Pending, unexpired operations across every principal of one user (`null` = auth off). Chat is excluded. */
export function pendingCountForUser(db: Database, userId: number | null): number {
  const row = db.prepare(`
    SELECT COUNT(*) AS n FROM mcp_operations
    WHERE status = 'pending' AND julianday(expires_at) > julianday(@now) AND source != 'chat' AND user_id IS @userId
  `).get({ now: nowIso(), userId }) as { n: number };
  return row.n;
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

/**
 * Expire every still-pending operation from one source — e.g. chat cards whose
 * agent runner is gone (session replaced, server restarted), which nothing can
 * answer any more.
 */
export function expirePendingOperationsBySource(db: Database, source: OperationSource, reason: string): number {
  const rows = db.prepare(
    "SELECT id FROM mcp_operations WHERE status = 'pending' AND source = @source"
  ).all({ source }) as { id: string }[];
  for (const row of rows) {
    markOperationStatus(db, row.id, 'expired', { reason });
  }
  return rows.length;
}

/**
 * Expire one user's still-pending WebMCP / HTTP-MCP operations — e.g. when
 * that user is deactivated, so a write prepared under their grant can no
 * longer be approved by anyone.
 */
export function expirePendingOperationsForUser(db: Database, userId: number, reason: string): number {
  const rows = db.prepare(
    "SELECT id FROM mcp_operations WHERE status = 'pending' AND user_id = @userId AND source IN ('webmcp', 'http-mcp')"
  ).all({ userId }) as { id: string }[];
  for (const row of rows) {
    markOperationStatus(db, row.id, 'expired', { reason });
  }
  return rows.length;
}

/**
 * Sweep pending operations whose confirmation window has elapsed with nobody
 * acting on them. Each one leaves an `expired` audit row: the sweep runs on
 * every queue read, so most expiries are first noticed here, not by an
 * approve or reject call.
 */
export function expireStaleOperations(db: Database): number {
  clearStaleReadOutcomes(db);
  const rows = db.prepare(
    "SELECT * FROM mcp_operations WHERE status = 'pending' AND julianday(expires_at) <= julianday(@now)"
  ).all({ now: nowIso() }) as McpOperation[];
  for (const op of rows) {
    markOperationStatus(db, op.id, 'expired');
    try {
      appendAudit(db, {
        transport: 'rest',
        principalKind: 'user',
        principalId: `user:${op.user_id ?? 'anon'}`,
        userId: op.user_id,
        role: op.role,
        origin: op.origin,
        toolName: op.tool_name,
        classification: getToolDef(op.tool_name)?.classification ?? 'mutating',
        decision: 'expired',
        operationId: op.id,
        grantId: op.grant_id,
      });
    } catch (err) {
      console.error('[mcp-audit] failed to write expiry row:', err);
    }
  }
  return rows.length;
}

/** A read-ask result is held this long after the human approved it, then dropped whether or not the agent fetched it. */
export const READ_OUTCOME_TTL_MS = 5 * 60_000;

/**
 * Null the stored data of `kind='read'` operations committed more than 5 minutes
 * before `now` (threat T36). Only reads: a committed change keeps its outcome
 * as the record of what was written. Runs lazily on every operation read and in
 * `sweepOperations`. Returns the rows cleared.
 */
export function clearStaleReadOutcomes(db: Database, now: number = Date.now()): number {
  const result = db.prepare(`
    UPDATE mcp_operations SET outcome_json = NULL
    WHERE kind = 'read' AND status = 'committed' AND outcome_json IS NOT NULL AND resolved_at < @cutoff
  `).run({ cutoff: sqliteTime(now - READ_OUTCOME_TTL_MS) });
  return (result as { changes: number }).changes;
}

/** Drop a read operation's data once it has been delivered to the requesting agent (the status stays). */
export function clearReadOutcome(db: Database, id: string): void {
  db.prepare("UPDATE mcp_operations SET outcome_json = NULL WHERE id = @id AND kind = 'read' AND status = 'committed'").run({ id });
}

/**
 * Why a committed read's stored data must NOT be handed to the requester now, or `null` when it may be.
 * The human approved the read at a moment; the data waits for the agent's next poll. Anything that kills the
 * authority behind it in between must stop the delivery too:
 *  - a kill-switch flip at or after the approval (the epoch is process-global, so a flip made in ANOTHER profile
 *    never touched this database's rows);
 *  - the grant the call was made under is revoked, expired, re-keyed or itself older than a flip.
 * The approval instant is the later of `created_at` (millisecond) and `resolved_at` (second resolution), so an
 * approval made just after a flip in the same second is not mistaken for one made before it.
 */
export function readDeliveryRefusal(db: Database, op: McpOperation): string | null {
  const resolved = dbTimeMs(op.resolved_at ?? op.created_at);
  const created = dbTimeMs(op.created_at);
  const approvedAt = Math.max(Number.isFinite(resolved) ? resolved : 0, Number.isFinite(created) ? created : 0);
  if (approvedAt <= getKillSwitchEpoch()) return 'kill_switch';
  if (op.grant_id) {
    const check = validateGrant(db, op.grant_id, op.tool_name, schemaDigest(op.tool_name), {
      userId: op.user_id,
      role: op.role,
      profile: op.profile,
      origin: op.origin,
      sessionGeneration: op.session_generation,
    });
    if (!check.ok) return check.reason;
  }
  return null;
}

/**
 * Revoke every live grant in this database: all users, tabs and client tokens. Used by the kill switch, and when
 * dashboard auth is turned on (grants minted while it was off carry no user and must not outlive the switch).
 * Returns rows revoked.
 */
export function revokeAllGrants(db: Database): number {
  const result = db.prepare("UPDATE mcp_grants SET revoked_at = datetime('now') WHERE revoked_at IS NULL").run();
  return (result as { changes: number }).changes;
}

/**
 * Reject every pending operation that came through an agent transport (WebMCP tab or /mcp client),
 * recording why. Dashboard chat operations are the user's own chat and are left alone.
 */
export function rejectPendingAgentOperations(db: Database, reason: string): string[] {
  const rows = db.prepare("SELECT id FROM mcp_operations WHERE status = 'pending' AND source != 'chat'").all() as { id: string }[];
  for (const { id } of rows) markOperationStatus(db, id, 'rejected', { reason });
  return rows.map((r) => r.id);
}

/**
 * Housekeeping: delete resolved operations older than `retainDays` (default 7).
 * Pending operations are never deleted here (they expire first). Approval
 * tokens go with their operation (ON DELETE CASCADE).
 */
export function sweepOperations(db: Database, retainDays = 7): number {
  expireStaleOperations(db);
  const result = db.prepare(`
    DELETE FROM mcp_operations
    WHERE status != 'pending' AND resolved_at IS NOT NULL AND resolved_at < datetime('now', @offset)
  `).run({ offset: `-${Math.max(0, Math.floor(retainDays))} days` });
  return (result as { changes: number }).changes;
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
