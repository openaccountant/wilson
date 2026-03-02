import type { Database } from '../db/compat-sqlite.js';

export interface DashboardUser {
  id: number;
  username: string;
  role: 'admin' | 'viewer';
  is_active: number;
  created_at: string;
  updated_at: string;
}

// ── Config ──────────────────────────────────────────────────────────────────

export function isAuthEnabled(db: Database): boolean {
  const row = db.prepare(
    "SELECT value FROM dashboard_config WHERE key = 'auth_enabled'"
  ).get() as { value: string } | undefined;
  return row?.value === 'true';
}

export function enableAuth(db: Database): void {
  db.prepare(
    "INSERT OR REPLACE INTO dashboard_config (key, value) VALUES ('auth_enabled', 'true')"
  ).run();
}

export function disableAuth(db: Database): void {
  db.prepare(
    "INSERT OR REPLACE INTO dashboard_config (key, value) VALUES ('auth_enabled', 'false')"
  ).run();
}

// ── Users ───────────────────────────────────────────────────────────────────

export async function createUser(
  db: Database,
  username: string,
  password: string,
  role: 'admin' | 'viewer' = 'viewer'
): Promise<DashboardUser> {
  const passwordHash = await Bun.password.hash(password, 'argon2id');
  const result = db.prepare(`
    INSERT INTO dashboard_users (username, password_hash, role)
    VALUES (@username, @passwordHash, @role)
  `).run({ username, passwordHash, role });
  const id = (result as { lastInsertRowid: number }).lastInsertRowid;
  return getUser(db, id)!;
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

export function deactivateUser(db: Database, id: number): boolean {
  const result = db.prepare(
    "UPDATE dashboard_users SET is_active = 0, updated_at = datetime('now') WHERE id = @id"
  ).run({ id });
  return (result as { changes: number }).changes > 0;
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
