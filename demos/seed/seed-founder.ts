#!/usr/bin/env bun
/**
 * Seed a THROWAWAY Wilson profile for the "Closing September" recorded demo
 * (Comingled Founder persona). See demos/seed/README.md.
 *
 *   bun run demos/seed/seed-founder.ts [--home <dir>] [--out <dir>] [--short-history] [--with-injection]
 *
 * --home defaults to /private/tmp/claude-501/wilson-demo-home and must contain
 * "/private/tmp/". Rerunning wipes that HOME's default profile and reseeds it.
 * The September statements and CREDENTIALS.txt go to --out (default
 * /private/tmp/claude-501/wilson-demo-out). The story data lives in
 * src/demo/founder-seed.ts; this file owns the guard, the shim and the reset.
 */
import { homedir } from 'os';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { randomBytes } from 'crypto';

const REAL_HOME = '/Users/jdfiscus';
const DEFAULT_HOME = '/private/tmp/claude-501/wilson-demo-home';
const DEFAULT_OUT = '/private/tmp/claude-501/wilson-demo-out';
const REPO_ROOT = resolve(import.meta.dir, '../..');

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(name);
const value = (name: string, fallback: string) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? resolve(argv[i + 1]) : fallback;
};
const targetHome = value('--home', DEFAULT_HOME);
const outDir = value('--out', DEFAULT_OUT);
const opts = { shortHistory: flag('--short-history'), withInjection: flag('--with-injection') };

// The profile root is fixed from homedir() when the app's modules load, so run
// under the target HOME: re-exec this script with HOME set when it is not already.
if (process.env.HOME !== targetHome) {
  if (!targetHome.includes('/private/tmp/') || targetHome === REAL_HOME) {
    console.error(`Refusing to seed: --home "${targetHome}" must contain "/private/tmp/" and must not be ${REAL_HOME}.`);
    process.exit(1);
  }
  mkdirSync(targetHome, { recursive: true });
  const child = Bun.spawnSync(['bun', 'run', import.meta.path, ...argv], {
    cwd: REPO_ROOT,
    env: { ...process.env, HOME: targetHome },
    stdout: 'inherit',
    stderr: 'inherit',
  });
  process.exit(child.exitCode ?? 1);
}

const home = homedir();
const envHome = process.env.HOME ?? '';
if (home === REAL_HOME || envHome === REAL_HOME || !home.includes('/private/tmp/') || !envHome.includes('/private/tmp/')) {
  console.error(
    `Refusing to seed: homedir() is "${home}" (HOME="${envHome}"). ` +
      `HOME must be a scratch directory containing "/private/tmp/" and must not be ${REAL_HOME}.`,
  );
  process.exit(1);
}

// Keychain guard (same as scripts/webmcp-live-seed.ts). With SQLCipher installed, initDatabase() reads/writes the
// REAL login keychain (not scoped by HOME). A failing `security` shim first on PATH makes the app fall back to
// plaintext SQLite and never touch the real keychain. The dashboard must be started with the same PATH.
const shimDir = join(home, '.webmcp-live-bin');
mkdirSync(shimDir, { recursive: true });
writeFileSync(join(shimDir, 'security'), '#!/bin/sh\nexit 44\n');
chmodSync(join(shimDir, 'security'), 0o755);
process.env.PATH = `${shimDir}:${process.env.PATH ?? ''}`;

// A CWD-relative .openaccountant/data.db would be migrated into the profile; run from the scratch HOME instead.
process.chdir(home);

const { setActiveProfile, DEFAULT_PROFILE, resolveProfile } = await import('../../src/profile/index.js');
const { initDatabase } = await import('../../src/db/database.js');
const { setEmbedOnWriteEmbedder } = await import('../../src/utils/embed-on-write.js');
const founder = await import('../../src/demo/founder-seed.js');

// Idempotent reset: wipe this scratch HOME's default profile (data.db, settings.json, caches).
const profileRoot = resolveProfile(DEFAULT_PROFILE).root;
if (!profileRoot.startsWith(join(home, '.openaccountant'))) throw new Error(`unexpected profile root ${profileRoot}`);
rmSync(profileRoot, { recursive: true, force: true });

const paths = setActiveProfile(DEFAULT_PROFILE);
const db = initDatabase();

const admin = { username: 'founder', password: randomBytes(12).toString('base64url') };
const summary = await founder.seedFounder(db, admin, opts);
db.pragma('wal_checkpoint(TRUNCATE)');
db.close();

// September statements + credentials.
mkdirSync(outDir, { recursive: true });
const history = founder.buildHistory(opts);
const september = founder.buildSeptemberFiles(history, opts);
const files = [
  { name: 'checking-2026-09.csv', content: september.checkingCsv },
  { name: 'card-2026-09.csv', content: september.cardCsv },
];
for (const f of files) writeFileSync(join(outDir, f.name), f.content);
const credentialsPath = join(outDir, 'CREDENTIALS.txt');
writeFileSync(credentialsPath, `Wilson demo dashboard (scratch HOME ${home})\nusername: ${admin.username}\npassword: ${admin.password}\n`, { mode: 0o600 });

// Verify on a SECOND copy: import September through the dashboard's path, then the rules pass.
const verifyDir = mkdtempSync(join(home, '.seed-verify-'));
let check: Awaited<ReturnType<typeof founder.verifySeptemberImport>>;
try {
  const copy = join(verifyDir, 'data.db');
  copyFileSync(paths.database, copy);
  const verifyDb = initDatabase(copy);
  setEmbedOnWriteEmbedder(async () => {
    throw new Error('embeddings skipped in the seed verification copy');
  });
  check = await founder.verifySeptemberImport(verifyDb, files);
  verifyDb.close();
} finally {
  rmSync(verifyDir, { recursive: true, force: true });
}

const expectedUnmatched = founder.unmatchedSeptemberRows(september.rows).map((r) => r.description);
const unmatchedOk = JSON.stringify([...check.uncategorizedAfterRules].sort()) === JSON.stringify([...expectedUnmatched].sort());

console.log(`Seeded ${paths.database}${opts.shortHistory ? ' (--short-history)' : ''}`);
console.log('  history rows per month:');
for (const [month, n] of Object.entries(summary.rowsPerMonth)) console.log(`    ${month}: ${n}`);
console.log(
  `  accounts ${summary.accounts}, goals ${summary.goals}, budgets ${summary.budgets}, rules ${summary.rules}, ` +
    `business rows ${summary.businessRows}, tax flags ${summary.taxFlags}, LLM interactions ${summary.interactions}`,
);
console.log('  auth on, 1 admin, 0 WebMCP grants, localChatEnabled and prelabelEnabled unset');
console.log(`\nSeptember statements in ${outDir}${opts.withInjection ? ' (with the injection row)' : ''}:`);
for (const f of check.files) console.log(`  ${f.file}: ${f.format}/${f.bank}, ${f.parsed} rows`);
console.log(`  new merchants no rule matches: ${expectedUnmatched.length}`);
console.log('\nSimulated import into a throwaway copy (Transactions → Import Statement path):');
console.log(`  uncategorized right after import: ${check.uncategorizedAfterImport}`);
console.log(`  categorized by rules: ${check.ruleMatched}; still uncategorized: ${check.uncategorizedAfterRules.length}${unmatchedOk ? '' : ' (MISMATCH)'}`);
console.log(`  review queue after import: ${check.reviewQueue} (rows reach it when categorize scores them below ${founder.FOUNDER_REVIEW_THRESHOLD})`);
console.log(`\nCredentials: ${credentialsPath}`);
console.log(`\nStart the dashboard (from ${REPO_ROOT}):\n  HOME=${home} PATH=${shimDir}:$PATH bun run src/index.tsx --dashboard --port 3141`);
console.log('  then open http://localhost:3141');
if (!unmatchedOk) process.exit(2);
