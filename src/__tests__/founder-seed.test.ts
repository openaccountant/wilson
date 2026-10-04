import { afterAll, describe, expect, test } from 'bun:test';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Database } from '../db/compat-sqlite.js';
import { detectFormat } from '../tools/import/detect-bank.js';
import { parseStatementContent } from '../tools/import/client-import.js';
import { getMonthlyCashflowData } from '../db/queries.js';
import { deriveNetWorthInputs, NET_WORTH_MIN_HISTORY_MONTHS } from '../dashboard/ui/src/lib/netWorthForecast.js';
import { setEmbedOnWriteEmbedder } from '../utils/embed-on-write.js';
import {
  INJECTION_DESCRIPTION,
  SEPTEMBER_DESCRIPTION_MAX,
  buildHistory,
  buildInteractions,
  buildSeptemberFiles,
  unmatchedSeptemberRows,
  verifySeptemberImport,
} from '../demo/founder-seed.js';

/**
 * The "Closing September" demo seed (demos/seed/seed-founder.ts). The pure half checks the story data; the
 * integration half runs the real script into its own scratch HOME under /private/tmp (the script refuses anything
 * else), then imports September into a COPY of the seeded database through the dashboard's import path.
 * Skipped where /private/tmp is not writable (it is a macOS path).
 */

const SCRIPT = join(import.meta.dir, '../../demos/seed/seed-founder.ts');
const ROOT = join(import.meta.dir, '../..');

describe('founder seed story data', () => {
  const history = buildHistory();
  const withInjection = buildSeptemberFiles(history, { withInjection: true });
  const plain = buildSeptemberFiles(history);

  test('history covers January–August 2026, every row categorized; --short-history covers July–August', () => {
    expect([...new Set(history.map((t) => t.date.slice(0, 7)))]).toEqual(
      ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08'],
    );
    expect(history.every((t) => t.category)).toBe(true);
    expect([...new Set(buildHistory({ shortHistory: true }).map((t) => t.date.slice(0, 7)))]).toEqual(['2026-07', '2026-08']);
    // Deterministic: a second build is identical.
    expect(buildHistory()).toEqual(history);
  });

  test('the September files route through detectFormat to the Chase and Amex parsers', () => {
    expect(detectFormat(plain.checkingCsv)).toEqual({ format: 'csv', bank: 'chase' });
    expect(detectFormat(plain.cardCsv)).toEqual({ format: 'csv', bank: 'amex' });
    const checking = parseStatementContent(withInjection.checkingCsv);
    const card = parseStatementContent(withInjection.cardCsv);
    expect(checking.transactions).toHaveLength(withInjection.rows.filter((r) => r.account === 'checking').length);
    expect(card.transactions).toHaveLength(withInjection.rows.filter((r) => r.account === 'card').length);
    // Amex charges are positive in the file and negative once parsed.
    expect(card.transactions.find((t) => t.description.startsWith('UNION SQUARE CAFE'))?.amount).toBe(-286.4);
    expect(checking.dateRange).toEqual({ start: '2026-09-01', end: '2026-09-28' });
    for (const r of withInjection.rows) {
      expect(r.description.length).toBeLessThanOrEqual(SEPTEMBER_DESCRIPTION_MAX);
      expect(r.description).not.toMatch(/[,"]/);
    }
  });

  test('September carries each story beat', () => {
    const unmatched = unmatchedSeptemberRows(plain.rows);
    expect(unmatched.map((r) => r.beat)).toEqual(Array(5).fill('new-merchant'));
    expect(unmatched.some((r) => r.description.includes('PHARMACY'))).toBe(true);
    expect(unmatchedSeptemberRows(withInjection.rows)).toHaveLength(6);
    expect(plain.rows.some((r) => r.beat === 'injection')).toBe(false);
    expect(withInjection.rows.filter((r) => r.beat === 'injection').map((r) => r.description)).toEqual([INJECTION_DESCRIPTION]);
    expect(withInjection.checkingCsv).toContain(INJECTION_DESCRIPTION);

    const dinner = plain.rows.filter((r) => r.beat === 'client-dinner');
    expect(dinner).toHaveLength(1);
    expect(dinner[0].account).toBe('card');

    // The duplicate: same merchant and amount within 48 hours, on different days so row-level dedup keeps both.
    const adobe = plain.rows.filter((r) => r.description === 'ADOBE CREATIVE CLOUD');
    expect(adobe).toHaveLength(2);
    expect(adobe[0].amount).toBe(adobe[1].amount);
    expect(Date.parse(adobe[1].date) - Date.parse(adobe[0].date)).toBeLessThanOrEqual(48 * 3600_000);
  });

  test('judge material: a dozen agent runs, some of them wrong', () => {
    const runs = buildInteractions(history);
    expect(runs).toHaveLength(12);
    expect(runs.filter((r) => r.wrong).length).toBeGreaterThanOrEqual(3);
    expect(runs.some((r) => r.response === 'You spent $0.00 in September.')).toBe(true);
  });
});

function scratchHome(): string | null {
  try {
    mkdirSync('/private/tmp', { recursive: true });
    return mkdtempSync('/private/tmp/founder-seed-test-');
  } catch {
    return null;
  }
}

async function runSeed(args: string[]) {
  const proc = Bun.spawn(['bun', 'run', SCRIPT, ...args], { cwd: ROOT, env: { ...process.env }, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, stdout, stderr };
}

const scratch = scratchHome();
const run = scratch ? test : test.skip;

describe('demos/seed/seed-founder.ts', () => {
  afterAll(() => {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  });

  run('seeds the story into a scratch HOME, idempotently', async () => {
    const home = join(scratch!, 'home');
    const out = join(scratch!, 'out');
    const args = ['--home', home, '--out', out, '--with-injection'];
    const first = await runSeed(args);
    expect(first.code, first.stderr).toBe(0);
    const passwordOf = () => readFileSync(join(out, 'CREDENTIALS.txt'), 'utf8').match(/password: (\S+)/)![1];
    // The password goes to CREDENTIALS.txt only.
    expect(first.stdout).not.toContain(passwordOf());
    expect(first.stdout).toContain('still uncategorized: 6');

    // Rerun on the same HOME wipes and reseeds (same row count, not doubled) with a fresh password.
    const second = await runSeed(args);
    expect(second.code, second.stderr).toBe(0);
    const password = passwordOf();
    expect(second.stdout).not.toContain(password);

    const dbPath = join(home, '.openaccountant/profiles/default/data.db');
    const db = new Database(dbPath);
    const one = (sql: string) => (db.prepare(sql).get() as { n: number | string }).n;
    try {
      expect(one("SELECT COUNT(DISTINCT strftime('%Y-%m', date)) AS n FROM transactions")).toBe(8);
      expect(one('SELECT COUNT(*) AS n FROM transactions')).toBe(buildHistory().length);
      expect(one('SELECT COUNT(*) AS n FROM transactions WHERE category IS NULL')).toBe(0);
      expect(one("SELECT COUNT(*) AS n FROM transactions WHERE date >= '2026-09-01'")).toBe(0);

      // Auth on with exactly one admin, whose password is the one in CREDENTIALS.txt; no agent grants.
      expect(one("SELECT value AS n FROM dashboard_config WHERE key = 'auth_enabled'")).toBe('true');
      const users = db.prepare('SELECT username, role, password_hash FROM dashboard_users').all() as Array<{ username: string; role: string; password_hash: string }>;
      expect(users.map((u) => [u.username, u.role])).toEqual([['founder', 'admin']]);
      expect(await Bun.password.verify(password, users[0].password_hash)).toBe(true);
      expect(one('SELECT COUNT(*) AS n FROM mcp_grants')).toBe(0);

      expect(one("SELECT COUNT(DISTINCT run_id) AS n FROM llm_interactions WHERE call_type = 'agent'")).toBe(12);
      expect(one("SELECT COUNT(*) AS n FROM entities WHERE name = 'J Founder Studio LLC'")).toBe(1);
      expect(one('SELECT COUNT(*) AS n FROM goals')).toBe(3);
      expect(one('SELECT COUNT(*) AS n FROM budgets')).toBe(2);

      // Eight complete months: the Forecast tab derives its inputs.
      const derived = deriveNetWorthInputs(getMonthlyCashflowData(db, '2026-10', 24));
      expect(derived?.months).toBe(8);
    } finally {
      db.close();
    }

    // Both consents off: neither key is written.
    const settings = JSON.parse(readFileSync(join(home, '.openaccountant/profiles/default/settings.json'), 'utf8'));
    expect('localChatEnabled' in settings).toBe(false);
    expect('prelabelEnabled' in settings).toBe(false);

    // Import September into a COPY through the dashboard's import path: the new merchants (and the injection row)
    // are the only rows the rules pass leaves uncategorized.
    const copy = join(scratch!, 'verify.db');
    copyFileSync(dbPath, copy);
    const verifyDb = new Database(copy);
    setEmbedOnWriteEmbedder(async () => {
      throw new Error('no embeddings in tests');
    });
    try {
      const check = await verifySeptemberImport(verifyDb, [
        { name: 'checking-2026-09.csv', content: readFileSync(join(out, 'checking-2026-09.csv'), 'utf8') },
        { name: 'card-2026-09.csv', content: readFileSync(join(out, 'card-2026-09.csv'), 'utf8') },
      ]);
      expect(check.files.map((f) => f.bank)).toEqual(['chase', 'amex']);
      expect(check.uncategorizedAfterRules).toHaveLength(6);
      expect(check.uncategorizedAfterRules).toContain(INJECTION_DESCRIPTION);
      expect(check.uncategorizedAfterRules).toContain('BRIGHTWELL PHARMACY #0412');
    } finally {
      setEmbedOnWriteEmbedder(null);
      verifyDb.close();
    }
  }, 60_000);

  run('--short-history leaves the Forecast tab on its manual-inputs form', async () => {
    const home = join(scratch!, 'short');
    const result = await runSeed(['--home', home, '--out', join(scratch!, 'short-out'), '--short-history']);
    expect(result.code, result.stderr).toBe(0);
    const db = new Database(join(home, '.openaccountant/profiles/default/data.db'));
    try {
      const history = getMonthlyCashflowData(db, '2026-10', 24);
      expect(history.length).toBeLessThan(NET_WORTH_MIN_HISTORY_MONTHS);
      expect(deriveNetWorthInputs(history)).toBeNull();
    } finally {
      db.close();
    }
  }, 60_000);

  run('refuses a HOME outside /private/tmp', async () => {
    const notScratch = `/tmp/founder-seed-not-scratch-${process.pid}`;
    const result = await runSeed(['--home', notScratch]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Refusing to seed');
    expect(existsSync(notScratch)).toBe(false);
  });
});
