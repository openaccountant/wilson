# Plan: Confidence badge on dashboard transaction list Category cell

Decomposed from #55. After this lands, a user viewing the dashboard transaction list can see the confidence score behind every model-assigned category.

## What exists today (verified, do not re-implement)

- **API already flows the data.** `getTransactions` (`src/db/queries.ts:186`) does `SELECT * FROM transactions`, so every row returned by `GET /api/transactions` (`src/dashboard/api.ts:124` → `apiTransactions`, served at `src/dashboard/server.ts:315`) already carries `category_confidence: number | null` and `user_verified: number` (0/1). **No backend/SQL change is needed or wanted.**
- **Schema** (`src/db/schema.ts:10-11`): `category_confidence REAL`, `user_verified INTEGER DEFAULT 0`. Rows imported from a bank/CSV have `category_confidence` NULL; rows categorized by the `categorize` tool (`src/tools/categorize/categorize.ts`) store the model's 0–1 score.
- **React UI**: `src/dashboard/ui/src/tabs/TransactionsTab.tsx` renders the Category cell at the line `{tx.category_detailed ?? tx.category ?? (<span className="text-text-muted">Uncategorized</span>)}`. The UI `Transaction` type in `src/dashboard/ui/src/types.ts` does **not** yet declare `category_confidence` / `user_verified` — the field is silently dropped from the typed surface.
- **Legacy fallback dashboard**: `src/dashboard/html.ts`, `loadTransactions()` (~line 832-844) renders the category cell via `el('td',null,t.category||'\\u2014')`. Data comes untyped from `authFetch(...).json()` so any new field access is fine.
- **Styling**: Tailwind v4 with `@theme` tokens in `src/dashboard/ui/src/styles/app.css` (`--color-yellow: #eab308`, `--color-green`, `--color-border-muted`, etc.), so utilities like `text-yellow`, `border-yellow/40`, `bg-yellow/10`, `text-text-muted` resolve. The existing `pending` badge in TransactionsTab (`text-[10px] px-1.5 py-0.5 rounded bg-border text-text-muted uppercase`) is the style precedent to mirror.
- **Threshold precedent**: the categorize tool auto-assigns at confidence ≥ 0.7 and queues < 0.7 for manual review (`src/tools/categorize/categorize.ts:157`). Use 0.7 as the high/low badge boundary so the badge matches what the model already treats as review-worthy.
- Root `tsc --noEmit` (package.json `typecheck`) **excludes** `src/dashboard/ui`; the UI is typechecked only by its own build (`tsc -b` inside `npm run build`).
- CI (.github/workflows/ci.yml) runs `bun run typecheck` and `bun test` per test file; it does not build the UI, but the acceptance criteria require the UI build to pass.

## Changes

### 1. `src/dashboard/ui/src/types.ts` — extend the typed contract

Add to `interface Transaction`:

```ts
  category_confidence: number | null;
  user_verified: number;
```

(`user_verified` is a sqlite INTEGER 0/1, hence `number`.)

### 2. `src/dashboard/ui/src/tabs/TransactionsTab.tsx` — confidence badge in the Category cell

Add a small local constant near the top:

```ts
/** Confidence at or above which the categorize tool auto-assigns (src/tools/categorize). */
const CONFIDENCE_REVIEW_THRESHOLD = 0.7;
```

In the Category `<td>`, wrap category text + badge in an inline flex row so the badge sits right next to the category name:

```tsx
<td className="px-4 py-3 text-text-secondary text-xs">
  {tx.category_detailed ?? tx.category ? (
    <span className="inline-flex items-center gap-1.5">
      {tx.category_detailed ?? tx.category}
      {tx.user_verified ? (
        <span
          title="Verified by you"
          className="inline-block text-[10px] px-1.5 py-0.5 rounded border border-green/40 bg-green/10 text-green"
        >
          verified
        </span>
      ) : tx.category_confidence != null ? (
        <span
          title={tx.category_confidence < CONFIDENCE_REVIEW_THRESHOLD ? 'Low model confidence — worth reviewing' : 'Model confidence'}
          className={`inline-block text-[10px] px-1.5 py-0.5 rounded border font-mono ${
            tx.category_confidence < CONFIDENCE_REVIEW_THRESHOLD
              ? 'border-yellow/40 bg-yellow/10 text-yellow'
              : 'border-border bg-border-muted/60 text-text-muted'
          }`}
        >
          {Math.round(tx.category_confidence * 100)}%
        </span>
      ) : null}
    </span>
  ) : (
    <span className="text-text-muted">Uncategorized</span>
  )}
</td>
```

Badge semantics (this is the visual-distinction acceptance criterion):

- **High confidence (≥ 0.7)** or **user-verified**: calm/neutral — muted gray text on faint background; verified rows get a green `verified` badge instead of a machine score.
- **Low confidence (< 0.7)**: attention-drawing — yellow text/border/tint (`--color-yellow` token), same badge shape as the `pending` badge.
- **No stored confidence** (bank/import rows): render category text only — **no badge, no fabricated score**. Uncategorized rows keep their current muted "Uncategorized" label and also get no badge.

Keep it as a pure render change: no new state, no API calls, no new component file needed (a tiny local function `ConfidenceBadge({ tx })` returning the span-or-null is fine if it keeps the JSX readable).

### 3. `src/dashboard/html.ts` — legacy fallback, plain text only (no parity required)

In `loadTransactions()`, change the category cell append so a stored confidence renders as plain text after the category name (and a verified marker replaces it), matching the file's existing `'\\u2014'` escaping style inside the template literal:

```js
var catTd = el('td',null,t.category||'\\u2014');
if (t.user_verified) { catTd.textContent += ' \u2713'; }
else if (t.category_confidence != null) { catTd.textContent += ' (' + Math.round(t.category_confidence * 100) + '%)'; }
tr.appendChild(catTd);
```

Notes:
- This is safe against the edit flow: `startEdit` reads `t.category` from the row object (not the cell text) and `cells[3].replaceChildren(ci)` wipes the appended text when editing — no breakage.
- `t` is untyped (`authFetch(...).json()`), so no TS friction; root `tsc` typechecks this file, so keep the code style identical to surrounding vanilla JS.

### 4. `src/__tests__/dashboard-api.test.ts` — pin the API contract

In the existing `describe('apiTransactions', ...)` block, add (use `daysAgo` from `./helpers.js`, already exported; `insertTransactions` supports `category_confidence` via `TransactionInsert`):

```ts
test('transactions carry their category confidence', () => {
  const db = createTestDb();
  insertTransactions(db, [
    { date: daysAgo(1), description: 'Model High', amount: -10, category: 'Dining', category_confidence: 0.92 },
    { date: daysAgo(2), description: 'Model Low', amount: -20, category: 'Shopping', category_confidence: 0.42 },
    { date: daysAgo(3), description: 'Bank Row', amount: -30, category: 'Utilities' },
  ]);
  const byDesc = (d: string) =>
    apiTransactions(db, new URLSearchParams()).find((t) => t.description === d)!;
  expect(byDesc('Model High').category_confidence).toBe(0.92);
  expect(byDesc('Model Low').category_confidence).toBe(0.42);
  expect(byDesc('Bank Row').category_confidence).toBeNull();
});

test('user_verified flag flows through the transactions API', () => {
  const db = createTestDb();
  seedTestData(db);
  db.prepare(`UPDATE transactions SET user_verified = 1 WHERE description = 'Grocery Store'`).run();
  const rows = apiTransactions(db, new URLSearchParams());
  const verified = rows.filter((t) => t.description === 'Grocery Store');
  expect(verified.length).toBeGreaterThan(0);
  for (const t of verified) expect(t.user_verified).toBe(1);
  for (const t of rows.filter((x) => x.description !== 'Grocery Store')) expect(t.user_verified).toBe(0);
});
```

These two tests are the "API data contract the badge renders" coverage required by the acceptance criteria. (There is no React test infra in `src/dashboard/ui` — no vitest/jest — so the badge itself is verified by the UI build plus the manual check; do not add a JS test framework.)

## Out of scope (do not do)

- Any backend/SQL/endpoint change — the field already flows through `SELECT *`.
- A UI affordance to *set* `user_verified` (PATCH doesn't support it; likely a sibling slice of #55). The badge only *reads* it.
- Feature parity in the legacy HTML dashboard beyond the plain-text confidence.
- Editing the CSV/XLSX export headers (`apiExportCsv` etc.) to include confidence.

## Verification

1. `bun test src/__tests__/dashboard-api.test.ts` — new tests pass.
2. `bun test` — full suite passes (CI runs each file in its own process; plain `bun test` is fine locally).
3. `bun run typecheck` — root tsc passes (covers `html.ts`).
4. Dashboard UI build: `cd src/dashboard/ui && npm install` (skip if `node_modules` already present) `&& npm run build` — `tsc -b && vite build` must exit 0 and emit `dist/index.html`.
5. Manual (operator-facing, per acceptance criteria): start the app (`bun run start`, dashboard auto-starts on port 3141 — vite dev proxy targets it), open the Transactions tab: a model-categorized row shows its confidence badge (yellow when < 70%), a bank/imported row shows no badge, and a `user_verified` row shows the green `verified` badge instead.

## Files touched (complete list)

1. `src/dashboard/ui/src/types.ts` — add 2 fields to `Transaction`.
2. `src/dashboard/ui/src/tabs/TransactionsTab.tsx` — badge rendering + threshold constant.
3. `src/dashboard/html.ts` — plain-text confidence in legacy table (~line 842).
4. `src/__tests__/dashboard-api.test.ts` — 2 new contract tests.