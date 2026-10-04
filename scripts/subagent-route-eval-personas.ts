/**
 * Round-2 measurement tooling (no product code). Builds the per-persona server DB and mirror that the
 * held-out v2 rows (persona-tagged) are asked against, from the synthetic persona seed files, using
 * the product's own detectFormat + parsers + computeExternalId + insertTransactions (the same steps
 * as csv-import's importSingleFile, minus embeddings and file-hash bookkeeping).
 *
 * Synthetic data only. Each persona also gets a generated book of accounts, month-end balance snapshots
 * and loans (scripts/subagent-route-eval/fixtures/v3, see its README) so the net-worth and cash reads are
 * not run over an empty book.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTestDb } from '../src/__tests__/helpers.js';
import { createMirrorDb } from '../src/__tests__/mirror-helpers.js';
import { insertTransactions, type TransactionInsert } from '../src/db/queries.js';
import { apiTransactions, apiEntities, apiBudgetLimits, apiCategories, apiAccounts } from '../src/dashboard/api.js';
import { applyPersonaBook, DEFAULT_FIXTURES_DIR, loadPersonaBook } from './subagent-route-eval-books.js';
import { syncBalanceSnapshotRows, syncLoanRows } from '../src/dashboard/sync-routes.js';
import { applySync } from '../src/dashboard/ui/src/store/mirror-schema.js';
import { detectFormat } from '../src/tools/import/detect-bank.js';
import { computeExternalId } from '../src/tools/import/external-id.js';
import { parseChaseCSV, type ParsedTransaction } from '../src/tools/import/parsers/chase.js';
import { parseAmexCSV } from '../src/tools/import/parsers/amex.js';
import { parseBofA } from '../src/tools/import/parsers/bofa.js';
import { parseGenericCSV } from '../src/tools/import/parsers/generic.js';
import { parseOfx } from '../src/tools/import/parsers/ofx.js';
import { parseQif } from '../src/tools/import/parsers/qif.js';
import type {
  MirrorTransactionRow,
  MirrorEntityRow,
  MirrorBudgetRow,
  MirrorCategoryRow,
  MirrorAccountRow,
  MirrorBalanceSnapshotRow,
  MirrorLoanRow,
} from '../src/dashboard/ui/src/store/types.js';

export const PERSONAS = ['1-comingled-founder', '2-new-grad', '3-dual-income-household', '4-near-retiree', '5-single-parent'] as const;

/** OA_PERSONAS_DIR wins; otherwise the first existing candidate. Returns null when none exists. */
export function resolvePersonasDir(): string | null {
  const candidates = [
    process.env.OA_PERSONAS_DIR,
    // This checkout's own scripts/demos/personas, then the main checkout when this is a worktree
    // (<main>/.claude/worktrees/<name>/scripts -> <main>/scripts).
    join(import.meta.dir, 'demos', 'personas'),
    join(import.meta.dir, '..', '..', '..', '..', 'scripts', 'demos', 'personas'),
  ].filter((x): x is string => !!x);
  return candidates.find((c) => existsSync(c)) ?? null;
}

function parseFile(content: string): ParsedTransaction[] {
  const d = detectFormat(content);
  if (d.format === 'ofx') return parseOfx(content);
  if (d.format === 'qif') return parseQif(content);
  switch (d.bank) {
    case 'chase': return parseChaseCSV(content);
    case 'amex': return parseAmexCSV(content);
    case 'bofa':
    case 'bofa-cc': return parseBofA(content);
    default: return parseGenericCSV(content);
  }
}

function uniqueId(seen: Map<string, number>, id: string): string {
  const n = (seen.get(id) ?? 0) + 1;
  seen.set(id, n);
  return n === 1 ? id : `${id}-dup${n}`;
}

export function readPersonaRows(dir: string, persona: string): TransactionInsert[] {
  if (!(PERSONAS as readonly string[]).includes(persona)) throw new Error(`unknown persona ${persona}`);
  const pdir = join(dir, persona);
  const files = readdirSync(pdir).filter((f) => /\.(csv|ofx|qif)$/i.test(f)).sort();
  const out: TransactionInsert[] = [];
  // The product's computeExternalId hashes date|description|amount, so the planted duplicate rows in
  // persona 1 collide on the UNIQUE external_id (the real importer would reject that batch). The set's
  // answerNotes assume both rows exist, so repeats get an occurrence suffix (`-dup2`, `-dup3`; see scripts/subagent-route-eval/fixtures/README.md).
  // Measurement-side choice only.
  const seen = new Map<string, number>();
  for (const f of files) {
    for (const t of parseFile(readFileSync(join(pdir, f), 'utf8'))) {
      out.push({
        date: t.date,
        description: t.description,
        amount: t.amount,
        bank: t.bank,
        source_file: join(persona, f),
        merchant_name: t.merchant_name ?? undefined,
        category: t.category ?? undefined,
        category_detailed: t.category_detailed ?? undefined,
        external_id: uniqueId(seen, t.external_id ?? computeExternalId(t)),
        payment_channel: t.payment_channel ?? undefined,
        pending: t.pending ? 1 : 0,
        authorized_date: t.authorized_date ?? undefined,
      } as TransactionInsert);
    }
  }
  return out;
}

export async function buildPersonaFixture(dir: string, persona: string, fixturesDir: string = DEFAULT_FIXTURES_DIR) {
  const serverDb = createTestDb();
  insertTransactions(serverDb, readPersonaRows(dir, persona));
  applyPersonaBook(serverDb, loadPersonaBook(fixturesDir, persona));
  const mirror = await createMirrorDb();
  await applySync(mirror, {
    profile: 'default',
    transactions: apiTransactions(serverDb, new URLSearchParams({ limit: String(10_000_000) })) as unknown as MirrorTransactionRow[],
    entities: apiEntities(serverDb) as unknown as MirrorEntityRow[],
    budgets: apiBudgetLimits(serverDb) as unknown as MirrorBudgetRow[],
    categories: apiCategories(serverDb) as unknown as MirrorCategoryRow[],
    accounts: apiAccounts(serverDb) as unknown as MirrorAccountRow[],
    balanceSnapshots: syncBalanceSnapshotRows(serverDb) as unknown as MirrorBalanceSnapshotRow[],
    loans: syncLoanRows(serverDb) as unknown as MirrorLoanRow[],
  });
  return { serverDb, mirror };
}
