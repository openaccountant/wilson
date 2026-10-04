import type { Database } from '../db/compat-sqlite.js';
import {
  revokeAllGrants,
  revokeGrantsForUser,
  expirePendingOperationsBySource,
  expirePendingOperationsForUser,
  isDashboardAuthEnabled,
} from '../mcp/store.js';

export interface DashboardUser {
  id: number;
  username: string;
  role: 'admin' | 'viewer';
  is_active: number;
  created_at: string;
  updated_at: string;
}

/**
 * Whether a dashboard role may change data. The one RBAC rule for writes:
 * every REST write route, and approving a chat agent's mutating tool call
 * (#156), require it.
 */
export function canWrite(role: DashboardUser['role']): boolean {
  return role === 'admin';
}

// ── Config ──────────────────────────────────────────────────────────────────

/** Read fresh from the DB on every call — see isDashboardAuthEnabled. */
export function isAuthEnabled(db: Database): boolean {
  return isDashboardAuthEnabled(db);
}

/**
 * Turn dashboard auth on. On the off -> on transition every WebMCP / HTTP-MCP
 * grant is revoked and every pending WebMCP / HTTP-MCP operation expired:
 * anything minted while auth was off has no owner (user_id null, role admin)
 * and would otherwise keep working, unattributed, under the new login rules.
 * Admins grant again afterwards. Re-enabling while already on changes nothing.
 * (Chat cards are not touched here: they answer a live chat run, and with
 * auth on an unowned one is visible and approvable only by an admin.)
 */
export function enableAuth(db: Database): void {
  if (isAuthEnabled(db)) return;
  revokeAllGrants(db);
  expirePendingOperationsBySource(db, 'webmcp', 'auth_enabled');
  expirePendingOperationsBySource(db, 'http-mcp', 'auth_enabled');
  db.prepare(
    "INSERT OR REPLACE INTO dashboard_config (key, value) VALUES ('auth_enabled', 'true')"
  ).run();
}

export function disableAuth(db: Database): void {
  db.prepare(
    "INSERT OR REPLACE INTO dashboard_config (key, value) VALUES ('auth_enabled', 'false')"
  ).run();
}

/** True when at least one active admin account exists, i.e. someone can actually log in and manage the dashboard. */
export function hasActiveAdmin(db: Database): boolean {
  const row = db.prepare("SELECT 1 AS ok FROM dashboard_users WHERE role = 'admin' AND is_active = 1 LIMIT 1").get();
  return !!row;
}

/**
 * The precondition for serving a profile over the network: the auth flag is on
 * AND an active admin exists. The flag alone is not enough, because with zero
 * users `/api/auth/setup` is public and the first caller would become admin.
 */
export function lanAuthReady(db: Database): boolean {
  return isAuthEnabled(db) && hasActiveAdmin(db);
}

// ── Users ───────────────────────────────────────────────────────────────────

export function hashPassword(password: string): Promise<string> {
  return Bun.password.hash(password, 'argon2id');
}

/** Insert a user from an already-computed hash. Synchronous, so a caller can check state and insert with no await in between. */
export function insertUser(
  db: Database,
  username: string,
  passwordHash: string,
  role: 'admin' | 'viewer' = 'viewer'
): DashboardUser {
  const result = db.prepare(`
    INSERT INTO dashboard_users (username, password_hash, role)
    VALUES (@username, @passwordHash, @role)
  `).run({ username, passwordHash, role });
  const id = (result as { lastInsertRowid: number }).lastInsertRowid;
  return getUser(db, id)!;
}

export async function createUser(
  db: Database,
  username: string,
  password: string,
  role: 'admin' | 'viewer' = 'viewer'
): Promise<DashboardUser> {
  return insertUser(db, username, await hashPassword(password), role);
}

/**
 * First-run setup: create the admin and turn auth on, but only if there is
 * still no user at the moment of writing. The count check, the insert and
 * enableAuth run in one transaction with no await between them, so of two
 * concurrent setups (each having passed an early check, then awaited its body
 * and the password hash) exactly one wins; the other gets null.
 */
export function createFirstAdmin(db: Database, username: string, passwordHash: string): DashboardUser | null {
  return db.transaction(() => {
    if (getUserCount(db) > 0) return null;
    const user = insertUser(db, username, passwordHash, 'admin');
    enableAuth(db);
    return user;
  })();
}

export function getUser(db: Database, id: number): DashboardUser | undefined {
  return db.prepare(
    'SELECT id, username, role, is_active, created_at, updated_at FROM dashboard_users WHERE id = @id'
  ).get({ id }) as DashboardUser | undefined;
}

export function getUserByUsername(db: Database, username: string): DashboardUser | undefined {
  return db.prepare(
    'SELECT id, username, role, is_active, created_at, updated_at FROM dashboard_users WHERE username = @username'
  ).get({ username }) as DashboardUser | undefined;
}

export function listUsers(db: Database): DashboardUser[] {
  return db.prepare(
    'SELECT id, username, role, is_active, created_at, updated_at FROM dashboard_users ORDER BY id'
  ).all() as DashboardUser[];
}

export function getUserCount(db: Database): number {
  const row = db.prepare('SELECT COUNT(*) AS count FROM dashboard_users').get() as { count: number };
  return row.count;
}

/**
 * Deactivate a user and end their MCP access with them: every WebMCP /
 * HTTP-MCP grant they hold is revoked and every pending operation prepared
 * under one is expired, so an external client holding their bearer token
 * sees no tools and nothing they queued can still be approved.
 */
export function deactivateUser(db: Database, id: number): boolean {
  return db.transaction(() => {
    const result = db.prepare(
      "UPDATE dashboard_users SET is_active = 0, updated_at = datetime('now') WHERE id = @id"
    ).run({ id });
    if ((result as { changes: number }).changes === 0) return false;
    revokeGrantsForUser(db, id);
    expirePendingOperationsForUser(db, id, 'user_deactivated');
    return true;
  })();
}

// ── Sessions ────────────────────────────────────────────────────────────────

function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function verifyLogin(
  db: Database,
  username: string,
  password: string
): Promise<{ token: string; user: DashboardUser } | null> {
  const row = db.prepare(
    'SELECT id, username, password_hash, role, is_active, created_at, updated_at FROM dashboard_users WHERE username = @username'
  ).get({ username }) as (DashboardUser & { password_hash: string }) | undefined;

  if (!row || !row.is_active) return null;

  const valid = await Bun.password.verify(password, row.password_hash);
  if (!valid) return null;

  const token = generateToken();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  db.prepare(`
    INSERT INTO dashboard_sessions (token, user_id, expires_at)
    VALUES (@token, @userId, @expiresAt)
  `).run({ token, userId: row.id, expiresAt });

  const { password_hash: _, ...user } = row;
  return { token, user };
}

export function validateToken(db: Database, token: string): DashboardUser | null {
  const row = db.prepare(`
    SELECT u.id, u.username, u.role, u.is_active, u.created_at, u.updated_at
    FROM dashboard_sessions s
    JOIN dashboard_users u ON u.id = s.user_id
    WHERE s.token = @token AND s.expires_at > datetime('now') AND u.is_active = 1
  `).get({ token }) as DashboardUser | undefined;
  return row ?? null;
}

export function revokeToken(db: Database, token: string): void {
  db.prepare('DELETE FROM dashboard_sessions WHERE token = @token').run({ token });
}

export function cleanExpiredSessions(db: Database): number {
  const result = db.prepare(
    "DELETE FROM dashboard_sessions WHERE expires_at <= datetime('now')"
  ).run();
  return (result as { changes: number }).changes;
}
