/**
 * Fixture dashboard for the open-jev pre-labeler's live-Chrome steps
 * (specs/open-jev-labeler.md §15). NEVER touches a real profile.
 *
 *   bun run scripts/prelabel-fixture-server.ts [--enable] [--verified] [--port 3142]
 *
 * - Re-executes itself with HOME=$TMPDIR/wilson-prelabel-home BEFORE importing
 *   anything from src/ (OA_ROOT is evaluated from homedir() at import time), and
 *   refuses to start if homedir() does not resolve under the temp dir.
 * - Seeds the 49 synthetic-persona gold rows (docs/spikes/.../harness/gold/categorize.json:
 *   fabricated merchants only) into a plain SQLite file at
 *   $TMPDIR/wilson-prelabel-fixture.db.
 * - Default mode: each row gets a `pending` review at confidence 0.55. The
 *   suggested category is the gold label when i % 3 !== 0, else the next label
 *   in CATEGORIES. Prints the expected lane counts from the spike's results.
 * - --verified: rows are seeded user_verified=1 with the gold category (S6,
 *   /api/prelabel/gold and the measurement panel).
 * - --enable: sets prelabelEnabled=true in the temp profile.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (n: string) => args.includes(`--${n}`);
const opt = (n: string, d: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};

// WILSON_PRELABEL_FIXTURE_DIR overrides $TMPDIR as the scratch base (it must exist).
const BASE = realpathSync(process.env.WILSON_PRELABEL_FIXTURE_DIR ?? tmpdir());
const FIXTURE_HOME = join(BASE, 'wilson-prelabel-home');
const DB_PATH = join(BASE, 'wilson-prelabel-fixture.db');

if (process.env.HOME !== FIXTURE_HOME) {
  mkdirSync(FIXTURE_HOME, { recursive: true });
  const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...args], {
    stdio: 'inherit',
    env: { ...process.env, HOME: FIXTURE_HOME, USERPROFILE: FIXTURE_HOME, WILSON_PRELABEL_FIXTURE_DIR: BASE },
  });
  process.exit(r.status ?? 1);
}

// Past this point HOME is the fixture home. Verify before importing src/.
const home = realpathSync(homedir());
if (!home.startsWith(BASE)) {
  console.error(`refusing to start: homedir() is ${home}, not under ${BASE}`);
  process.exit(1);
}

const { Database } = await import('../src/db/compat-sqlite.ts');
const { runMigrations } = await import('../src/db/migrations.ts');
const { insertTransactions } = await import('../src/db/queries.ts');
const { addPendingCategorizationReview } = await import('../src/db/categorization-review-queries.ts');
const { setActiveProfilePaths } = await import('../src/profile/index.ts');
const { setInitialProfile } = await import('../src/dashboard/db-manager.ts');
const { startDashboardServer } = await import('../src/dashboard/server.ts');
const { setSetting } = await import('../src/utils/config.ts');
const { CATEGORIES } = await import('../src/tools/categorize/categories.ts');
const { routeLane, DEFAULT_MARGIN_CUT } = await import('../src/dashboard/ui/src/prelabel/core.ts');

const root = join(FIXTURE_HOME, '.openaccountant', 'profiles', 'fixture');
mkdirSync(join(root, 'scratchpad'), { recursive: true });
mkdirSync(join(root, 'cache'), { recursive: true });
setActiveProfilePaths({
  name: 'fixture',
  root,
  database: DB_PATH,
  settings: join(root, 'settings.json'),
  scratchpad: join(root, 'scratchpad'),
  cache: join(root, 'cache'),
});

for (const suffix of ['', '-wal', '-shm']) rmSync(DB_PATH + suffix, { force: true });
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
runMigrations(db);

const spikeDir = join(repoRoot, 'docs', 'spikes', '2026-10-02-open-jev-webgpu');
const gold = JSON.parse(readFileSync(join(spikeDir, 'harness', 'gold', 'categorize.json'), 'utf8')) as Array<{
  description: string;
  amount: number;
  date: string;
  expected: string;
}>;
const spikePath = join(spikeDir, 'results', 'open-jev-q4f16-webgpu.json');
const spikeRows = existsSync(spikePath)
  ? (JSON.parse(readFileSync(spikePath, 'utf8')).workloads['categorize-bare'].results as Array<{ pred: string; margin: number }>)
  : [];

const verified = flag('verified');
const { ids } = insertTransactions(
  db,
  gold.map((g) => ({
    date: g.date,
    description: g.description,
    amount: g.amount,
    category: verified ? g.expected : null,
    category_confidence: null,
    source_file: 'prelabel-fixture',
  })),
);

const suggested: string[] = [];
gold.forEach((g, i) => {
  if (verified) {
    db.prepare('UPDATE transactions SET user_verified = 1 WHERE id = @id').run({ id: ids[i] });
    return;
  }
  const next = CATEGORIES[(CATEGORIES.indexOf(g.expected) + 1) % CATEGORIES.length];
  const s = i % 3 !== 0 ? g.expected : next;
  suggested.push(s);
  addPendingCategorizationReview(db, ids[i], s, 0.55);
});

if (flag('enable')) setSetting('prelabelEnabled', true);

if (!verified && spikeRows.length === gold.length) {
  const counts = { ATTENTION: 0, QUICK: 0 } as Record<string, number>;
  const kinds: Record<string, number> = {};
  spikeRows.forEach((r, i) => {
    const route = routeLane(suggested[i], { ok: true, choice: r.pred, margin: r.margin }, DEFAULT_MARGIN_CUT);
    counts[route.lane]++;
    kinds[route.kind] = (kinds[route.kind] ?? 0) + 1;
  });
  console.log(`expected lanes at cut ${DEFAULT_MARGIN_CUT} (from the spike's results; tolerance 2 rows): NEEDS YOU ${counts.ATTENTION}, QUICK CONFIRM ${counts.QUICK}`);
  console.log(`  by chip: ${JSON.stringify(kinds)}`);
}

setInitialProfile('fixture', db);
const port = Number(opt('port', '3142'));
const { server } = await startDashboardServer(db, port);
console.log(`prelabel fixture: ${verified ? 'verified' : 'pending'} mode, ${gold.length} synthetic rows, db ${DB_PATH}`);
console.log(`open http://localhost:${server.port}${verified ? '/?prelabelMeasure=1' : ''}  (Review tab)`);
console.log('Ctrl-C to stop. This server never reads ~/.openaccountant.');
