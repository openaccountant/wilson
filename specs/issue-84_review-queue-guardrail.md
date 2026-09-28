# Plan: below-threshold categorizations routed to a persistent review queue (never auto-applied)

**Repo:** `/home/jd/.spf/watch/wilson/worktrees/issue-84` (branch for issue #84, decomposed from #55)
**Goal:** The `categorize` tool — the single choke point shared by the CLI (`/categorize`) and the dashboard chat agent — must apply a model suggestion only when its confidence is at or above the confidence threshold. Below the threshold, nothing is written to `transactions.category` (the field that feeds every spending summary, budget, and alert); instead a pending row is persisted in a new `categorization_reviews` table. Migration v23 also backfills historical silently-applied low-confidence categorizations into the queue while keeping their currently-applied category.

## Problem recap

In `src/tools/categorize/categorize.ts` (LLM branch, ~line 155) the order is backwards:

```ts
updateCategory(database, cat.id, validCategory, confidence);   // writes category FIRST
...
if (confidence < 0.7) {
  totalNeedingReview++;                                        // "needing review" is only a counter
}
```

Every model suggestion — including low-confidence ones — is written into `transactions.category` before the threshold is ever consulted. `needingReview` is a cosmetic count over rows that were already silently applied. There is no queue, nothing persistent, and nothing for a human to review.

Related facts verified during recon:

- `updateCategory` (`src/db/queries.ts:194`) writes `category` + `category_confidence` only. The only callers are the rules branch (confidence 1.0) and the LLM branch in this tool. So in existing data, `category_confidence IS NOT NULL` ⟹ the category was written by this tool (rules at 1.0, model at whatever it returned); `category_confidence IS NULL` ⟹ bank/import-provided category.
- `user_verified` (`transactions.user_verified INTEGER DEFAULT 0`) is never set to 1 anywhere in the codebase yet — the backfill condition `user_verified = 0` therefore matches all current model-categorized rows.
- `needingReview` is consumed in exactly two places: `src/cli.ts:568-570` and `src/__tests__/categorize-tool.test.ts:115`. The dashboard chat agent consumes the same tool-result JSON through the registry — no other consumer.
- The `entity-classify` tool has its own separate threshold logic (`src/tools/entity/entity-classify.ts`) — out of scope, do not touch it.

## Design decisions (follow these; they were made deliberately)

1. **Threshold constant + per-profile override, same mechanism as the model setting.** Add to `src/utils/config.ts`:
   - `export const DEFAULT_CATEGORIZATION_CONFIDENCE_THRESHOLD = 0.7;`
   - `export const CATEGORIZATION_CONFIDENCE_THRESHOLD_KEY = 'categorizationConfidenceThreshold';`
   - `export function getCategorizationConfidenceThreshold(): number { return getSetting(CATEGORIZATION_CONFIDENCE_THRESHOLD_KEY, DEFAULT_CATEGORIZATION_CONFIDENCE_THRESHOLD); }`
   `getSetting` already reads the active profile's `settings.json` on every call (no caching) — the same mechanism the tool already uses via `getConfiguredModel()`. A profile that sets `"categorizationConfidenceThreshold": 0.85` in `settings.json` gets its future categorizations gated at 0.85.
2. **Migration uses the 0.7 literal, not the setting.** Migrations are static SQL and cannot read `settings.json`. The v23 backfill hardcodes `< 0.7`. A profile that tunes the runtime threshold higher still gets *future* categorizations gated at its own threshold (decision 1); historical backfill uses the default. This is the approved decision — do not try to make the migration setting-aware.
3. **Guardrail ordering: threshold check before any write.** In the LLM branch, a below-threshold suggestion performs **zero** writes to the transaction row — no `category`, no `category_confidence`, and no `entity_id` either. The transaction stays fully in the uncategorized pool (`category IS NULL`), which is what makes it reviewable and re-suggestable.
4. **New table `categorization_reviews` with a partial unique index for dedup.** Columns: `transaction_id` (FK → transactions, ON DELETE CASCADE), `suggested_category`, `confidence`, `status TEXT NOT NULL DEFAULT 'pending'`, `created_at`. A partial unique index `UNIQUE(transaction_id) WHERE status = 'pending'` makes duplicate pending rows impossible at the storage level; inserts use `INSERT OR IGNORE`. The `status` column (only `'pending'` is written in this slice) future-proofs the approve/reject flow without another migration.
5. **Queue hygiene: applying a category clears a stale pending row.** Edge case the prompt implies but doesn't spell out: run 1 suggests 0.6 → pending row; run 2 suggests 0.9 → applied. Without cleanup, the queue would forever list a transaction that is now categorized. Whenever a transaction *becomes* categorized (LLM applied branch OR rules branch), delete any pending review row for it. One small helper, called in both applied paths.
6. **Rules stay exempt.** `matchRule` matches apply at confidence 1.0, pass any threshold ≤ 1.0, and take no threshold branch. Rules tests keep passing unchanged.
7. **Reporting renames count semantics, not just wording.** Tool result field `needingReview` → `routedForReview`; the count now refers to suggestions routed to the queue (pending rows), not to silently applied rows. Message text: `N routed for human review (below threshold X)` — note the threshold is now dynamic, so print the actual value instead of the hardcoded `0.7`. Update the CLI summary line and the tool's registry description to match.
8. **Review resolution UI/flow is explicitly out of scope.** This slice ships the guardrail, the queue, the backfill, and the reporting change. Approve/reject tooling is a later slice of #55.

## Changes by file

### 1. `src/db/schema.ts` — table constant

Add near the other table constants (pattern: `TAX_DEDUCTIONS_TABLE`):

```sql
CREATE TABLE IF NOT EXISTS categorization_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  transaction_id INTEGER NOT NULL,
  suggested_category TEXT NOT NULL,
  confidence REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_categorization_reviews_txn ON categorization_reviews(transaction_id);
CREATE INDEX IF NOT EXISTS idx_categorization_reviews_status ON categorization_reviews(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_categorization_reviews_pending_txn
  ON categorization_reviews(transaction_id) WHERE status = 'pending';
```

### 2. `src/db/migrations.ts` — migration v23

- Import `CATEGORIZATION_REVIEWS_TABLE` alongside the other schema constants.
- Append to `MIGRATIONS` after v22:

```ts
{ version: 23, name: 'create_categorization_reviews', up: CATEGORIZATION_REVIEWS_TABLE },
```

- **Backfill (per the approved decision)** — append to `CATEGORIZATION_REVIEWS_TABLE` (it's one `up` string, like `CATEGORIES_TABLE + CATEGORIES_SEED`):

```sql
INSERT INTO categorization_reviews (transaction_id, suggested_category, confidence, status)
SELECT id, category, category_confidence, 'pending'
FROM transactions
WHERE category IS NOT NULL
  AND category_confidence IS NOT NULL
  AND category_confidence < 0.7
  AND COALESCE(user_verified, 0) = 0;
```

Properties this guarantees:
- Flagged rows keep their currently-applied category and confidence — no report distortion until a human acts.
- `category_confidence IS NULL` rows (bank/import-provided categories) stay out, deliberately.
- `user_verified = 1` rows stay out.
- Runs exactly once (recorded in `schema_migrations`), so no dedup concerns in the INSERT…SELECT itself.
- Do NOT add the table to any earlier CREATE statement; fresh DBs run v1→v23 in order and end up correct (repo convention, see migration 21/22 precedent).

### 3. `src/db/categorization-review-queries.ts` — NEW file

Follow the `goal-queries.ts` / `entity-queries.ts` convention (self-contained query module):

```ts
import type { Database } from './compat-sqlite.js';

export interface CategorizationReviewRow {
  id: number;
  transaction_id: number;
  suggested_category: string;
  confidence: number;
  status: string;
  created_at: string;
}

/** Insert a pending review row. Returns true if inserted, false if one already
 *  existed (dedup via the partial unique index — INSERT OR IGNORE). */
export function addPendingCategorizationReview(
  db: Database, transactionId: number, suggestedCategory: string, confidence: number
): boolean

/** Pending queue, newest first. */
export function getPendingCategorizationReviews(db: Database, limit?: number): CategorizationReviewRow[]

export function countPendingCategorizationReviews(db: Database): number

/** Remove the pending row for a transaction (called when it becomes categorized). */
export function deletePendingCategorizationReview(db: Database, transactionId: number): void
```

### 4. `src/utils/config.ts` — threshold default + helper

Exactly the three exports from Design decision 1. Nothing else in this file changes.

### 5. `src/tools/categorize/categorize.ts` — the guardrail

- Import `getCategorizationConfidenceThreshold` from `../../utils/config.js` (the module already imported for `getConfiguredModel`) and `addPendingCategorizationReview`, `deletePendingCategorizationReview` from `../../db/categorization-review-queries.js`.
- At the top of `func` (after `getDb()`), read the threshold once per run:
  `const threshold = getCategorizationConfidenceThreshold();`
- Rules branch: unchanged (writes `match.category` at 1.0), but add the queue-hygiene call after a successful rule apply:
  `deletePendingCategorizationReview(database, txn.id);`
- LLM branch — replace the write-then-count block with:

```ts
const confidence = Math.max(0, Math.min(1, cat.confidence));

if (confidence >= threshold) {
  updateCategory(database, cat.id, validCategory, confidence);
  if (entityId !== undefined) {
    database.prepare('UPDATE transactions SET entity_id = @entityId WHERE id = @id').run({ entityId, id: cat.id });
  }
  totalCategorized++;
  categoryCounts[validCategory] = (categoryCounts[validCategory] ?? 0) + 1;
  deletePendingCategorizationReview(database, cat.id);   // queue hygiene (decision 5)
} else {
  // Guardrail: below-threshold suggestion is NEVER applied — route to review queue.
  addPendingCategorizationReview(database, cat.id, validCategory, confidence);
  totalRoutedForReview++;
}
```

- Rename the accumulator and result field: `totalNeedingReview` → `totalRoutedForReview`, result data `needingReview` → `routedForReview`.
- Message becomes:
  `` `Categorized ${totalCategorized} of ${uncategorized.length} transactions` + (rule/LLM split) + `. ${totalRoutedForReview} routed for human review (below threshold ${threshold}).` + (batch errors) ``
- Update the tool's `description` in `defineTool({...})` to mention that below-threshold suggestions are held in a persistent review queue instead of applied.

### 6. `src/tools/registry.ts` — `CATEGORIZE_DESCRIPTION`

Add a Usage Notes bullet (after the existing "Call ONCE with the full batch" note):

```
- Suggestions below the confidence threshold (default 0.7; setting "categorizationConfidenceThreshold")
  are NOT applied to transactions — they are routed to the persistent review queue
  (categorization_reviews table) and reported as "routed for human review"
```

### 7. `src/cli.ts` — summary line (~line 568)

```ts
if (data.routedForReview > 0) {
  msg += `\n${data.routedForReview} routed for human review (held in review queue).`;
}
```

### 8. `CHANGELOG.md`

Under `## [Unreleased] → ### Features`, one entry matching the existing style, referencing (#84).

## Tests

### a. `src/__tests__/categorize-tool.test.ts` — update + add

- **Update `mixed rules and LLM categorization`** (the acceptance-mandated flip): mock confidence 0.6. Now assert:
  - `result.data.routedForReview === 1`
  - `result.data.llmCategorized === 0` and `result.data.categorized === 1` (only the rule match)
  - the transaction's `category` is still `null` and `category_confidence` still `null` (`getTransactions(db)` / direct SELECT)
  - exactly one `categorization_reviews` row: `transaction_id` = the txn, `suggested_category = 'Other'`, `confidence = 0.6`, `status = 'pending'`.
- **Update `LLM path called for unmatched transactions`** (confidence 0.9): category applies exactly as before (`'Shopping'` in DB), `routedForReview` is 0/undefined, and no `categorization_reviews` rows exist.
- **New: no duplicate pending rows on re-run.** Seed one uncategorized txn, mock a 0.6-confidence suggestion, call `categorizeTool.func({})` twice; assert `countPendingCategorizationReviews(db) === 1` and still exactly one row.
- **New: applied suggestion clears a stale pending row** (decision 5). Run once with 0.6 mock (creates pending row), then again with a 0.9 mock for the same txn; assert the category applied and the pending row is gone.
- **New: threshold override.** `setSetting('categorizationConfidenceThreshold', 0.5)`; mock confidence 0.6; assert it is applied and `routedForReview === 0`. Restore in a `try/finally` (`setSetting('categorizationConfidenceThreshold', 0.7)` or rewrite the prior config) — the file shares the temp profile from `helpers.ts`, so a leaked setting would pollute sibling tests in the same process.
- Rules tests (`rules path categorizes without LLM`, `rules apply correct categories`, `limit parameter…`) need no changes — rules are exempt.

### b. `src/__tests__/migrations.test.ts` — v23 table + backfill

- Extend `all expected tables are created` with `expect(tableNames).toContain('categorization_reviews')`.
- New test `v23 categorization_reviews: table and backfill contents`. The runner only knows "run all pending", so build a v22 database first, seed, then let the runner apply v23:

```ts
function runMigrationsUpTo(db: Database, version: number): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT DEFAULT (datetime('now')));`);
  const insert = db.prepare('INSERT INTO schema_migrations (version, name) VALUES (@version, @name)');
  for (const m of MIGRATIONS.filter((m) => m.version <= version)) {
    db.exec(m.up);
    insert.run({ version: m.version, name: m.name });
  }
}
```

  Seed via `insertTransactions(db, [...])` (it accepts `category` + `category_confidence`) plus one direct UPDATE for the verified row:
  1. `{ category: 'Shopping', category_confidence: 0.6 }` → **must be queued**, category kept.
  2. `{ category: 'Dining', category_confidence: 0.9 }` → not queued.
  3. `{ category: 'Transport' }` (NULL confidence, bank-provided) → not queued.
  4. `{ category: 'Groceries', category_confidence: 0.5 }` then `UPDATE transactions SET user_verified = 1 WHERE id = …` → not queued.

  Then `runMigrations(db)` (applies only v23) and assert:
  - exactly one row in `categorization_reviews`: txn 1, `suggested_category = 'Shopping'`, `confidence = 0.6`, `status = 'pending'`;
  - txn 1 still has `category = 'Shopping'` in `transactions` (backfill does not touch the applied category);
  - `getSchemaVersion(db) === MIGRATIONS.length`;
  - calling `runMigrations(db)` again changes nothing (still one queue row).

### c. `src/__tests__/config.test.ts` — threshold settings default

- `getCategorizationConfidenceThreshold()` returns `0.7` when the key is absent (`saveConfig({})` first, mirroring the file's existing pattern).
- `DEFAULT_CATEGORIZATION_CONFIDENCE_THRESHOLD === 0.7`.
- Roundtrip: `setSetting('categorizationConfidenceThreshold', 0.85)` → `getCategorizationConfidenceThreshold() === 0.85`; restore after (the file already manages its own temp profile in `beforeAll`/`afterAll`).

### d. `src/__tests__/categorization-review-queries.test.ts` — NEW (small)

Using `createTestDb()` (runs all migrations, so the table exists): `addPendingCategorizationReview` twice for the same txn → one row, second call returns `false`; `getPendingCategorizationReviews` / `countPendingCategorizationReviews` return it; `deletePendingCategorizationReview` clears it. Insert the parent transaction first (FK is enforced with `foreign_keys = ON` in `createTestDb`).

## Verification

1. `bun test src/__tests__/categorize-tool.test.ts src/__tests__/migrations.test.ts src/__tests__/config.test.ts src/__tests__/categorization-review-queries.test.ts` — all touched suites green.
2. `bun test` — full suite green (some heavy suites exist, e.g. transformers/webgpu; they are unaffected).
3. `bun run typecheck` — clean.
4. **Manual check** (acceptance criterion): the CLI is a TUI, so drive the tool directly against a throwaway profile:
   - One-off script (not committed, e.g. `bun /tmp/manual-check.ts`) run from the repo root:
     ```ts
     import { setActiveProfile } from './src/profile/index.js';
     setActiveProfile('manual-check-84');                 // ~/.openaccountant/profiles/manual-check-84
     const db = initDatabase();                           // src/db/database.ts — runs migrations incl. v23
     insertTransactions(db, [
       { date: '2026-09-18', description: 'WEIRD VENDOR LLC', amount: -42.5 },                    // will be suggested
       { date: '2026-09-01', description: 'OLD LOW CONF', amount: -10, category: 'Shopping', category_confidence: 0.55 }, // backfill bait
     ]);
     initCategorizeTool(db);
     console.log(await categorizeTool.func({}));
     ```
     To make the live routing deterministic regardless of what the model returns, first raise the profile's threshold: set `"categorizationConfidenceThreshold": 0.99` in `~/.openaccountant/profiles/manual-check-84/settings.json` (and have a provider configured for that profile — the operator's env already has API keys). Then inspect:
     - the printed tool result contains `N routed for human review (below threshold 0.99)`;
     - `SELECT * FROM categorization_reviews;` shows a pending row for `WEIRD VENDOR LLC`'s txn, and that txn still has `category IS NULL`;
     - the `OLD LOW CONF` row appears in the queue (backfilled by v23) **while still having** `category = 'Shopping'`.
   - Optional TUI pass: `bun run src/index.tsx --profile manual-check-84` and type `/categorize` to see the same summary line rendered in chat.
   - Delete `~/.openaccountant/profiles/manual-check-84` afterwards.
5. Confirm the CLI/chat wording change is visible: the summary says "routed for human review", not "need review".

## Rollback

The migration is purely additive (new table + one recorded backfill); the guardrail is a single branch in one function; the reporting change is a rename in two display sites. Reverting the commit restores the previous auto-apply behavior with no data loss — the `categorization_reviews` table simply stops being written and its rows (pending suggestions, historical flags) remain harmless until the table is dropped manually.

## Out of scope (later slices of #55)

- Review-queue UI / approve-reject tooling (the `status` column is the seam for it).
- Setting `user_verified = 1` when a human resolves a queue entry.
- Surfacing the queue in `transaction-search` or dashboard APIs.
- The `entity-classify` tool's own threshold behavior.