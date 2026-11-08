/**
 * First-boot setup for an unattended dashboard (the Docker image, a home-lab
 * box), driven by environment variables. Runs in `wilson --dashboard` before
 * the server binds.
 *
 * Admin account (WILSON_ADMIN_BOOTSTRAP / WILSON_ADMIN_PASSWORD)
 *   A network bind (WILSON_DASHBOARD_HOST=0.0.0.0) refuses to start until
 *   dashboard auth is on and an active admin exists (lanAuthReady), and the
 *   normal way to get there, creating the admin from a browser on 127.0.0.1,
 *   is not available inside a container. So, only while the profile has NO
 *   dashboard users at all, this creates the first admin and turns auth on:
 *     - WILSON_ADMIN_PASSWORD (or WILSON_ADMIN_PASSWORD_FILE) sets the password;
 *     - otherwise, with WILSON_ADMIN_BOOTSTRAP=generate, a random one is
 *       generated, printed once to the log, and written to
 *       <profile>/initial-admin-password (mode 0600) for the user to read and delete.
 *   WILSON_ADMIN_USERNAME defaults to "admin". Once any user exists they never
 *   create an account or reset a password; the one thing they still do is turn
 *   login back ON for a network bind (WILSON_DASHBOARD_HOST) that has an active
 *   admin but login off, which would otherwise refuse to start.
 *
 * Default model (WILSON_DEFAULT_MODEL, e.g. ollama:granite4.1:3b)
 *   Saved as the profile's chat model only when the profile has none yet, so
 *   a model picked later in Settings is never overwritten.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from '../db/compat-sqlite.js';
import { createFirstAdmin, enableAuth, getUserCount, hasActiveAdmin, hashPassword, isAuthEnabled } from './auth.js';
import { isLoopbackBind } from './origin-gate.js';
import { getActiveProfile } from '../profile/index.js';
import { getSetting, setSetting } from '../utils/config.js';
import { resolveProvider } from '../providers.js';

type Env = Record<string, string | undefined>;

export const INITIAL_ADMIN_PASSWORD_FILE = 'initial-admin-password';

export interface BootstrapResult {
  /** Username of the admin created on this boot, if one was. */
  adminCreated?: string;
  /** Where a generated password was written, if one was generated. */
  generatedPasswordFile?: string;
  /** The model saved as the chat model on this boot, if one was. */
  modelSet?: string;
}

function readPassword(env: Env): string | null {
  const file = env.WILSON_ADMIN_PASSWORD_FILE?.trim();
  if (file) {
    // Docker/compose secrets mount a file; a trailing newline is not part of the password.
    return readFileSync(file, 'utf8').replace(/\r?\n$/, '');
  }
  const pw = env.WILSON_ADMIN_PASSWORD;
  return pw && pw.length > 0 ? pw : null;
}

export async function bootstrapAdmin(db: Database, env: Env = process.env, log: (msg: string) => void = console.log): Promise<Pick<BootstrapResult, 'adminCreated' | 'generatedPasswordFile'>> {
  let password = readPassword(env);
  const generate = env.WILSON_ADMIN_BOOTSTRAP?.trim().toLowerCase() === 'generate';
  if (password === null && !generate) return {};
  if (getUserCount(db) > 0) {
    // A network bind with users but login switched off can never start (lanAuthReady), and inside a
    // container there is no loopback browser to switch it back on from. Turning login ON is the only
    // repair made here: it creates nothing and grants nothing.
    const host = env.WILSON_DASHBOARD_HOST?.trim();
    if (host && !isLoopbackBind(host) && hasActiveAdmin(db) && !isAuthEnabled(db)) {
      enableAuth(db);
      log('Dashboard login was off on a network bind; turned it back on (existing accounts unchanged).');
    }
    return {};
  }

  if (password !== null && password.length < 8) {
    throw new Error('WILSON_ADMIN_PASSWORD must be at least 8 characters.');
  }
  const generated = password === null;
  if (generated) password = randomBytes(18).toString('base64url');

  const username = env.WILSON_ADMIN_USERNAME?.trim() || 'admin';
  const user = createFirstAdmin(db, username, await hashPassword(password as string));
  if (!user) return {}; // someone else created the first user in between; theirs stands

  const result: Pick<BootstrapResult, 'adminCreated' | 'generatedPasswordFile'> = { adminCreated: username };
  if (generated) {
    const file = join(getActiveProfile().root, INITIAL_ADMIN_PASSWORD_FILE);
    writeFileSync(file, `${password}\n`, { mode: 0o600 });
    result.generatedPasswordFile = file;
    log('');
    log('================================================================');
    log(' Dashboard admin account created (dashboard login is now ON).');
    log(`   username: ${username}`);
    log(`   password: ${password}`);
    log(` Also saved to ${file}.`);
    log(' Sign in, change it if you like, then delete that file.');
    log('================================================================');
    log('');
  } else {
    log(`Dashboard admin "${username}" created from WILSON_ADMIN_PASSWORD; dashboard login is now ON.`);
  }
  return result;
}

export function bootstrapDefaultModel(env: Env = process.env, log: (msg: string) => void = console.log): string | undefined {
  const model = env.WILSON_DEFAULT_MODEL?.trim();
  if (!model) return undefined;
  const settingsFile = getActiveProfile().settings;
  if (existsSync(settingsFile) && getSetting<string | null>('modelId', null)) return undefined;
  const provider = resolveProvider(model).id;
  if (!setSetting('provider', provider) || !setSetting('modelId', model)) {
    log(`Could not save WILSON_DEFAULT_MODEL=${model} to ${settingsFile}.`);
    return undefined;
  }
  log(`Chat model set to ${model} (from WILSON_DEFAULT_MODEL).`);
  return model;
}

/** Both steps, in order. Throws only for a password that is set but unusable. */
export async function runDashboardBootstrap(db: Database, env: Env = process.env, log: (msg: string) => void = console.log): Promise<BootstrapResult> {
  const modelSet = bootstrapDefaultModel(env, log);
  const admin = await bootstrapAdmin(db, env, log);
  return { ...admin, ...(modelSet ? { modelSet } : {}) };
}
