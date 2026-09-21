# Plan: Dashboard Review tab — confirm or correct each queued categorization

**Repo:** `/home/jd/.spf/watch/wilson/worktrees/issue-86` (worktree for issue #86, decomposed from #55)
**Blocked by:** #84 — **already landed in this worktree** (commit `6e2e7ca`, migration **v24**, not v23). Verified below; do not re-implement any of it.
**Goal:** A Review tab in the dashboard lists every pending categorization review (transaction date, amount, description, suggested category, confidence). The user can **Confirm** (apply the suggested category) or **Correct** (pick a category from the existing list). Either action, in one atomic operation: applies the category, marks the transaction `user_verified = 1`, and resolves the queue entry. Until resolved, a newly routed item's transaction stays uncategorized in the main list; backfilled historical items keep their currently-applied category and simply show as awaiting review. Also make the smart-categorize skill's steps honest (they promise a user-review flow the tool never performed, and reference an `update_category` tool that doesn't exist).

## What exists today (verified — do not re-implement)

- **Queue table** (`src/db/schema.ts:419-434`, migration v24 in `src/db/migrations.ts:72`): `categorization_reviews(id, transaction_id FK ON DELETE CASCADE, suggested_category, confidence, status TEXT DEFAULT 'pending', created_at)` + partial unique index `idx_categorization_reviews_pending_txn UNIQUE(transaction_id) WHERE status = 'pending'`. The `status` column is the seam this slice uses (only `'pending'` is ever written today).
- **Query module** `src/db/categorization-review-queries.ts`: `addPendingCategorizationReview` (INSERT OR IGNORE), `getPendingCategorizationReviews(db, limit?)` (flat rows, newest first), `countPendingCategorizationReviews`, `deletePendingCategorizationReview`. **No resolve/apply function exists yet** — that is new work.
- **Guardrail** (`src/tools/categorize/categorize.ts:158-173`): below-threshold suggestions perform zero writes to the transaction (`category IS NULL`, `category_confidence IS NULL`) and land a pending row; above-threshold applies + clears stale pending rows.
- **Dashboard API layer** (`src/dashboard/api.ts`) — thin per-endpoint functions taking `(db, params|body)`; **routes** in `src/dashboard/server.ts` with RBAC guards of the exact shape `if (authEnabled && currentUser && !canWrite(currentUser.role)) → 403` on every mutating route (see entities/import/memories routes). Reads are open to any authenticated user. `canWrite(role) = role === 'admin'` (`server.ts`, RBAC section).
- **Transactions write path**: `TransactionUpdate` (`src/db/queries.ts:778`) + `updateTransaction` (`:790`) support `date/description/amount/category/notes/entity_id` — **no `user_verified`** (the prompt's stated gap). `updateCategory` (`:194`) writes `category` + `category_confidence` but not `user_verified`.
- **Atomic transactions**: the compat-sqlite wrapper exposes `db.transaction(fn)` (`src/db/compat-sqlite.ts:105-108`, wrapping bun:sqlite). Precedents: `insertTransactions`, `entity-queries.ts:133`, `net-worth-queries.ts:284`.
- **React UI**: tabs live in `src/dashboard/ui/src/tabs/*.tsx`, registered in `TabBar.tsx` (`TABS` const, `TabId` derived from it) and `App.tsx` (`getHashTab` valid list + `TAB_COMPONENTS`). `useApi<T>(path)` hook (`src/hooks/useApi.ts`) gives `{ data, loading, error, refetch }`; client `api()` helper (`src/api.ts`) attaches the bearer token. Role gating precedent: `SettingsTab.tsx:106-115` and `ImportStatementDialog.tsx:68` — `useApi<AuthStatus>('/api/auth/status')`, then `authStatus?.user?.role === 'admin'`; `AuthStatus` carries `authEnabled` so "auth disabled → everyone acts" is expressible.
- **Category list the dashboard already shows users**: `App.tsx` derives it from `GET /api/summary?startDate=2000-01-01&endDate=2099-12-31` (all-time, sorted unique `category`). There is **no** `/api/categories` endpoint; the Review tab should reuse this derivation rather than invent one.
- **Categorize tool's own category validation** (`src/tools/categorize/categorize.ts:148-154`): DB `resolveCategory()` first, fallback to static `CATEGORIES` (`src/tools/categorize/categories.ts`, 18 entries incl. `'Other'`). Reuse this exact two-source definition of "existing category list" for API-side validation of corrections.
- **UI types**: `Transaction` in `src/dashboard/ui/src/types.ts` already has `user_verified: number`; `TransactionsTab.tsx` renders a green `verified` badge when set (issue #85). Confidence-badge styling precedent (`yellow < 0.7`, `CONFIDENCE_REVIEW_THRESHOLD = 0.7`) is in the same file to mirror.
- **Build/typecheck layout**: root `bun run typecheck` (`tsc --noEmit`) **excludes** `src/dashboard/ui`; the UI is typechecked by its own build (`npm run build` = `tsc -b && vite build` in `src/dashboard/ui`, which has its own `package.json`/lockfile). Legacy fallback dashboard is `src/dashboard/html.ts` — served at `/` only when `src/dashboard/ui/dist/index.html` is absent; **needs no changes**.
- **Test seams**: `createTestDb()` in `src/__tests__/helpers.ts` (runs all migrations); `dashboard-api.test.ts` tests api functions directly; `dashboard-server.test.ts` spins the real server (`start()` → port 0) and has a `setupRbac()` helper creating admin+viewer tokens and asserting 403/401 semantics per route.

## Design decisions (follow these; they were made deliberately)

1. **Dedicated review-resolution handler, plus a one-line `user_verified` extension to the transactions update path.** The atomic three-effect operation cannot live in `updateTransaction` (it can't touch `category_confidence` or the review table), so the resolution is a new db-layer function called by two new API handlers. Separately, `TransactionUpdate` gains `user_verified?: number` so `PATCH /api/transactions/:id` can carry the flag (admin-gated already) — the prompt names this gap explicitly and it makes the verified flag settable outside the review flow (e.g. verifying a bank-provided category).
2. **Resolution semantics per action.** *Confirm*: transaction gets `category = suggested_category`, `category_confidence = review.confidence`, `user_verified = 1`. *Correct*: transaction gets the chosen category, `category_confidence = NULL` (a human-assigned category carries no machine score; this also clears the stale low score on backfilled rows), `user_verified = 1`. Both: review row `status: 'pending' → 'resolved'` (row is kept, not deleted — `status` was added for exactly this in #84, and the acceptance criterion says "the review row is resolved"). The partial unique index only constrains pending rows, so resolved rows never block re-suggestion.
3. **Atomicity via `db.transaction`.** One `db.transaction(...)` performs: re-read the review row, reject non-pending/missing, UPDATE transactions (category, confidence, user_verified, updated_at), UPDATE review status. This makes "applied category with still-pending review" and "resolved review with unapplied category" impossible. A second resolve of the same row hits the `status !== 'pending'` guard. A pending review's transaction always exists (FK ON DELETE CASCADE removes the review when the transaction dies), so no orphan path.
4. **API shape** — three routes, snake_case wire (dominant convention for db-backed endpoints here):
   - `GET /api/reviews?limit=` → joined pending queue (any authenticated user; no role check — viewers list read-only).
   - `POST /api/reviews/:id/confirm` → admin-only.
   - `POST /api/reviews/:id/correct` body `{ category: string }` → admin-only; category validated against `resolveCategory(db, …)` then static `CATEGORIES`, else 400.
   Errors as `{ success: false, error }` with status 400 (bad category) / 404 (unknown id or already resolved — 404 keeps it simple and idempotent-looking; no new 409 convention).
5. **Joined queue read.** New db-layer function returns the queue joined to transactions (date, description, merchant_name, amount, current_category, suggested_at). `current_category` is non-null only for backfilled/historical items — the UI shows it as "currently applied" context per the approved decision; newly routed items show nothing there.
6. **The Review tab is the only place a pending suggestion is visible** — React tab only. The legacy `html.ts` fallback is untouched (it must merely keep serving; its existing test `GET / returns HTML` covers both build states). No queue surface in the CLI/chat beyond what #84 already reports.
7. **Category dropdown source**: same derivation as `App.tsx` (all-time summary, sorted unique). Do not add a categories-table endpoint in this slice.

## Changes by file

### 1. `src/db/categorization-review-queries.ts` — extend the module (no migration needed)

Add after the existing functions:

```ts
export interface PendingReviewRow {
  review_id: number;
  transaction_id: number;
  suggested_category: string;
  confidence: number;
  suggested_at: string;
  date: string;
  description: string;
  merchant_name: string | null;
  amount: number;
  /** Category currently applied to the transaction — non-null only for backfilled historical rows. */
  current_category: string | null;
}

/** Pending queue joined with the transaction under review, newest first. */
export function getPendingReviewQueue(db: Database, limit?: number): PendingReviewRow[] {
  const sql = `
    SELECT r.id AS review_id, r.transaction_id, r.suggested_category, r.confidence,
           r.created_at AS suggested_at,
           t.date, t.description, t.merchant_name, t.amount,
           t.category AS current_category
    FROM categorization_reviews r
    JOIN transactions t ON t.id = r.transaction_id
    WHERE r.status = 'pending'
    ORDER BY r.created_at DESC, r.id DESC
    ${limit !== undefined ? 'LIMIT @limit' : ''}
  `;
  return db.prepare(sql).all(limit !== undefined ? { limit } : undefined) as PendingReviewRow[];
}

export type ReviewResolution =
  | { ok: true; transactionId: number; category: string; confidence: number | null }
  | { ok: false; error: string };

/**
 * Atomically apply a human decision and resolve the queue entry: one
 * transaction writes the transaction row (category, confidence, user_verified=1)
 * and flips the review row to 'resolved'. confirm uses the review's own
 * suggested category + stored confidence; correct uses the caller-validated
 * category and NULLs the machine confidence.
 */
export function resolveCategorizationReview(
  db: Database,
  reviewId: number,
  outcome: { action: 'confirm' } | { action: 'correct'; category: string }
): ReviewResolution {
  const apply = db.transaction((rid: number, dec: typeof outcome): ReviewResolution => {
    const review = db.prepare(
      'SELECT id, transaction_id, suggested_category, confidence, status FROM categorization_reviews WHERE id = @id'
    ).get({ id: rid }) as { id: number; transaction_id: number; suggested_category: string; confidence: number; status: string } | undefined;
    if (!review) return { ok: false, error: 'review not found' };
    if (review.status !== 'pending') return { ok: false, error: 'review already resolved' };
    const category = dec.action === 'confirm' ? review.suggested_category : dec.category;
    const confidence = dec.action === 'confirm' ? review.confidence : null;
    db.prepare(`
      UPDATE transactions
      SET category = @category, category_confidence = @confidence,
          user_verified = 1, updated_at = datetime('now')
      WHERE id = @id
    `).run({ id: review.transaction_id, category, confidence });
    db.prepare("UPDATE categorization_reviews SET status = 'resolved' WHERE id = @id").run({ id: rid });
    return { ok: true, transactionId: review.transaction_id, category, confidence };
  });
  return apply(reviewId, outcome);
}
```

Keep the existing functions untouched. Note the file's existing named-param style (`@id`) and `as { … }` casts.

### 2. `src/db/queries.ts` — carry the verified flag on the transactions update path

- `TransactionUpdate` (`:778`): add `user_verified?: number;` with a comment (`/** SQLite 0/1: user has personally verified the category. */`).
- `updateTransaction` (`:790`): add one clause mirroring the others:
  `if (updates.user_verified !== undefined) { sets.push('user_verified = @user_verified'); params.user_verified = updates.user_verified; }`

Nothing else in this file changes. This makes `PATCH /api/transactions/:id` able to set the flag with zero route changes (the PATCH route already passes the body through and is admin-gated).

### 3. `src/dashboard/api.ts` — three handlers

Import `getPendingReviewQueue`, `resolveCategorizationReview`, type `PendingReviewRow` from `../db/categorization-review-queries.js`, `resolveCategory` from `../db/queries.js` (already partially imported), and `CATEGORIES` from `../tools/categorize/categories.js` (importing a tool helper here has precedent: `computeExternalId` from `../tools/import/external-id.js`).

```ts
// ── Categorization review queue ─────────────────────────────────────────────

/** GET /api/reviews — pending categorization reviews joined with their transactions (read-only; any authenticated user). */
export function apiReviewQueue(db: Database, params: URLSearchParams) {
  const limit = parseInt(params.get('limit') ?? '200', 10);
  return getPendingReviewQueue(db, Number.isFinite(limit) && limit >= 1 ? limit : 200);
}

export type ReviewActionResult =
  | { success: true; transactionId: number; category: string }
  | { success: false; error: string; status: number };

/** POST /api/reviews/:id/confirm — apply the suggested category (admin-only route). */
export function apiConfirmReview(db: Database, reviewId: number): ReviewActionResult {
  const result = resolveCategorizationReview(db, reviewId, { action: 'confirm' });
  if (!result.ok) return { success: false, error: result.error, status: 404 };
  return { success: true, transactionId: result.transactionId, category: result.category };
}

/** POST /api/reviews/:id/correct — apply a user-chosen category (admin-only route). */
export function apiCorrectReview(db: Database, reviewId: number, body: { category?: unknown }): ReviewActionResult {
  const raw = typeof body?.category === 'string' ? body.category.trim() : '';
  if (!raw) return { success: false, error: 'category is required', status: 400 };
  // Same two-source "existing category list" the categorize tool validates against.
  const category = resolveCategory(db, raw) ?? (CATEGORIES.includes(raw) ? raw : null);
  if (!category) return { success: false, error: `unknown category "${raw}"`, status: 400 };
  const result = resolveCategorizationReview(db, reviewId, { action: 'correct', category });
  if (!result.ok) return { success: false, error: result.error, status: 404 };
  return { success: true, transactionId: result.transactionId, category: result.category };
}
```

### 4. `src/dashboard/server.ts` — routes (mirroring the entities/import RBAC shape)

Import the three handlers. In the Data API section (e.g. after the transactions PATCH/DELETE block):

```ts
// ── Categorization review queue ─────────────────────────────────────────────
// Reads are open to any authenticated user (viewers see the queue read-only);
// mutations follow the standard admin-only canWrite guard.

if (path === '/api/reviews') {
  return Response.json(apiReviewQueue(activeDb, url.searchParams), { headers });
}

const reviewMatch = path.match(/^\/api\/reviews\/(\d+)\/(confirm|correct)$/);
if (reviewMatch && req.method === 'POST') {
  if (authEnabled && currentUser && !canWrite(currentUser.role)) {
    return Response.json({ error: 'Forbidden' }, { status: 403, headers });
  }
  const id = parseInt(reviewMatch[1], 10);
  const result = reviewMatch[2] === 'confirm'
    ? apiConfirmReview(activeDb, id)
    : apiCorrectReview(activeDb, id, await req.json() as { category?: string });
  return Response.json(result, { status: result.success ? 200 : result.status, headers });
}
```

### 5. `src/dashboard/ui/src/types.ts` — wire type

```ts
// Matches GET /api/reviews (PendingReviewRow in src/db/categorization-review-queries.ts)
export interface ReviewQueueItem {
  review_id: number;
  transaction_id: number;
  suggested_category: string;
  confidence: number;
  suggested_at: string;
  date: string;
  description: string;
  merchant_name: string | null;
  amount: number;
  current_category: string | null;
}
```

### 6. `src/dashboard/ui/src/components/TabBar.tsx` — nav entry

Add to `TABS` right after Transactions: `{ id: 'review', label: 'Review' },` — `TabId` updates automatically (derived from `TABS`).

### 7. `src/dashboard/ui/src/App.tsx` — register the tab

- `getHashTab` valid list: insert `'review'` after `'transactions'`.
- `TAB_COMPONENTS`: `review: ReviewTab,` with the import at the top.

### 8. `src/dashboard/ui/src/tabs/ReviewTab.tsx` — NEW (the workflow)

Structure (mirror `TransactionsTab` conventions — `useApi`, `formatDate`/`formatAmount`, badge styling, banner state):

- Data: `const { data: reviews, loading, error, refetch } = useApi<ReviewQueueItem[]>('/api/reviews');`
- Categories dropdown: `const { data: allSummary } = useApi<SpendingSummaryItem[]>('/api/summary?startDate=2000-01-01&endDate=2099-12-31');` then `useMemo` sorted unique `category` (same merge logic as `App.tsx`).
- Role gating: local `AuthStatus` interface (copy the shape used in `SettingsTab.tsx:93-99`: `{ authEnabled: boolean; user: { id, username, role } | null }`), `const { data: authStatus } = useApi<AuthStatus>('/api/auth/status');` then `const canAct = !authStatus?.authEnabled || authStatus?.user?.role === 'admin';` — when auth is disabled everyone acts (server allows); when enabled and not admin, hide action controls and show a muted "Sign in as an admin to resolve reviews" note. The server stays the authority.
- Table columns: Date (`formatDate`), Description (merchant_name ?? description, truncate like `TransactionsTab`), Amount (right-aligned `formatAmount`, red/green by sign), Suggested category + confidence badge (reuse the badge pattern from `TransactionsTab.ConfidenceBadge`: percent text, yellow styling when `< 0.7`, neutral otherwise — copy the small local component, it is 15 lines), Current category column showing `current_category` as muted text `currently 'Shopping'` when non-null, blank otherwise.
- Row actions (only when `canAct`):
  - **Confirm** button (green, like the importer's primary button styling) → `await api(\`/api/reviews/${r.review_id}/confirm\`, { method: 'POST' })` then `refetch()`.
  - **Correct**: a `<select>` (value bound to per-row local state, placeholder option `Correct…`) + an **Apply** button disabled until a category is chosen → `api(\`/api/reviews/${r.review_id}/correct\`, { method: 'POST', body: JSON.stringify({ category }) })` then `refetch()`.
  - On thrown error: set a dismissible banner with the message (pattern: TransactionsTab's banner). Success also sets a short banner (`Applied 'Transport' to …`) — optional but cheap and confirms the atomic effect.
- Row-level `correctPick` state: a `Record<number, string>` in component state keyed by `review_id`, or extract a small `ReviewRow` component holding its own select state (preferred — keeps one `useState` per row).
- Empty state: `reviews?.length === 0` → centered card "Nothing to review — all suggestions resolved." (and no rows when the queue is empty after actions, which is how "removed from the pending list" is visibly confirmed).
- Header: `Review` title + `${reviews?.length ?? 0} pending` count in the same style as TransactionsTab's counter.

### 9. `src/skills/smart-categorize/SKILL.md` — make the steps honest

The skill's front-matter description claims it "allows user review, and learns from corrections", and Workflow steps 5–7 promise the assistant will show results, collect per-batch confirm/correct/skip, and "Apply categories via `update_category`" — a tool that does not exist (the registry has `categorize`, `category_manage`, `edit_transaction`; no `update_category`), and no per-batch apply step ever existed (the `categorize` tool applies ≥-threshold suggestions itself and routes the rest to the queue). Rewrite the Workflow to:

```
1. **Find uncategorized**: Use `transaction_search` to find uncategorized transactions
2. **Check count**: If none found, report that all transactions are categorized and exit
3. **Batch processing**: Process in batches of up to 50 transactions
4. **Categorize**: For each batch, call `categorize` tool with PFC-aligned category list
5. **Report the split**: X applied automatically (confidence ≥ threshold), Y routed to the review queue (below threshold — never applied to the transaction)
6. **Review queue is human-only**: pending suggestions appear in the dashboard's Review tab with the transaction's date, amount, description, the suggested category, and the confidence score
7. **Human decision**: Confirm applies the suggested category; Correct applies a category the user picks — either action also marks the transaction user-verified and resolves the queue entry. Do not attempt to apply queued suggestions from the agent side
8. **Report summary**: X categorized, Y awaiting review in the Review tab
```

Front-matter `description`: replace "Process in batches, allows user review, and learns from corrections." with "Process in batches; low-confidence suggestions are routed to a review queue the user resolves in the dashboard Review tab." (keep the trigger phrases line intact).

### 10. `CHANGELOG.md`

Under `## [Unreleased] → ### Features`, one entry in the file's existing style, referencing (#86): dashboard Review tab to confirm/correct queued categorizations; resolving applies the category, marks the transaction user-verified, and resolves the queue entry atomically.

## Tests

### a. `src/__tests__/dashboard-api.test.ts` — list/confirm/correct + verified flag (acceptance-mandated)

Add imports: `apiReviewQueue, apiConfirmReview, apiCorrectReview` from `../dashboard/api.js`; `addPendingCategorizationReview` from `../db/categorization-review-queries.js`. Seeding pattern: `insertTransactions(db, [...])` then `addPendingCategorizationReview(db, txnId, 'Transport', 0.55)`; get the review id from the queue (`apiReviewQueue(db, new URLSearchParams())[0].review_id`).

- `describe('apiReviewQueue')`:
  - **lists pending reviews with transaction details**: one txn with `category: null` (newly-routed shape) and one with `category: 'Shopping', category_confidence: 0.55` (backfilled shape); both queued. Assert 2 rows; the NULL-category row has `current_category: null`, `date`, `description`, `amount`, `suggested_category: 'Transport'`, `confidence: 0.55`; the backfilled row has `current_category: 'Shopping'`.
  - **drops rows once resolved**: after confirming one, the queue lists only the other.
- `describe('apiConfirmReview')`:
  - **applies the suggested category, marks verified, and resolves the review atomically**: seed txn (category NULL) + pending row (`'Transport'`, 0.55). Call `apiConfirmReview`. Assert: `success: true`, `category: 'Transport'`; direct `SELECT` on the txn row → `category = 'Transport'`, `category_confidence = 0.55`, `user_verified = 1`; direct SELECT on the review row → `status = 'resolved'`; `apiReviewQueue` returns `[]`.
  - **errors on unknown or already-resolved review id**: call twice — second result `{ success: false }`; unknown id 999999 → `{ success: false }`.
- `describe('apiCorrectReview')`:
  - **applies the chosen category, marks verified, resolves the review**: txn category NULL + pending row → correct with `{ category: 'Health' }` → txn `category = 'Health'`, `category_confidence = null`, `user_verified = 1`, review resolved, queue empty.
  - **clears a backfilled row's stale confidence**: txn `category: 'Shopping', category_confidence: 0.55` + pending row → correct → `category_confidence = null`, `user_verified = 1`.
  - **rejects an unknown category**: `{ category: 'Nonsense' }` → `success: false`, review still pending (direct SELECT), txn category still null.
  - (Also assert `'Dining'` — a static-list category — is accepted even when absent from the summary-derived list, pinning the two-source validation.)
- In the existing `describe('apiUpdateTransaction')`: **carries the user_verified flag** — `apiUpdateTransaction(db, id, { user_verified: 1 })` → row's `user_verified === 1`; a second row left untouched stays `0`.

### b. `src/__tests__/dashboard-server.test.ts` — RBAC over the wire

Inside the existing `describe('RBAC enforcement')`, reuse `setupRbac()` (it returns `{ db, base, adminToken, viewerToken }`). Seed within each new test: `insertTransactions(db, [{ date: '2026-01-01', description: 'Review Me', amount: -10 }])` + `addPendingCategorizationReview(db, txn.id, 'Transport', 0.55)` (import it; get txn id from the returned/queried row).

- **viewer can list reviews but cannot confirm**: `GET /api/reviews` with viewer token → 200, body is an array of length 1; `POST /api/reviews/1/confirm` with viewer token → 403; queue still lists the row (DB status still `'pending'`).
- **viewer cannot correct a review**: `POST /api/reviews/1/correct` body `{ category: 'Health' }` with viewer token → 403; txn still uncategorized.
- **admin can confirm a review**: confirm with admin token → 200 with `success: true`; assert DB effects (category, `user_verified = 1`, status `'resolved'`) and that `GET /api/reviews` with the viewer token now returns an empty array.
- (Unauthenticated `GET /api/reviews` → 401 is covered by the existing middleware; one cheap assertion inside the viewer test — fetch without token — is enough.)

### c. `src/__tests__/categorization-review-queries.test.ts` — pin the resolve helper's guards

Extend the existing file (it already has `createTestDb` setup and a seeded parent-transaction pattern):

- **resolveCategorizationReview confirm → applies and resolves; second resolve fails**: resolve once with `{ action: 'confirm' }` → `{ ok: true }`, txn row updated, review `'resolved'`; resolve again → `{ ok: false, error }` containing 'already resolved'; unknown id 999999 → `{ ok: false }` 'review not found'.

### d. Skill/doc

No automated tests exist for SKILL.md files (no loader test asserts their content — verify with a grep during the manual check). CHANGELOG is prose-only.

## Verification

1. `bun test src/__tests__/dashboard-api.test.ts src/__tests__/dashboard-server.test.ts src/__tests__/categorization-review-queries.test.ts` — touched suites green.
2. `bun test` — full suite green.
3. `bun run typecheck` — clean (covers `dashboard/api.ts`, `dashboard/server.ts`, `db/*`; excludes the UI).
4. Dashboard UI build: `cd src/dashboard/ui && npm install` (only if `node_modules` absent) `&& npm run build` — `tsc -b && vite build` must exit 0 and emit `dist/index.html`.
5. Legacy fallback still serves: existing test `GET / returns HTML` already passes for both build states; if the React build was produced in step 4, also confirm `dist/index.html` exists and re-run `bun test src/__tests__/dashboard-server.test.ts`.
6. **Manual check (acceptance criterion)** — drive the real flow against a throwaway profile:
   - Create profile dir `~/.openaccountant/profiles/manual-check-86` with `settings.json` containing `"categorizationConfidenceThreshold": 0.99` (routes everything to the queue deterministically).
   - One-off script (not committed, e.g. `/tmp/manual-check-86.ts`) run from the repo root:
     ```ts
     import { setActiveProfile } from './src/profile/index.js';
     setActiveProfile('manual-check-86');
     const db = (await import('./src/db/database.js')).initDatabase();
     const { insertTransactions } = await import('./src/db/queries.js');
     const { addPendingCategorizationReview } = await import('./src/db/categorization-review-queries.js');
     const rows = insertTransactions(db, [
       { date: '2026-09-18', description: 'WEIRD VENDOR LLC', amount: -42.5 },                          // confirm candidate (category null)
       { date: '2026-09-17', description: 'ODD SHOP', amount: -12.0 },                                  // correct candidate (category null)
       { date: '2026-09-01', description: 'OLD LOW CONF', amount: -10, category: 'Shopping', category_confidence: 0.55 }, // backfilled shape
     ]);
     addPendingCategorizationReview(db, rows[0].id, 'Transport', 0.55);
     addPendingCategorizationReview(db, rows[1].id, 'Health', 0.4);
     addPendingCategorizationReview(db, rows[2].id, 'Dining', 0.5);
     ```
   - Start the dashboard (`bun run src/index.tsx --profile manual-check-86`, or start the server standalone) and open `http://localhost:3141`:
     - Review tab is in the nav; lists 3 pending rows with dates, amounts, descriptions, suggested categories, confidence badges; the backfilled row also shows "currently 'Shopping'".
     - **Correct** `ODD SHOP` to `Health` and **Confirm** `WEIRD VENDOR LLC` → both rows disappear from the queue immediately (count drops to 1).
     - Transactions tab: both rows now show their applied category with the green `verified` badge; reload persists it.
     - Queue still lists the backfilled `OLD LOW CONF` row; its transaction still shows `'Shopping'` (category preserved until acted on).
   - Delete `~/.openaccountant/profiles/manual-check-86` afterwards.
7. Skill honesty: `grep -n update_category src/skills/smart-categorize/SKILL.md` returns nothing; the workflow references the Review tab.

## Rollback

Purely additive: one new db-layer function, three new routes, a new tab, one optional field on `TransactionUpdate`, doc edits. Reverting the commit restores the pre-slice state (queue fills silently with no UI); already-resolved rows keep `status = 'resolved'` and their transactions keep the human-applied categories — harmless data, no migration to undo.

## Out of scope (later slices of #55)

- A "reject/dismiss" resolution path (queue entries can only be confirmed or corrected here).
- Bulk confirm/correct; a pending-count badge on the tab/nav; queue surfacing in `transaction-search` or the chat agent.
- An `/api/categories` endpoint (the dropdown derives from the all-time summary, same as `App.tsx`).
- Legacy `html.ts` parity for the Review tab.
- The `entity-classify` tool's threshold/queue behavior.
- Re-running suggestions on queue entries (re-running `categorize` after an above-threshold run already clears stale rows).