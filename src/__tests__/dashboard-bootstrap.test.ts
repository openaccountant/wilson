import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDb } from './helpers.js';
import { createUser, disableAuth, getUserCount, isAuthEnabled, lanAuthReady, verifyLogin } from '../dashboard/auth.js';
import { bootstrapAdmin, bootstrapDefaultModel, INITIAL_ADMIN_PASSWORD_FILE } from '../dashboard/bootstrap.js';
import { ensureProfileDir, getActiveProfile, resetActiveProfile, resolveProfile, setActiveProfilePaths } from '../profile/index.js';
import { getSetting, setSetting } from '../utils/config.js';

const quiet = () => {};
let profileRoot: string;

beforeEach(() => {
  const db = createTestDb(); // sets up the shared test profile first
  db.close();
  const base = mkdtempSync(join(tmpdir(), 'bootstrap-'));
  const paths = { ...resolveProfile('bootstrap'), root: base, settings: join(base, 'settings.json'), database: join(base, 'data.db'), scratchpad: join(base, 'scratchpad'), cache: join(base, 'cache') };
  ensureProfileDir(paths);
  setActiveProfilePaths(paths);
  profileRoot = base;
});

afterEach(() => {
  resetActiveProfile();
});

describe('dashboard bootstrap: admin', () => {
  test('does nothing without WILSON_ADMIN_PASSWORD or WILSON_ADMIN_BOOTSTRAP', async () => {
    const db = createTestDb();
    expect(await bootstrapAdmin(db, {}, quiet)).toEqual({});
    expect(getUserCount(db)).toBe(0);
    expect(isAuthEnabled(db)).toBe(false);
  });

  test('creates the first admin from WILSON_ADMIN_PASSWORD and turns auth on', async () => {
    const db = createTestDb();
    const res = await bootstrapAdmin(db, { WILSON_ADMIN_USERNAME: 'jd', WILSON_ADMIN_PASSWORD: 'correct horse' }, quiet);
    expect(res).toEqual({ adminCreated: 'jd' });
    expect(lanAuthReady(db)).toBe(true);
    expect(await verifyLogin(db, 'jd', 'correct horse')).not.toBeNull();
    expect(existsSync(join(profileRoot, INITIAL_ADMIN_PASSWORD_FILE))).toBe(false);
  });

  test('reads the password from WILSON_ADMIN_PASSWORD_FILE, ignoring one trailing newline', async () => {
    const db = createTestDb();
    const file = join(profileRoot, 'secret');
    writeFileSync(file, 'from a secret file\n');
    await bootstrapAdmin(db, { WILSON_ADMIN_PASSWORD_FILE: file }, quiet);
    expect(await verifyLogin(db, 'admin', 'from a secret file')).not.toBeNull();
  });

  test('generate: random password, logged once and saved 0600 in the profile', async () => {
    const db = createTestDb();
    const lines: string[] = [];
    const res = await bootstrapAdmin(db, { WILSON_ADMIN_BOOTSTRAP: 'generate' }, (m) => lines.push(m));
    expect(res.adminCreated).toBe('admin');
    const file = join(getActiveProfile().root, INITIAL_ADMIN_PASSWORD_FILE);
    expect(res.generatedPasswordFile).toBe(file);
    const password = readFileSync(file, 'utf8').trim();
    expect(password.length).toBeGreaterThanOrEqual(20);
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(lines.some((l) => l.includes(password))).toBe(true);
    expect(await verifyLogin(db, 'admin', password)).not.toBeNull();
    expect(lanAuthReady(db)).toBe(true);
  });

  test('never touches a profile that already has a user', async () => {
    const db = createTestDb();
    await createUser(db, 'existing', 'their own password', 'viewer');
    const res = await bootstrapAdmin(db, { WILSON_ADMIN_PASSWORD: 'attacker-chosen', WILSON_ADMIN_BOOTSTRAP: 'generate' }, quiet);
    expect(res).toEqual({});
    expect(getUserCount(db)).toBe(1);
    expect(isAuthEnabled(db)).toBe(false);
    expect(await verifyLogin(db, 'admin', 'attacker-chosen')).toBeNull();
  });

  test('network bind with an admin but login off: turns login back on, creates nothing', async () => {
    const db = createTestDb();
    await createUser(db, 'owner', 'owner password', 'admin');
    disableAuth(db);
    const env = { WILSON_ADMIN_BOOTSTRAP: 'generate', WILSON_DASHBOARD_HOST: '0.0.0.0' };
    expect(await bootstrapAdmin(db, env, quiet)).toEqual({});
    expect(isAuthEnabled(db)).toBe(true);
    expect(getUserCount(db)).toBe(1);
  });

  test('loopback bind: leaves login off as the owner set it', async () => {
    const db = createTestDb();
    await createUser(db, 'owner', 'owner password', 'admin');
    disableAuth(db);
    await bootstrapAdmin(db, { WILSON_ADMIN_BOOTSTRAP: 'generate', WILSON_DASHBOARD_HOST: '127.0.0.1' }, quiet);
    expect(isAuthEnabled(db)).toBe(false);
  });

  test('rejects a short password instead of creating a weak admin', async () => {
    const db = createTestDb();
    await expect(bootstrapAdmin(db, { WILSON_ADMIN_PASSWORD: 'short' }, quiet)).rejects.toThrow(/at least 8/);
    expect(getUserCount(db)).toBe(0);
  });
});

describe('dashboard bootstrap: default model', () => {
  test('sets provider + model when the profile has no model yet', () => {
    expect(bootstrapDefaultModel({ WILSON_DEFAULT_MODEL: 'ollama:granite4.1:3b' }, quiet)).toBe('ollama:granite4.1:3b');
    expect(getSetting<string | null>('modelId', null)).toBe('ollama:granite4.1:3b');
    expect(getSetting<string | null>('provider', null)).toBe('ollama');
  });

  test('never overrides a model chosen later', () => {
    setSetting('provider', 'anthropic');
    setSetting('modelId', 'claude-sonnet-4-5');
    expect(bootstrapDefaultModel({ WILSON_DEFAULT_MODEL: 'ollama:granite4.1:3b' }, quiet)).toBeUndefined();
    expect(getSetting<string | null>('modelId', null)).toBe('claude-sonnet-4-5');
  });

  test('no variable, no change', () => {
    expect(bootstrapDefaultModel({}, quiet)).toBeUndefined();
    expect(existsSync(join(profileRoot, 'settings.json'))).toBe(false);
  });
});
