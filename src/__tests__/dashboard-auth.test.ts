import { describe, expect, test } from 'bun:test';
import { createTestDb } from './helpers.js';
import {
  isAuthEnabled, enableAuth, disableAuth,
  createUser, getUser, getUserByUsername, listUsers, getUserCount, deactivateUser,
  verifyLogin, validateToken, revokeToken, cleanExpiredSessions,
  type DashboardUser,
} from '../dashboard/auth.js';

describe('dashboard auth', () => {
  // ── Config ───────────────────────────────────────────────────────────────

  describe('auth config', () => {
    test('auth disabled by default', () => {
      const db = createTestDb();
      expect(isAuthEnabled(db)).toBe(false);
    });

    test('enableAuth sets auth_enabled to true', () => {
      const db = createTestDb();
      enableAuth(db);
      expect(isAuthEnabled(db)).toBe(true);
    });

    test('disableAuth sets auth_enabled to false', () => {
      const db = createTestDb();
      enableAuth(db);
      expect(isAuthEnabled(db)).toBe(true);
      disableAuth(db);
      expect(isAuthEnabled(db)).toBe(false);
    });

    test('enable/disable are idempotent', () => {
      const db = createTestDb();
      enableAuth(db);
      enableAuth(db);
      expect(isAuthEnabled(db)).toBe(true);
      disableAuth(db);
      disableAuth(db);
      expect(isAuthEnabled(db)).toBe(false);
    });
  });

  // ── Users ────────────────────────────────────────────────────────────────

  describe('user management', () => {
    test('createUser returns user with admin role', async () => {
      const db = createTestDb();
      const user = await createUser(db, 'admin1', 'secret123', 'admin');
      expect(user.username).toBe('admin1');
      expect(user.role).toBe('admin');
      expect(user.is_active).toBe(1);
      expect(user.id).toBeGreaterThan(0);
    });

    test('createUser defaults to viewer role', async () => {
      const db = createTestDb();
      const user = await createUser(db, 'viewer1', 'password');
      expect(user.role).toBe('viewer');
    });

    test('createUser rejects duplicate username', async () => {
      const db = createTestDb();
      await createUser(db, 'user1', 'pass1');
      await expect(createUser(db, 'user1', 'pass2')).rejects.toThrow();
    });

    test('getUser returns user by ID', async () => {
      const db = createTestDb();
      const created = await createUser(db, 'lookup', 'pass');
      const found = getUser(db, created.id);
      expect(found).toBeDefined();
      expect(found!.username).toBe('lookup');
    });

    test('getUser returns falsy for unknown ID', () => {
      const db = createTestDb();
      expect(getUser(db, 9999)).toBeFalsy();
    });

    test('getUserByUsername returns user', async () => {
      const db = createTestDb();
      await createUser(db, 'findme', 'pass');
      const found = getUserByUsername(db, 'findme');
      expect(found).toBeDefined();
      expect(found!.username).toBe('findme');
    });

    test('getUserByUsername returns falsy for unknown', () => {
      const db = createTestDb();
      expect(getUserByUsername(db, 'ghost')).toBeFalsy();
    });

    test('listUsers returns all users', async () => {
      const db = createTestDb();
      await createUser(db, 'alice', 'pass', 'admin');
      await createUser(db, 'bob', 'pass', 'viewer');
      const users = listUsers(db);
      expect(users).toHaveLength(2);
      expect(users[0].username).toBe('alice');
      expect(users[1].username).toBe('bob');
    });

    test('getUserCount returns count', async () => {
      const db = createTestDb();
      expect(getUserCount(db)).toBe(0);
      await createUser(db, 'a', 'pass');
      expect(getUserCount(db)).toBe(1);
      await createUser(db, 'b', 'pass');
      expect(getUserCount(db)).toBe(2);
    });

    test('deactivateUser sets is_active to 0', async () => {
      const db = createTestDb();
      const user = await createUser(db, 'todeactivate', 'pass');
      const success = deactivateUser(db, user.id);
      expect(success).toBe(true);
      const after = getUser(db, user.id);
      expect(after!.is_active).toBe(0);
    });

    test('deactivateUser returns false for unknown ID', () => {
      const db = createTestDb();
      expect(deactivateUser(db, 9999)).toBe(false);
    });
  });

  // ── Authentication ───────────────────────────────────────────────────────

  describe('login and tokens', () => {
    test('verifyLogin succeeds with correct credentials', async () => {
      const db = createTestDb();
      await createUser(db, 'testuser', 'correctpassword', 'admin');
      const result = await verifyLogin(db, 'testuser', 'correctpassword');
      expect(result).not.toBeNull();
      expect(result!.token).toHaveLength(64);
      expect(result!.user.username).toBe('testuser');
      expect(result!.user.role).toBe('admin');
    });

    test('verifyLogin fails with wrong password', async () => {
      const db = createTestDb();
      await createUser(db, 'testuser', 'correctpassword');
      const result = await verifyLogin(db, 'testuser', 'wrongpassword');
      expect(result).toBeNull();
    });

    test('verifyLogin fails for unknown user', async () => {
      const db = createTestDb();
      const result = await verifyLogin(db, 'nobody', 'pass');
      expect(result).toBeNull();
    });

    test('verifyLogin fails for deactivated user', async () => {
      const db = createTestDb();
      const user = await createUser(db, 'deactivated', 'pass');
      deactivateUser(db, user.id);
      const result = await verifyLogin(db, 'deactivated', 'pass');
      expect(result).toBeNull();
    });

    test('validateToken returns user for valid token', async () => {
      const db = createTestDb();
      await createUser(db, 'tokenuser', 'pass', 'viewer');
      const login = await verifyLogin(db, 'tokenuser', 'pass');
      expect(login).not.toBeNull();

      const user = validateToken(db, login!.token);
      expect(user).not.toBeNull();
      expect(user!.username).toBe('tokenuser');
      expect(user!.role).toBe('viewer');
    });

    test('validateToken returns null for invalid token', () => {
      const db = createTestDb();
      expect(validateToken(db, 'bogustoken')).toBeNull();
    });

    test('validateToken returns null for deactivated user', async () => {
      const db = createTestDb();
      const user = await createUser(db, 'willdeactivate', 'pass');
      const login = await verifyLogin(db, 'willdeactivate', 'pass');
      expect(login).not.toBeNull();

      deactivateUser(db, user.id);
      const result = validateToken(db, login!.token);
      expect(result).toBeNull();
    });

    test('revokeToken invalidates the token', async () => {
      const db = createTestDb();
      await createUser(db, 'revokeuser', 'pass');
      const login = await verifyLogin(db, 'revokeuser', 'pass');
      expect(login).not.toBeNull();

      revokeToken(db, login!.token);
      expect(validateToken(db, login!.token)).toBeNull();
    });

    test('user can have multiple active sessions', async () => {
      const db = createTestDb();
      await createUser(db, 'multilogin', 'pass');
      const login1 = await verifyLogin(db, 'multilogin', 'pass');
      const login2 = await verifyLogin(db, 'multilogin', 'pass');
      expect(login1!.token).not.toBe(login2!.token);

      // Both tokens valid
      expect(validateToken(db, login1!.token)).not.toBeNull();
      expect(validateToken(db, login2!.token)).not.toBeNull();

      // Revoking one doesn't affect the other
      revokeToken(db, login1!.token);
      expect(validateToken(db, login1!.token)).toBeNull();
      expect(validateToken(db, login2!.token)).not.toBeNull();
    });

    test('cleanExpiredSessions removes old sessions', async () => {
      const db = createTestDb();
      await createUser(db, 'expuser', 'pass');

      // Insert an already-expired session
      db.prepare(`
        INSERT INTO dashboard_sessions (token, user_id, expires_at)
        VALUES ('expired-token', 1, datetime('now', '-1 hour'))
      `).run();

      const login = await verifyLogin(db, 'expuser', 'pass');
      expect(login).not.toBeNull();

      const removed = cleanExpiredSessions(db);
      expect(removed).toBeGreaterThanOrEqual(1);

      // Expired token should be gone
      expect(validateToken(db, 'expired-token')).toBeNull();
      // Fresh token should still work
      expect(validateToken(db, login!.token)).not.toBeNull();
    });
  });

  // ── Password hashing ────────────────────────────────────────────────────

  describe('password security', () => {
    test('password is stored as argon2id hash', async () => {
      const db = createTestDb();
      await createUser(db, 'hashcheck', 'mypassword');
      const row = db.prepare(
        'SELECT password_hash FROM dashboard_users WHERE username = @username'
      ).get({ username: 'hashcheck' }) as { password_hash: string };
      expect(row.password_hash).toContain('$argon2id$');
      expect(row.password_hash).not.toContain('mypassword');
    });

    test('getUser does not expose password_hash', async () => {
      const db = createTestDb();
      const user = await createUser(db, 'nohash', 'secret');
      const found = getUser(db, user.id);
      expect(found).toBeDefined();
      expect((found as any).password_hash).toBeUndefined();
    });
  });
});
