#!/usr/bin/env bun
/**
 * Demo setup step: turn dashboard auth ON for the `demo` profile (and only that
 * profile) with a fixed, documented, demo-only admin account.
 *
 * Why: `/mcp` client tokens (wmcp_...) carry write tools only while dashboard
 * auth is on. With auth off a token is read-only, so `categorize_transaction`
 * cannot be granted and the WebMCP agent demo cannot show an approval card.
 *
 *   bun run scripts/demo-enable-auth.ts            # enable (idempotent)
 *   bun run scripts/demo-enable-auth.ts --disable  # back to auth off
 *
 * Credentials live in demos/scripts/demo-admin.mjs (public, demo-only).
 * The profile name is not configurable on purpose: this script never touches
 * any other profile. HOME decides which ~/.openaccountant is used, as for the app.
 *
 * Side effect (by design, see enableAuth): turning auth on revokes every
 * existing WebMCP / HTTP-MCP grant and expires their pending operations, so
 * run this BEFORE minting the token you will record with.
 */
import { setActiveProfile } from '../src/profile/index.js';
import { initDatabase } from '../src/db/database.js';
import { enableAuth, disableAuth, getUserByUsername, hashPassword, insertUser, isAuthEnabled } from '../src/dashboard/auth.js';
import { DEMO_ADMIN, DEMO_PROFILE } from '../demos/scripts/demo-admin.mjs';

const disable = process.argv.includes('--disable');
const paths = setActiveProfile(DEMO_PROFILE);
const db = initDatabase();

if (disable) {
  disableAuth(db);
  console.log(`Dashboard auth OFF for profile "${DEMO_PROFILE}" (${paths.database}).`);
  db.close();
  process.exit(0);
}

const hash = await hashPassword(DEMO_ADMIN.password);
const existing = getUserByUsername(db, DEMO_ADMIN.username);
if (existing) {
  // Re-assert the documented credentials, role and active flag so a stale or edited account cannot break a recording.
  db.prepare("UPDATE dashboard_users SET password_hash = @hash, role = 'admin', is_active = 1 WHERE id = @id").run({ hash, id: existing.id });
} else {
  insertUser(db, DEMO_ADMIN.username, hash, 'admin');
}
enableAuth(db);

console.log(`Dashboard auth ON for profile "${DEMO_PROFILE}" (${paths.database}).`);
console.log(`Demo-only admin: ${DEMO_ADMIN.username} / ${DEMO_ADMIN.password}  (public credentials, never reuse)`);
console.log(`auth_enabled=${isAuthEnabled(db)}`);
db.close();
