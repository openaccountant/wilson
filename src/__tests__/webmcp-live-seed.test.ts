import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import {
  CHAIN_ITERATION_CLOSING,
  ITERATION_PROMPT_CLOSING,
  ITERATION_TOOL_RESULTS_MARKER,
  ORCHESTRATION_TOOL_RESULTS_HEADING,
  TEAM_ITERATION_CLOSING,
  omitIterationToolResults,
} from '../agent/iteration-prompt-format.js';

/**
 * L9: scripts/webmcp-live-seed.ts also seeds the rows P4a.2b and P4a.3 of the live check need, so they run with curl-only
 * access. The script refuses any HOME that is not a scratch dir under /private/tmp/, so this test runs it against its
 * own scratch HOME (a temp database; nothing under the real home is touched). It is skipped where /private/tmp is not
 * writable (it is a macOS path).
 */

const SCRIPT = join(import.meta.dir, '../../scripts/webmcp-live-seed.ts');
const ROOT = join(import.meta.dir, '../..');

function scratchHome(): string | null {
  try {
    mkdirSync('/private/tmp', { recursive: true });
    return mkdtempSync('/private/tmp/webmcp-seed-test-');
  } catch {
    return null;
  }
}

async function runSeed(home: string, homeEnv = home) {
  const proc = Bun.spawn(['bun', 'run', SCRIPT], { cwd: ROOT, env: { ...process.env, HOME: homeEnv }, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, stdout, stderr };
}

describe('the live-check seed script', () => {
  const source = readFileSync(SCRIPT, 'utf8');
  const guardSource = readFileSync(join(import.meta.dir, '../../scripts/webmcp-live-seed-guard.ts'), 'utf8');

  test('keeps the real-HOME guard and the scratch-dir requirement (source guard)', () => {
    expect(guardSource).toContain("export const REAL_HOME = '/Users/jdfiscus';");
    expect(guardSource).toMatch(/home === REAL_HOME \|\| envHome === REAL_HOME \|\| !home\.includes\('\/private\/tmp\/'\)/);
    expect(guardSource).toContain('process.exit(1)');
    // The guard must be the first import, so it runs before any app module loads.
    expect(source.match(/^import .*$/m)?.[0]).toContain("from './webmcp-live-seed-guard.js'");
    expect(source).toContain('already has transactions; delete the scratch HOME and rerun.');
  });

  const home = scratchHome();
  const run = home ? test : test.skip;

  run('seeds the multi-iteration, chain, team, standalone and injection rows, refuses a second run, and refuses a non-scratch HOME', async () => {
    const first = await runSeed(home!);
    expect(first.code, first.stderr).toBe(0);

    const dbPath = join(home!, '.openaccountant/profiles/default/data.db');
    const dbFile = existsSync(dbPath) ? dbPath : (first.stdout.match(/Seeded (\S+)/)?.[1] as string);
    const db = new Database(dbFile, { readonly: true });
    const rows = (sql: string, ...args: unknown[]) => db.prepare(sql).all(...(args as never[])) as Array<Record<string, any>>;

    // The original 22 agent rows are untouched, and 9 rows were added.
    expect(rows(`SELECT COUNT(*) AS n FROM llm_interactions`)[0].n).toBe(22 + 9);

    // A multi-iteration agent run: sequence 1..3, iterations 2 and 3 embed tool results in the real format.
    const multi = rows(`SELECT sequence_num, call_type, user_prompt FROM llm_interactions WHERE run_id = 'fake-multi-run' ORDER BY sequence_num`);
    expect(multi.map((r) => r.sequence_num)).toEqual([1, 2, 3]);
    expect(multi.every((r) => r.call_type === 'agent')).toBe(true);
    expect(multi[0].user_prompt).not.toContain(ITERATION_TOOL_RESULTS_MARKER);
    for (const r of multi.slice(1)) {
      expect(r.user_prompt).toContain(`\n\n${ITERATION_TOOL_RESULTS_MARKER}\n### spending_summary(category=Dining)\n`);
      expect(r.user_prompt).toContain(ITERATION_PROMPT_CLOSING);
      // The judge's own cut recognises the block, so P4a.2b has something to omit.
      expect(omitIterationToolResults(r.user_prompt).omittedChars).toBeGreaterThan(0);
      expect(omitIterationToolResults(r.user_prompt).text).toContain('tool results omitted');
    }
    expect(multi[2].user_prompt).toContain('### budget_status(category=Dining)');

    // Chain and team runs: the orchestration format.
    for (const [type, closing] of [['chain', CHAIN_ITERATION_CLOSING], ['team', TEAM_ITERATION_CLOSING]] as const) {
      const run = rows(`SELECT sequence_num, user_prompt FROM llm_interactions WHERE call_type = ? ORDER BY sequence_num`, type);
      expect(run.length, type).toBe(2);
      expect(run[1].user_prompt, type).toContain(`\n\n${ORCHESTRATION_TOOL_RESULTS_HEADING}\n[transaction_search] `);
      expect(run[1].user_prompt, type).toContain(closing);
      expect(omitIterationToolResults(run[1].user_prompt).omittedChars, type).toBeGreaterThan(0);
    }

    // One standalone row.
    expect(rows(`SELECT COUNT(*) AS n FROM llm_interactions WHERE call_type = 'standalone'`)[0].n).toBe(1);

    // One agent interaction whose recorded response carries a prompt-injection string.
    const injected = rows(`SELECT response_content FROM llm_interactions WHERE response_content LIKE '%IGNORE PREVIOUS INSTRUCTIONS%'`);
    expect(injected).toHaveLength(1);
    expect(injected[0].response_content).toContain('categorize_transaction');
    expect(rows(`SELECT call_type FROM llm_interactions WHERE response_content LIKE '%IGNORE PREVIOUS INSTRUCTIONS%'`)[0].call_type).toBe('agent');

    // Tool-result previews exist for the multi-iteration run.
    expect(rows(`SELECT COUNT(*) AS n FROM llm_tool_results`)[0].n).toBeGreaterThanOrEqual(4);
    db.close();

    // Non-idempotent: a second run on the same HOME refuses and changes nothing.
    const second = await runSeed(home!);
    expect(second.code).toBe(1);
    expect(second.stderr).toContain('already has transactions');

    // A HOME outside /private/tmp is refused before anything is opened.
    // A fresh dir per run, so a leftover from an earlier run can't fail the check. The literal
    // "/tmp/..." path (not "/private/tmp/...") is what the guard refuses.
    const notScratchHome = mkdtempSync('/tmp/oa-not-scratch-home-');
    try {
      const notScratch = await runSeed(home!, notScratchHome);
      expect(notScratch.code).toBe(1);
      expect(notScratch.stderr).toContain('Refusing to seed');
      expect(existsSync(join(notScratchHome, '.openaccountant'))).toBe(false);
    } finally {
      rmSync(notScratchHome, { recursive: true, force: true });
    }
  }, 60_000);

  test.skipIf(!home)('cleanup', () => {
    if (home) rmSync(home, { recursive: true, force: true });
  });
});
