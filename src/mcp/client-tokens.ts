/**
 * Dedicated bearer tokens for external MCP clients on `/mcp` (threat model T06, T07).
 *
 * Until now the `/mcp` bearer was the tab's own `sessionGeneration`: a value any
 * page script or extension can read, with no lifetime of its own. A client token
 * is its own credential:
 *
 *  - `wmcp_` + base64url(32 random bytes), shown ONCE at mint. Only its sha256 and
 *    a 12-character display prefix are stored. No read path returns either.
 *  - Its tools are `mcp_grants` rows with session_generation `tok:<id>` and origin
 *    `http-mcp-client`, expiring with the token. Only tools whose `transports`
 *    include `http-mcp` can be granted.
 *  - While dashboard auth is off a token may carry read tools only: without auth the
 *    client could approve its own cards with `curl`, so the human gate would be
 *    fiction. Viewers may mint read tools only.
 *  - Every use re-reads the owner (`dashboard_users`) so a deactivated user's token
 *    stops working with no sweep. Tokens live in the per-profile database, so a
 *    profile switch makes them unknown (401).
 *  - Revoke and rotate take effect immediately.
 */
import { retiredNameHint } from './tool-names.js';
import { createHash, randomBytes } from 'node:crypto';
import type { Database } from '../db/compat-sqlite.js';
import { isAuthEnabled } from '../dashboard/auth.js';
import { createGrants, dbTimeMs, listGrantsForSession, revokeGrantsForSession, type McpGrant, type Role } from './store.js';
import { KILL_SWITCH_MESSAGE, getKillSwitchEpoch, isAgentAccessEnabled } from './global-state.js';
import { getToolDef, isWriteTool, schemaDigest, type McpToolDef } from './tool-catalog.js';
import { getEffectivePolicy } from './policies.js';
import { hasHiddenChars } from './output.js';
import type { RequestScope } from './engine.js';

export const CLIENT_TOKEN_PREFIX = 'wmcp_';
/** The fixed origin bound into grants made for external clients (they have no browser Origin). */
export const HTTP_MCP_ORIGIN = 'http-mcp-client';
export const TOKEN_EXPIRY_DAYS = [1, 7, 30, 90] as const;
export const DEFAULT_TOKEN_EXPIRY_DAYS = 30;
export const MAX_TOKEN_NAME = 40;
/** `last_used_at` is refreshed at most this often, so a busy client does not write on every request. */
const TOUCH_INTERVAL_MS = 60_000;
const DAY_MS = 86_400_000;

export interface TokenOwner {
  userId: number | null;
  role: Role;
  profile: string;
  authEnabled: boolean;
}

/** Who is asking to list, revoke or rotate. With auth off every local session is the same (admin) viewer. */
export interface TokenViewer {
  userId: number | null;
  role: Role;
  authEnabled: boolean;
}

export interface ClientTokenMeta {
  id: string;
  name: string;
  token_prefix: string;
  /** Tools of the token's live grants; empty once revoked or expired. */
  tools: string[];
  created_at: string;
  expires_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export interface TokenFailure {
  ok: false;
  status: number;
  code: 'invalid_args' | 'unknown_tool' | 'role_forbidden' | 'not_found' | 'kill_switch';
  error: string;
}

export type MintResult = { ok: true; token: string; meta: ClientTokenMeta } | TokenFailure;

interface TokenRow {
  id: string;
  name: string;
  token_hash: string;
  token_prefix: string;
  user_id: number | null;
  role: Role;
  created_at: string;
  expires_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  rotated_from: string | null;
}

const sha256Hex = (value: string) => createHash('sha256').update(value).digest('hex');
const tokenSession = (id: string) => `tok:${id}`;

function failure(status: number, code: TokenFailure['code'], error: string): TokenFailure {
  return { ok: false, status, code, error };
}

/**
 * The rules every mint and rotate applies to a tool list. `lookup` is the catalog
 * by default; tests pass their own to cover a tool that exists only in the tab.
 * Returns null when the list is allowed.
 */
export function checkTokenTools(
  tools: string[],
  owner: { role: Role; authEnabled: boolean },
  lookup: (name: string) => Pick<McpToolDef, 'classification' | 'transports'> | undefined = getToolDef
): TokenFailure | null {
  const unknown = tools.filter((name) => !lookup(name));
  if (unknown.length > 0) {
    // A retired name grants nothing: 404, with the new name in the message so the caller can fix the list.
    const hinted = unknown.filter((n) => retiredNameHint(n));
    return failure(
      hinted.length > 0 ? 404 : 400,
      'unknown_tool',
      `Unknown tool(s): ${unknown.map((n) => `${n.slice(0, 30)}${retiredNameHint(n) ? `: ${retiredNameHint(n)}` : ''}`).join(', ')}`
    );
  }

  const tabOnly = tools.filter((name) => !lookup(name)!.transports.includes('http-mcp'));
  if (tabOnly.length > 0) {
    return failure(400, 'invalid_args', `${tabOnly[0].slice(0, 30)} only works inside the dashboard tab and cannot be given to an external client.`);
  }

  const writers = tools.filter((name) => isWriteTool(lookup(name)!));
  if (writers.length > 0) {
    // Viewers first: it is the more specific refusal and it holds with auth on or off.
    if (owner.role !== 'admin') {
      return failure(403, 'role_forbidden', `Viewer accounts can only mint read-only tools: ${writers.join(', ')}`);
    }
    if (!owner.authEnabled) {
      return failure(400, 'invalid_args', 'Enable dashboard auth to let external clients propose changes.');
    }
  }
  return null;
}

function normalizeName(raw: string): string | null {
  const name = raw.trim();
  if (name.length === 0 || name.length > MAX_TOKEN_NAME) return null;
  if (hasHiddenChars(name)) return null;
  return name;
}

function metaOf(db: Database, row: TokenRow): ClientTokenMeta {
  const tools = listGrantsForSession(db, tokenSession(row.id)).map((g) => g.tool_name);
  return {
    id: row.id,
    name: row.name,
    token_prefix: row.token_prefix,
    tools,
    created_at: row.created_at,
    expires_at: row.expires_at,
    last_used_at: row.last_used_at,
    revoked_at: row.revoked_at,
  };
}

/**
 * A token minted before the last kill-switch flip is dead in every profile, like a grant. The flip revokes the
 * token rows of the profile it ran in; this covers a token in a profile whose database was not open then.
 * `created_at` has one-second resolution, so a token counts as made at the END of its second: never dead by mistake.
 */
function killedBySwitch(row: TokenRow): boolean {
  return dbTimeMs(row.created_at) + 1000 <= getKillSwitchEpoch();
}

function getRow(db: Database, id: string): TokenRow | null {
  return (db.prepare('SELECT * FROM mcp_client_tokens WHERE id = @id').get({ id }) as TokenRow | undefined) ?? null;
}

function insertToken(
  db: Database,
  owner: TokenOwner,
  input: { name: string; tools: string[]; expiresInDays: number; rotatedFrom?: string }
): MintResult {
  // While the switch is off every tool reads as Off; say so, instead of pointing at the policy table.
  if (!isAgentAccessEnabled()) return failure(403, 'kill_switch', KILL_SWITCH_MESSAGE);
  const name = normalizeName(input.name);
  if (!name) return failure(400, 'invalid_args', `Token name must be 1-${MAX_TOKEN_NAME} visible characters.`);
  const tools = [...new Set(input.tools)];
  if (tools.length === 0) return failure(400, 'invalid_args', 'Choose at least one tool for this token.');
  if (!(TOKEN_EXPIRY_DAYS as readonly number[]).includes(input.expiresInDays)) {
    return failure(400, 'invalid_args', `expiresInDays must be one of ${TOKEN_EXPIRY_DAYS.join(', ')}.`);
  }
  const refused = checkTokenTools(tools, owner);
  if (refused) return refused;
  // Off means not grantable, for an external client as for a tab.
  const off = tools.filter((name) => getEffectivePolicy(db, owner.userId, name) === 'off');
  if (off.length > 0) {
    return failure(400, 'invalid_args', `${off.map((n) => `"${n}"`).join(', ')} ${off.length === 1 ? 'is' : 'are'} turned off in your policies. Turn ${off.length === 1 ? 'it' : 'them'} on first.`);
  }

  const id = crypto.randomUUID();
  const token = CLIENT_TOKEN_PREFIX + randomBytes(32).toString('base64url');
  const ttlMs = input.expiresInDays * DAY_MS;
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();

  db.transaction(() => {
    db.prepare(`
      INSERT INTO mcp_client_tokens (id, name, token_hash, token_prefix, user_id, role, expires_at, rotated_from)
      VALUES (@id, @name, @hash, @prefix, @userId, @role, @expiresAt, @rotatedFrom)
    `).run({
      id,
      name,
      hash: sha256Hex(token),
      prefix: token.slice(0, 12),
      userId: owner.userId,
      role: owner.role,
      expiresAt,
      rotatedFrom: input.rotatedFrom ?? null,
    });
    createGrants(db, {
      tools: tools.map((t) => ({ name: t, schemaDigest: schemaDigest(t) })),
      userId: owner.userId,
      role: owner.role,
      profile: owner.profile,
      origin: HTTP_MCP_ORIGIN,
      sessionGeneration: tokenSession(id),
      ttlMs,
    });
  })();

  return { ok: true, token, meta: metaOf(db, getRow(db, id)!) };
}

/** Mint a token. The plaintext is in the result and nowhere else: keep it out of logs. */
export function mintClientToken(
  db: Database,
  owner: TokenOwner,
  input: { name: string; tools: string[]; expiresInDays?: number }
): MintResult {
  return insertToken(db, owner, { ...input, expiresInDays: input.expiresInDays ?? DEFAULT_TOKEN_EXPIRY_DAYS });
}

/** A token is visible to its owner and to admins. With auth off every local session sees them all. */
function isVisible(row: TokenRow, viewer: TokenViewer): boolean {
  if (!viewer.authEnabled) return true;
  return viewer.role === 'admin' || (row.user_id !== null && row.user_id === viewer.userId);
}

export function listClientTokens(db: Database, viewer: TokenViewer): ClientTokenMeta[] {
  const rows = db.prepare('SELECT * FROM mcp_client_tokens ORDER BY created_at DESC, rowid DESC').all() as TokenRow[];
  return rows.filter((r) => isVisible(r, viewer)).map((r) => metaOf(db, r));
}

/** Revoke a token and its grants at once. False when it does not exist, is not visible, or is already revoked. */
export function revokeClientToken(db: Database, id: string, viewer: TokenViewer): boolean {
  const row = getRow(db, id);
  if (!row || row.revoked_at || !isVisible(row, viewer)) return false;
  db.transaction(() => {
    db.prepare('UPDATE mcp_client_tokens SET revoked_at = @now WHERE id = @id AND revoked_at IS NULL').run({ id, now: new Date().toISOString() });
    revokeGrantsForSession(db, tokenSession(id));
  })();
  return true;
}

/**
 * Mint a replacement with the same name and tools (the mint rules are applied
 * again, against the owner's CURRENT role and the current auth state), then
 * revoke the old token, in one transaction: on a refusal the old token is kept.
 * Null when the token is not visible, revoked or expired, or when the viewer is
 * not its owner: the replacement is attributed to the owner, so an admin who
 * could see it must not be able to obtain a working credential for another
 * user (an admin can still revoke it).
 */
export function rotateClientToken(db: Database, id: string, viewer: TokenViewer, profile: string): MintResult | null {
  const row = getRow(db, id);
  if (!row || row.revoked_at || killedBySwitch(row) || !isVisible(row, viewer) || new Date(row.expires_at).getTime() <= Date.now()) return null;
  if (row.user_id !== viewer.userId) return null;

  let role: Role = row.role;
  if (row.user_id !== null) {
    const owner = db.prepare('SELECT role, is_active FROM dashboard_users WHERE id = @id').get({ id: row.user_id }) as { role: Role; is_active: number } | undefined;
    if (!owner || !owner.is_active) return null;
    role = owner.role;
  }
  const tools = listGrantsForSession(db, tokenSession(id)).map((g) => g.tool_name);
  // The replacement lives as long as the original was minted for (nearest allowed lifetime).
  const createdMs = new Date(`${row.created_at.replace(' ', 'T')}${row.created_at.endsWith('Z') ? '' : 'Z'}`).getTime();
  const lifetimeDays = (new Date(row.expires_at).getTime() - createdMs) / DAY_MS;
  const expiresInDays = TOKEN_EXPIRY_DAYS.reduce((best, d) => (Math.abs(d - lifetimeDays) < Math.abs(best - lifetimeDays) ? d : best));

  let result: MintResult = failure(400, 'invalid_args', 'rotate failed');
  db.transaction(() => {
    result = insertToken(db, { userId: row.user_id, role, profile, authEnabled: isAuthEnabled(db) }, { name: row.name, tools, expiresInDays, rotatedFrom: id });
    if (!result.ok) return;
    db.prepare('UPDATE mcp_client_tokens SET revoked_at = @now WHERE id = @id AND revoked_at IS NULL').run({ id, now: new Date().toISOString() });
    revokeGrantsForSession(db, tokenSession(id));
  })();
  return result;
}

/**
 * Change which tools a token carries: the grant set is re-issued (same token, same expiry), with
 * the mint rules applied again against the owner's CURRENT role and the current auth state, and a
 * tool the owner has turned Off cannot be added. All or nothing: on a refusal the old set stays.
 * Null when the token is not visible, not the viewer's own (as with rotate, only the owner may
 * change what a credential can do), revoked or expired.
 */
export type UpdateToolsResult = { ok: true; meta: ClientTokenMeta } | TokenFailure;

export function updateClientTokenTools(db: Database, id: string, viewer: TokenViewer, tools: string[], profile: string): UpdateToolsResult | null {
  if (!isAgentAccessEnabled()) return failure(403, 'kill_switch', KILL_SWITCH_MESSAGE);
  const row = getRow(db, id);
  if (!row || row.revoked_at || killedBySwitch(row) || !isVisible(row, viewer) || new Date(row.expires_at).getTime() <= Date.now()) return null;
  if (row.user_id !== viewer.userId) return null;

  const wanted = [...new Set(tools)];
  if (wanted.length === 0) return failure(400, 'invalid_args', 'Choose at least one tool for this token.');

  let role: Role = row.role;
  if (row.user_id !== null) {
    const owner = db.prepare('SELECT role, is_active FROM dashboard_users WHERE id = @id').get({ id: row.user_id }) as { role: Role; is_active: number } | undefined;
    if (!owner || !owner.is_active) return null;
    role = owner.role;
  }
  const refused = checkTokenTools(wanted, { role, authEnabled: isAuthEnabled(db) });
  if (refused) return refused;
  const off = wanted.filter((name) => getEffectivePolicy(db, row.user_id, name) === 'off');
  if (off.length > 0) {
    return failure(400, 'invalid_args', `${off.map((n) => `"${n}"`).join(', ')} ${off.length === 1 ? 'is' : 'are'} turned off in your policies. Turn ${off.length === 1 ? 'it' : 'them'} on first.`);
  }

  db.transaction(() => {
    revokeGrantsForSession(db, tokenSession(id));
    createGrants(db, {
      tools: wanted.map((t) => ({ name: t, schemaDigest: schemaDigest(t) })),
      userId: row.user_id,
      role: row.role,
      profile,
      origin: HTTP_MCP_ORIGIN,
      sessionGeneration: tokenSession(id),
      ttlMs: Math.max(1000, new Date(row.expires_at).getTime() - Date.now()),
    });
  })();
  return { ok: true, meta: metaOf(db, getRow(db, id)!) };
}

export interface ResolvedClientToken {
  id: string;
  name: string;
  /** The owner's role right now (`admin` when the token has no owner). Visibility and role gates use this. */
  liveRole: Role;
  /**
   * The scope its calls run under: the role the token's grants were minted with (a grant only
   * validates against that), the owner, the current profile, the fixed client origin and
   * `tok:<id>`. Demotion is still enforced: `callTool` re-reads the owner's live role for every
   * admin-only tool, and `liveRole` hides those tools from `tools/list`.
   */
  scope: RequestScope;
  grants: McpGrant[];
  grantByTool: Map<string, string>;
}

/**
 * Resolve a bearer to its token, or null when it is not a live token of this
 * profile database: missing, wrong prefix, unknown, revoked, expired, or owned
 * by a user who is gone or deactivated. A token with no owner (minted while
 * auth was off) stops working once auth is enabled. A lookup by sha256 costs the
 * same whether the token exists or not. Refreshes `last_used_at` at most once a minute.
 */
export function resolveClientToken(db: Database, bearer: string | null, profile: string): ResolvedClientToken | null {
  if (!bearer || !bearer.startsWith(CLIENT_TOKEN_PREFIX)) return null;
  const row = db.prepare('SELECT * FROM mcp_client_tokens WHERE token_hash = @hash').get({ hash: sha256Hex(bearer) }) as TokenRow | undefined;
  if (!row || row.revoked_at || killedBySwitch(row)) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) return null;

  let liveRole: Role = 'admin';
  if (row.user_id !== null) {
    const user = db.prepare('SELECT role, is_active FROM dashboard_users WHERE id = @id').get({ id: row.user_id }) as { role: Role; is_active: number } | undefined;
    if (!user || !user.is_active) return null;
    liveRole = user.role;
  } else if (isAuthEnabled(db)) {
    return null;
  }

  const now = Date.now();
  db.prepare('UPDATE mcp_client_tokens SET last_used_at = @now WHERE id = @id AND (last_used_at IS NULL OR last_used_at <= @cutoff)').run({
    id: row.id,
    now: new Date(now).toISOString(),
    cutoff: new Date(now - TOUCH_INTERVAL_MS).toISOString(),
  });

  const session = tokenSession(row.id);
  const grants = listGrantsForSession(db, session);
  return {
    id: row.id,
    name: row.name,
    liveRole,
    scope: { role: row.role, userId: row.user_id, profile, origin: HTTP_MCP_ORIGIN, sessionGeneration: session, tokenId: row.id },
    grants,
    grantByTool: new Map(grants.map((g) => [g.tool_name, g.id])),
  };
}

/** The label of the token behind a `tok:<id>` session generation, for the approval card. Null for anything else. */
export function clientTokenName(db: Database, sessionGeneration: string): string | null {
  if (!sessionGeneration.startsWith('tok:')) return null;
  const row = db.prepare('SELECT name FROM mcp_client_tokens WHERE id = @id').get({ id: sessionGeneration.slice(4) }) as { name: string } | undefined;
  return row?.name ?? null;
}
