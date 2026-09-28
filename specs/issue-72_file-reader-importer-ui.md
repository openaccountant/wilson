# Plan: Transactions-tab FileReader importer — drop a statement, preview the parse, commit on confirm

Parent: #52 (decomposed) · This slice: #72 · Blocked by: #71 — **already landed** (`POST /api/import`, shared `computeExternalId`, server tests all in the tree) · Repo: `@openaccountant/wilson` (Bun + TypeScript + React/Vite dashboard)

## Goal

On the dashboard's Transactions tab, a user drops (or picks) a CSV/OFX/QIF bank statement, reviews a parsed preview (detected bank/format, row count, date range, first rows + total), and — only after explicitly confirming — the rows POST to `/api/import` and appear in the list. Everything up to the confirm happens in the browser: the file is decoded and parsed client-side, hashed with WebCrypto, and nothing is sent to the server until the user clicks Import.

## Where things stand (verified on this worktree)

- **Server side is done (#71).** Route at `src/dashboard/server.ts:326-335` (`canWrite` admin gate → 403, `result.status === 'failed'` → 400, open when auth is off), `apiImport` at `src/dashboard/api.ts:714` with `ImportRequestBody` / `ImportTransactionInput` / `ImportResult` types exported from the same file. File-hash dedup (`checkImported`), row dedup (`checkExternalId` + `computeExternalId` from `src/tools/import/external-id.ts`), ledger record, `imports`-table skip with `previouslyImported` — all tested in `src/__tests__/dashboard-import.test.ts`. **This slice touches no server code.**
- **CLI pipeline to mirror (steps 1–4 of `importSingleFile`, `src/tools/import/csv-import.ts`):** read content as utf-8 string → hash it `createHash('sha256').update(content).digest('hex')` (line 101) → `detectFormat(content)` from `src/tools/import/detect-bank.ts` → parser switch (chase/amex/bofa/bofa-cc/generic/ofx/qif from `src/tools/import/parsers/`). Steps 5+ (external_id assignment, dedup, insert, ledger) are the server's job — the client sends parser rows as-is.
- **UI package** `src/dashboard/ui/`: React 19 + Vite 6 + Tailwind 4 + `vite-plugin-singlefile`; build script `tsc -b && vite build` → `dist/index.html` (gitignored). `src/dashboard/server.ts:57-61,120-121` serves `ui/dist/index.html` when present, else the **legacy fallback** `html.ts` — so the React build must exist for this feature to be visible at all. CI (`ci.yml`) runs only root `bun run typecheck` + per-file `bun test`; it never builds the UI.
- The ui dir has **no `node_modules`** and a tracked **`package-lock.json`** (npm, not bun) — UI deps install with `npm install` inside `src/dashboard/ui`.
- No React test tooling exists (no jsdom / @testing-library). Component behavior is verified manually; everything testable lives in the shared tree and runs under `bun test` (Bun provides `globalThis.crypto.subtle`, so the WebCrypto helper is testable without a DOM — verified).
- Root `tsconfig.json` **excludes `src/dashboard/ui`** from `tsc --noEmit`; everything under `src/tools/import/` is covered by root typecheck + `bun test`. That's why the browser-shared helpers go in the import tree.
- Sample fixtures that parse cleanly (verified with the real parsers): `data/csv/{chase,amex,bofa-checking,bofa-cc,generic}/standard.csv`, `data/csv/generic/debit-credit-cols.csv`, `data/ofx/v{1,2}-standard.ofx`, `data/qif/standard.qif`.

## Data flow (one file, end to end)

```
File (drop or picker — one at a time, .csv/.ofx/.qif)
  → await file.text()                browser decodes the bytes to a string
  → sha256Hex(content)               WebCrypto over the exact decoded text (same bytes node hashes)
  → parseStatementContent(content)   shared module: detectFormat → parser switch → ParsedStatement
       ↳ throws, or 0 rows           → inline error in the dialog, NO fetch
  → preview in Dialog                bank+format label, count, date range, first 5 rows, net total
  ── user clicks "Import to database" ──────────────────────────────────────────
  → POST /api/import { filename, bank, fileHash, transactions }   (rows mapped 1:1)
  → status imported | skipped        → close dialog, refetch list, banner = result.message
       (date range switches to the imported window if the current one doesn't cover it)
  → status failed / HTTP 400 / 403   → inline error in the dialog, list untouched
```

## Files to touch

| File | Change |
|---|---|
| `src/tools/import/client-import.ts` | **New.** Pure shared module: `parseStatementContent`, `sha256Hex`, `canCommitImport`. No Node imports (WebCrypto only) so it bundles in the browser and typechecks/tests under the root gates. |
| `src/__tests__/client-import.test.ts` | **New.** Parse over the per-bank fixtures, hash parity vs the CLI's hash expression, RBAC policy. |
| `src/dashboard/ui/vite.config.ts` | Add `@import-tools` resolve alias → `../../tools/import`. |
| `src/dashboard/ui/tsconfig.json` | Add matching `compilerOptions.paths` entry. |
| `src/dashboard/ui/package.json` | Declare `"csv-parse": "^5.6.0"` in dependencies (the parsers import `csv-parse/sync`; make the UI's dependency explicit). |
| `src/dashboard/ui/package-lock.json` | Regenerated by `npm install` inside the ui dir — tracked file, commit it. |
| `src/dashboard/ui/src/components/ImportStatementDialog.tsx` | **New.** Drop zone, parse preview, confirm/cancel footer, commit + inline errors, RBAC gating. Reuses the existing `Dialog` component. |
| `src/dashboard/ui/src/tabs/TransactionsTab.tsx` | "Import statement" header button; drop zone in the empty state; dialog mount; result banner; refetch + date-range switch. |
| `CHANGELOG.md` | One `feat:` bullet under `## [Unreleased] → ### Features`. |

**Do not touch:** `src/dashboard/html.ts` (legacy fallback gets no importer — the React build is the surface), anything in `src/dashboard/{server,api}.ts` (#71 complete), the parsers, `csv-import.ts`, `external-id.ts`.

## 1. Shared module — `src/tools/import/client-import.ts` (new)

```ts
import { detectFormat, type BankType } from './detect-bank.js';
import { parseChaseCSV } from './parsers/chase.js';
import { parseAmexCSV } from './parsers/amex.js';
import { parseBofA } from './parsers/bofa.js';
import { parseGenericCSV } from './parsers/generic.js';
import { parseOfx } from './parsers/ofx.js';
import { parseQif } from './parsers/qif.js';
import type { ParsedTransaction } from './parsers/chase.js';

export type { ParsedTransaction, BankType };

/** Result of parsing statement text client-side — everything the preview shows. */
export interface ParsedStatement {
  format: 'csv' | 'ofx' | 'qif';
  bank: BankType;
  transactions: ParsedTransaction[];
  dateRange: { start: string; end: string };
  total: number; // sum of signed amounts
}

/**
 * Parse raw statement text (CSV/OFX/QIF) — the same detection and parser switch
 * as importSingleFile in csv-import.ts (steps 3–4, minus the CLI's `bank`
 * override flag), with no Node/DB dependency so it runs in the browser and
 * under bun test. Throws when a parser rejects the content; callers must also
 * treat an empty transactions array as a parse failure.
 */
export function parseStatementContent(content: string): ParsedStatement {
  const detected = detectFormat(content);
  const bank = detected.bank ?? 'generic';
  let transactions: ParsedTransaction[];
  switch (detected.format) {
    case 'ofx': transactions = parseOfx(content); break;
    case 'qif': transactions = parseQif(content); break;
    case 'csv':
      switch (bank) {
        case 'chase':     transactions = parseChaseCSV(content); break;
        case 'amex':      transactions = parseAmexCSV(content); break;
        case 'bofa':
        case 'bofa-cc':   transactions = parseBofA(content); break;
        default:          transactions = parseGenericCSV(content); break;
      }
      break;
    default: transactions = parseGenericCSV(content); break;
  }
  const dates = transactions.map((t) => t.date).sort();
  return {
    format: detected.format,
    bank,
    transactions,
    dateRange: { start: dates[0] ?? '', end: dates[dates.length - 1] ?? '' },
    total: transactions.reduce((s, t) => s + t.amount, 0),
  };
}

/**
 * SHA-256 hex of a string via WebCrypto — byte-identical to the CLI pipeline's
 * `createHash('sha256').update(content).digest('hex')` (csv-import.ts), so a file
 * hashed in the browser dedups against one imported via CLI or the API. The hash
 * must be taken over the exact decoded text that was parsed and previewed.
 * globalThis.crypto.subtle exists in browsers and in Bun (tests).
 * Note: Blob.text()/TextDecoder strip a leading UTF-8 BOM where Node's
 * readFileSync keeps it — such files differ only in file-hash dedup; row-level
 * external_id dedup still prevents duplicates.
 */
export async function sha256Hex(content: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Whether the signed-in user may commit an import — mirrors the /api/import RBAC
 * (admin-only when auth is enabled, open otherwise; server.ts canWrite). A
 * not-yet-loaded auth status is treated as open (standalone-demo default); if
 * auth is actually on, the server still rejects the POST with 401/403 and the
 * dialog surfaces the error.
 */
export function canCommitImport(
  auth: { authEnabled?: boolean; user?: { role?: string } | null } | null | undefined,
): boolean {
  if (!auth?.authEnabled) return true;
  return auth.user?.role === 'admin';
}
```

Why this shape:

- **Deliberately does NOT import** `external-id.ts` (node `crypto`) or anything under `db/` — the server derives missing external_ids identically (`apiImport` step 3+4), so sending parser rows as-is is exactly what makes cross-path (CLI ↔ UI) dedup hold.
- `.js` import specifiers match repo style; Vite and the ui tsconfig (`moduleResolution: "bundler"`) both resolve them to the `.ts` files.
- The QIF parser transitively imports `src/categories/pfc-taxonomy.ts` — verified pure data, browser-safe.
- `csv-parse/sync` is browser-bundleable; declaring it in ui/package.json makes the dependency explicit.

## 2. UI wiring

### 2a. Build plumbing (three small diffs)

- `vite.config.ts` — extend `resolve.alias`:
  ```ts
  '@import-tools': path.resolve(__dirname, '../../tools/import'),
  ```
- `tsconfig.json` (ui) — extend `compilerOptions.paths`:
  ```json
  "@import-tools/*": ["../../tools/import/*"]
  ```
- `package.json` (ui) — dependencies: add `"csv-parse": "^5.6.0"`. Then run `npm install` inside `src/dashboard/ui` to refresh the tracked `package-lock.json`. csv-parse is already a root dependency, so the root `bun.lock` is untouched.

`tsc -b` in the ui package will now typecheck the shared tree under the ui's ES2022/DOM settings — safe: detect-bank, the parsers, and pfc-taxonomy are all pure. If the shared module ever grows a Node import, the ui build breaks loudly — that's the guardrail; keep the module pure.

### 2b. `ImportStatementDialog.tsx` (new component)

**Local mirror types — do NOT import from `src/dashboard/api.ts`** (it drags `bun:sqlite`/Node types into the ui tsc program):

```ts
interface ImportResponse {   // mirrors ImportResult in src/dashboard/api.ts
  status: 'imported' | 'skipped' | 'failed';
  transactionsImported: number;
  transactionsSkipped: number;
  dateRange?: { start: string; end: string };
  previouslyImported?: { filePath: string; importedAt: string; transactionCount: number | null };
  message: string;
  error?: string;
}
interface AuthStatus {       // mirrors GET /api/auth/status
  authEnabled: boolean;
  user: { id: number; username: string; role: string } | null;
  userCount: number;
}
```

Props:

```ts
interface ImportStatementDialogProps {
  open: boolean;
  onClose: () => void;
  seedFile?: File | null;                        // file dropped on the empty-state zone
  onSeedConsumed?: () => void;
  onImported: (result: ImportResponse) => void;  // imported OR skipped — parent closes + refetches + banners
}
```

State: `parsing`, `parseError`, `parsed: { statement: ParsedStatement; fileHash: string; filename: string } | null`, `committing`, `commitError`, `dragOver`.

Auth: `const { data: authStatus } = useApi<AuthStatus>('/api/auth/status');` — same pattern as SettingsTab's `SecuritySection` (public path, works signed-out). `const canCommit = canCommitImport(authStatus);`

Behavior, in order:

1. **File intake.** Hidden `<input type="file" accept=".csv,.ofx,.qif">` triggered by clicking the drop zone; `onDrop` takes `e.dataTransfer.files[0]` only (one file at a time; extras ignored); `onDragOver` → `preventDefault()` + highlight state, `onDragLeave` clears. Validate the extension is one of `.csv/.ofx/.qif` (the picker enforces it; drop validation must too) — otherwise inline error "Unsupported file type — drop a CSV, OFX, or QIF statement."
2. **Parse (client-side only — no fetch anywhere in this step).** Reset `parseError`/`parsed`; `parsing = true`; `const content = await file.text();` then `const fileHash = await sha256Hex(content);` then try `parseStatementContent(content)`. A throw → `parseError = err.message` (generic parser's "Could not auto-detect CSV columns…" is a good message). Empty `transactions` → `parseError = "No transactions found in <filename>."`. Success → store `{ statement, fileHash, filename: file.name }`. Reset `commitError` whenever a new file is processed. A `seedFile` prop is consumed by a `useEffect` (then `onSeedConsumed()`).
3. **Preview** inside the existing `Dialog` component (`title="Import statement"`): format/bank label — `format === 'csv' ? \`${bank.toUpperCase()} CSV\` : format.toUpperCase()` (same labeling as the CLI's `formatLabel`); `<n> transactions`; date range `start → end`; net total (signed, green/red like the table's amounts); first 5 transactions in a small table (Date / Description / Amount) with a `+N more` hint when there are more. Reuse the tab's `formatAmount`/`formatDate` helpers (export them from `TransactionsTab` or move to a tiny `src/dashboard/ui/src/format.ts` — either is fine).
4. **RBAC.** When `authEnabled && user?.role !== 'admin'`: preview still renders (client-side only), but the footer commit button is `disabled` with a hint beneath it: "Importing requires an admin account." When auth is off (standalone demo) or the user is admin: enabled.
5. **Commit** via the existing `api()` helper (attaches the bearer token from localStorage automatically):

   ```ts
   const body = {
     filename,                     // file.name of the parsed file
     bank: statement.bank,
     fileHash,                     // sha256Hex over the exact decoded text parsed above
     transactions: statement.transactions.map((t) => ({
       date: t.date, description: t.description, amount: t.amount,
       external_id: t.external_id, bank: t.bank,
       merchant_name: t.merchant_name, category: t.category,
       category_detailed: t.category_detailed, payment_channel: t.payment_channel,
       pending: t.pending, authorized_date: t.authorized_date,
     })),
   };
   ```

   (`account_last4` is intentionally omitted — `ParsedTransaction` has no such field; the server's account auto-link simply won't fire for UI imports, same as the CLI. `pending` goes as-is; `JSON.stringify` drops undefined and `apiImport` stores `pending ? 1 : 0`.)

   While committing: label "Importing…", disabled. Response handling:
   - `status: 'imported' | 'skipped'` → `onImported(result)`. The parent closes the dialog, refetches, and banners `result.message` — which already covers the re-import case ("This file was already imported on … (N transactions)." from file-hash dedup) and "All N transactions already exist (skipped as duplicates)." for row-level dedup.
   - `status: 'failed'` (mapped by the route to HTTP 400) or any thrown `Error` from `api()` (`API 403: Forbidden`, network) → `commitError = result.error ?? err.message`, the dialog **stays open** with the inline error, the list is untouched.

### 2c. `TransactionsTab.tsx` wiring

- **Header button.** Next to the count in the existing header row: "Import statement", styled like the app's other primary buttons (`className="bg-green-700 hover:bg-green-600 text-white text-sm font-medium px-3 py-2 rounded-lg transition-colors"`, cf. ChatTab/LlmTab). Always enabled — it only opens the dialog.
- **Empty-state drop zone.** The `data.length === 0` branch of the current empty box ("No transactions found.") becomes a drop zone: dashed border (`border-dashed`), centered text "Drop a bank statement here — CSV, OFX, or QIF — or click to browse." Draggable and clickable; `onDrop` → `files[0]` → `setSeedFile(file)` + open the dialog. The "No transactions match your filters." case (`data.length > 0`) stays a plain box. After a successful import the list repopulates and the zone disappears naturally.
- **Mount the dialog**: `const [importOpen, setImportOpen] = useState(false); const [seedFile, setSeedFile] = useState<File | null>(null);`
- **`handleImported(result)`**:
  1. Close the dialog.
  2. `refetch()` (the tab's `useApi` tick).
  3. **Date-range switch**: if `result.transactionsImported > 0 && result.dateRange` and the current `dateRange` doesn't cover it (`dateRange.startDate > result.dateRange.start || dateRange.endDate < result.dateRange.end` — ISO strings compare lexicographically), call `setDateRange({ startDate: result.dateRange.start, endDate: result.dateRange.end })` from `useAppState()`. The `apiPath` memo changes and `useApi` reloads into the imported window. Without this, fixture rows dated 2026-01 are invisible under the default current-month range and the manual check fails. If the range already covers the import, leave it alone.
  4. `setBanner(result.message)` — a dismissible inline line under the filter row, green-tinted (`border border-green-700/50 bg-green-900/30 text-text rounded-md px-3 py-2 text-sm`, cf. ChatTab's success chip) with an × button. `failed` results never reach the banner (the dialog keeps them inline).

## 3. Tests — `src/__tests__/client-import.test.ts` (new)

Pure module tests: no DB, no server, no DOM. Bun ships `crypto.subtle` (verified). Reuses the committed sample fixtures under `data/` — no new fixtures needed:

```ts
import { describe, test, expect } from 'bun:test';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseStatementContent, sha256Hex, canCommitImport } from '../tools/import/client-import.js';

const data = (...p: string[]) => join(import.meta.dir, '..', '..', 'data', ...p);
const read = (...p: string[]) => readFileSync(data(...p), 'utf-8');
```

### Parse over the existing per-bank fixtures

Pin counts/ranges to today's parser output (values verified on this worktree):

1. `data/csv/chase/standard.csv` → `format: 'csv'`, `bank: 'chase'`, 9 transactions, `dateRange { start: '2026-01-03', end: '2026-02-05' }`; first row: `date` matches `^\d{4}-\d{2}-\d{2}$`, non-empty trimmed description, finite `amount`, `bank: 'chase'`.
2. `data/csv/amex/standard.csv` → `'amex'`, 8 rows.
3. `data/csv/bofa-checking/standard.csv` → `'bofa'`, 7 rows.
4. `data/csv/bofa-cc/standard.csv` → `'bofa-cc'`, 7 rows.
5. `data/csv/generic/standard.csv` → `'generic'`, 8 rows.
6. `data/csv/generic/debit-credit-cols.csv` → `'generic'`, 7 rows (separate debit/credit merge path).
7. `data/ofx/v1-standard.ofx` → `format: 'ofx'`, `bank: 'ofx'`, 8 rows; at least one row carries an `external_id` (FITID must pass through to the POST body unchanged).
8. `data/ofx/v2-standard.ofx` → 5 rows.
9. `data/qif/standard.qif` → `format: 'qif'`, `bank: 'qif'`, 10 rows.
10. **Failures stay client-side.** `parseStatementContent('this is not a bank statement, just text')` throws (the generic parser's column-detection error); `parseStatementContent('Transaction Date,Post Date,Description,Category,Type,Amount,Memo\n')` (header-only) returns `transactions: []`. Both are the paths behind the dialog's inline error, and neither must ever reach the server.
11. **Server-contract net**: loop over every transaction from cases 1–9 and assert `/^\d{4}-\d{2}-\d{2}$/.test(date)`, non-empty description, `Number.isFinite(amount)` — a cheap regression net against `apiImport`'s 400 validation.

### WebCrypto hash parity with the CLI pipeline (acceptance-critical)

12. For **each fixture file from cases 1–9**, read as utf-8 (exactly like `readFileSync(filePath, 'utf-8')` in `csv-import.ts`) and assert `await sha256Hex(content) === createHash('sha256').update(content).digest('hex')` — the node expression is copied verbatim from `csv-import.ts:101`, so the test pins browser hashing against the real CLI pipeline, not a reimplementation.
13. Edge strings: `''`, `'💸 café ☕ ünïcödé'`, a >10 KB string — parity with node, result is 64-char lowercase hex, and two calls agree (deterministic).

### RBAC policy

14. `canCommitImport(null)` → `true`; `{ authEnabled: false }` → `true` (standalone demo); `{ authEnabled: true, user: { role: 'admin' } }` → `true`; `{ authEnabled: true, user: { role: 'viewer' } }` → `false`; `{ authEnabled: true, user: null }` → `false`.

The "second import of the same file reports duplicates skipped" behavior is server-side and already covered by `src/__tests__/dashboard-import.test.ts` (file-hash skip, row-dup skip, mixed batch — all landed with #71); the UI's part of that criterion is the manual flow in §5.

## 4. CHANGELOG

Under `## [Unreleased] → ### Features`, one bullet in house style:

```
- feat: dashboard statement importer — the Transactions tab gains a drag-and-drop/file-picker importer that reads CSV/OFX/QIF statements entirely in the browser (shared parse + WebCrypto-hash modules bundle with the UI via the @import-tools alias), previews detected bank/format, row count, date range and first rows in a dialog, and only POSTs to /api/import on explicit confirm; commit is admin-gated following the settings tab's auth-status pattern and re-imports surface the duplicates-skipped result (#72)
```

## 5. Verification

Gates (all must pass):

1. `bun run typecheck` — the new shared module is under `src/tools/import/`, inside the root program.
2. `bun test src/__tests__/client-import.test.ts`, then the full CI loop:
   `for f in src/__tests__/*.test.ts; do bun test "$f" || FAIL=1; done; echo $FAIL`
3. UI package builds cleanly: `cd src/dashboard/ui && npm install && npm run build` — `tsc -b` (now covering the shared tree) + `vite build` must succeed and produce `dist/index.html`. (No lint script exists — typecheck + tests are the gates, same as #71. `dist/` is gitignored; do not commit it.)

Manual check (the acceptance criterion's one minute — **the build step is required**, or the legacy fallback serves and the importer is invisible):

```bash
cd src/dashboard/ui && npm install && npm run build && cd -   # REQUIRED
bun run src/index.tsx --dashboard                              # port 3141, opens a browser
```

- Fresh database, Transactions tab: the drop zone shows in the empty state → drop `data/csv/chase/standard.csv` → preview shows "CHASE CSV · 9 transactions · 2026-01-03 → 2026-02-05" plus first rows and total → click "Import to database" → dialog closes, the date range switches to the imported window, rows appear, banner reads "Imported 9 transactions from CHASE CSV (2026-01-03 to 2026-02-05)."
- Drop the same file again → preview renders → Import → banner reads "This file was already imported on … (9 transactions)." and the list is unchanged (no double insert).
- Negative path: drop a `.txt`/random file → inline error in the dialog and DevTools shows **no** request to `/api/import`.
- RBAC spot-check: Settings → Security — create an admin and a viewer, enable auth, sign in as the viewer → parse/preview still works but "Import to database" is disabled with the admin hint; sign in as the admin → enabled. With auth disabled (default), the whole flow works without credentials.

## Acceptance criteria → coverage map

| Criterion | Covered by |
|---|---|
| Shared parse orchestration tested over per-bank fixtures (Chase, Amex, BofA, OFX, QIF, generic) | §3 tests 1–9 (`data/` fixtures, incl. bofa-cc and the debit/credit generic variant) |
| WebCrypto hash helper matches the CLI digest over the same content | §3 tests 12–13, pinned against the verbatim `csv-import.ts:101` expression |
| Unparseable file → error, nothing sent; re-import → duplicates skipped | §3 test 10 + §2b step 2 (no fetch before confirm); server skip already proven in `dashboard-import.test.ts`; UI flow in §5 |
| Commit control respects role rules | §3 test 14 (`canCommitImport`) + §2b step 4 wiring + §5 RBAC spot-check |
| test / lint / typecheck pass; UI builds cleanly | §5 steps 1–3 (no lint script exists — typecheck + bun test are the gates) |
| Manual check: build, serve, drop Chase CSV, preview, import, re-import | §5 manual script |

## Risks / notes for the builder

- **Hash over decoded text.** Hash exactly the string that was parsed and previewed (`file.text()` → `sha256Hex(content)`). `Blob.text()` strips a leading UTF-8 BOM where Node's `readFileSync` keeps it — such files can differ in file-hash dedup across paths, but row-level `external_id` dedup still prevents duplicates (noted in the `sha256Hex` doc comment; do not "fix" BOM handling in this slice).
- **Never import `src/dashboard/api.ts` types into the UI** — mirror the two small interfaces locally (§2b); importing it pulls bun:sqlite types into the ui tsc program.
- **Never import `external-id.ts` in the browser** (node `crypto`). The server derives missing external_ids identically from the rows as-sent — that's the cross-path dedup guarantee.
- **Keep `parseStatementContent` byte-faithful to csv-import.ts steps 3–4** (same switch, no CLI `bank` override flag) so the preview and the CLI always agree on which parser runs. No intra-batch dedup exists on either path — two identical rows in one file both insert; that's CLI-mirroring behavior, not a bug to fix here.
- **No server changes.** If you find yourself editing `server.ts`/`api.ts`, you've drifted out of scope; the endpoint's behavior (including 400-on-`failed`) is pinned by `dashboard-import.test.ts`.
- **`tsconfig.tsbuildinfo` in the ui dir is tracked** and will churn on build — commit or restore it, don't gitignore it here.
- The singlefile bundle inlines everything; the shared modules add only a few KB (parsers + the PFC taxonomy data table the QIF parser pulls in).
- The legacy dashboard (`html.ts`) intentionally gets nothing — the React build is the only surface for this feature.
- The `@import-tools` alias name was chosen to avoid colliding with CSS's `@import` at-rule in tooling; keep it (or rename consistently in all three places: vite.config, ui tsconfig, imports).