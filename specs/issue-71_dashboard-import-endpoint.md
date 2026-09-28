# Plan: `POST /api/import` — commit client-parsed statement rows with dedup and ledger

Parent: #52 (decomposed) · This slice: #71 · Repo: `@openaccountant/wilson` (Bun + TypeScript, no build step)

## Goal

Add an admin-gated `POST /api/import` route to the dashboard server so an API caller can push
already-parsed bank-statement transactions into the active profile's database. The server **trusts
client-parsed rows and never re-parses raw content**. It mirrors the commit steps of the CLI
import pipeline (`importSingleFile` in `src/tools/import/csv-import.ts`): payload validation →
file-hash dedup → per-row `external_id` (client-supplied or derived identically to the CLI) →
row dedup → bulk insert → imports-ledger record → optional account auto-link → CLI-shaped result.

Auth semantics follow every other dashboard write route: **401** unauthenticated when auth is
enabled, **403** for viewers, **open** when auth is disabled (keeps the standalone `--dashboard`
demo working without credentials).

## Contract

```
POST /api/import
Content-Type: application/json

{
  "filename": string,            // required — recorded as the import's file_path and each row's source_file
  "bank": string,                // optional — fallback bank for rows lacking one; recorded in the imports ledger
  "fileHash": string,            // optional — client-computed sha256 of the raw file; enables file-level dedup
  "transactions": [              // required, non-empty array
    {
      "date": "YYYY-MM-DD",      // required
      "description": string,     // required (as produced by the client-side parser, already trimmed)
      "amount": number,          // required, finite (repo convention: negative = expense)
      "external_id": string,     // optional — e.g. OFX FITID; honored as-is when present
      "bank": string,            // optional per-row bank
      "merchant_name"?, "category"?, "category_detailed"?, "payment_channel"?,
      "pending"?: boolean, "authorized_date"?: "YYYY-MM-DD",
      "account_last4"?: string   // optional — drives account auto-link
    }
  ]
}
```

Responses (JSON, all 200 unless noted):

- **Imported** — `200`
  ```json
  { "status": "imported", "transactionsImported": 3, "transactionsSkipped": 0,
    "transactionsLinked": 0, "dateRange": { "start": "2026-01-15", "end": "2026-01-20" },
    "message": "Imported 3 transactions from chase-2026-01.csv (2026-01-15 to 2026-01-20)." }
  ```
- **File-hash skip** — `200`, nothing inserted:
  ```json
  { "status": "skipped", "transactionsImported": 0, "transactionsSkipped": <prior transaction_count ?? 0>,
    "previouslyImported": { "filePath": "...", "importedAt": "...", "transactionCount": 3 },
    "message": "This file was already imported on <imported_at> (<n> transactions)." }
  ```
- **All rows duplicates** — `200`, `status: "skipped"`, `transactionsSkipped: N`,
  `message: "All N transactions already exist (skipped as duplicates)."`
- **Validation failure** — `400`: `{ "status": "failed", "transactionsImported": 0, "transactionsSkipped": 0, "error": "...", "message": "..." }`

The response shape mirrors the CLI import result (`SingleFileResult` in `csv-import.ts`):
`status`, `transactionsImported`, `transactionsSkipped`, `dateRange`, `message` (+ optional
`transactionsLinked`, `previouslyImported`, `error`).

## Files to touch

| File | Change |
|---|---|
| `src/tools/import/external-id.ts` | **New.** `computeExternalId()` extracted verbatim from `csv-import.ts` so both import paths share one derivation (see "Cross-path dedup" below). |
| `src/tools/import/csv-import.ts` | Delete the local `computeExternalId`, import it from `./external-id.js`. No behavior change. |
| `src/dashboard/api.ts` | Add `apiImport(db, body)` handler + request/result types. |
| `src/dashboard/server.ts` | Add the `/api/import` route with the `canWrite` gate, mapped status codes. |
| `src/__tests__/dashboard-import.test.ts` | **New test file** (CI runs each test file in its own process, so a separate file keeps that fast). |
| `CHANGELOG.md` | One `feat:` bullet under `## [Unreleased] → ### Features` (repo convention, see the #34 entry). |

## 1. Extract `computeExternalId` — `src/tools/import/external-id.ts` (new)

The CLI derives row ids as `csv-` + first 16 hex chars of `sha256(`${date}|${description}|${amount}`)`.
The endpoint must use the **identical** derivation so the same statement imported via CLI or API
dedups against each other. Extract the function byte-for-byte:

```ts
import { createHash } from 'crypto';

/**
 * Compute a per-row external_id for transactions that don't have one.
 * Shared by the CLI file-import pipeline and the dashboard /api/import endpoint
 * so the same statement dedups across both paths. Do not change the derivation
 * in one place without the other.
 */
export function computeExternalId(t: { date: string; description: string; amount: number }): string {
  return `csv-${createHash('sha256').update(`${t.date}|${t.description}|${t.amount}`).digest('hex').slice(0, 16)}`;
}
```

(The parameter is the minimal structural shape the function actually uses, so `ParsedTransaction`
and plain request rows both satisfy it.) In `csv-import.ts`, remove the local copy and
`import { computeExternalId } from './external-id.js';`. `bun test src/__tests__/csv-import-tool.test.ts`
must still pass unchanged — this is a pure move.

## 2. Handler — `apiImport` in `src/dashboard/api.ts`

New imports at the top of `api.ts`:

```ts
import { createHash } from 'crypto';
// extend the existing '../db/queries.js' import with:
import { insertTransactions, checkImported, checkExternalId, recordImport, type TransactionInsert } from '../db/queries.js';
import { linkTransactionsToAccount } from '../db/net-worth-queries.js';
import { computeExternalId } from '../tools/import/external-id.js';
```

(`getTransactions` is already imported there. No import cycle: `external-id.ts` only pulls `crypto`,
and nothing in `tools/import/*` imports `dashboard/*`.)

Types (place near the other dashboard API types / above the new handler, after the Entities section):

```ts
export interface ImportTransactionInput {
  date: string;
  description: string;
  amount: number;
  external_id?: string;
  bank?: string;
  merchant_name?: string;
  category?: string;
  category_detailed?: string;
  payment_channel?: string;
  pending?: boolean;
  authorized_date?: string;
  account_last4?: string;
}

export interface ImportRequestBody {
  filename?: string;
  bank?: string;
  fileHash?: string;
  transactions?: ImportTransactionInput[];
}

export interface ImportResult {
  status: 'imported' | 'skipped' | 'failed';
  transactionsImported: number;
  transactionsSkipped: number;
  transactionsLinked?: number;
  dateRange?: { start: string; end: string };
  previouslyImported?: { filePath: string; importedAt: string; transactionCount: number | null };
  message: string;
  error?: string;
}
```

Handler skeleton (validation returns `failed`; the route maps `failed` → 400, everything else → 200 —
this mirrors how `apiInteractionDetail`'s null result drives the route's 404):

```ts
export function apiImport(db: Database, body: ImportRequestBody): ImportResult {
  // ── 1. Validate ──
  //   !body.filename (non-empty string)        -> failed, 'filename is required'
  //   !body.transactions                       -> failed, 'transactions is required'
  //   !Array.isArray(body.transactions)        -> failed, 'transactions must be an array'
  //   body.transactions.length === 0           -> failed, 'transactions must not be empty'
  //   per row i (1-based in the message):
  //     not an object / missing or empty date  -> failed, `transactions[i] must include date, description, and amount`
  //     empty description                      -> same
  //     typeof amount !== 'number' || !Number.isFinite(amount) -> same
  //     date not matching /^\d{4}-\d{2}-\d{2}$/ -> failed, `transactions[i].date must be YYYY-MM-DD`
  //     external_id present but not a non-empty string -> failed, `transactions[i].external_id must be a string`
  //   Every failure: { status: 'failed', transactionsImported: 0, transactionsSkipped: 0, error, message: error }

  // ── 2. File-level dedup ──
  //   fileHash = body.fileHash?.trim()
  //            ?? sha256(JSON.stringify(body.transactions))   // deterministic fallback when the client didn't hash
  //   const existing = checkImported(db, fileHash);
  //   if (existing) return { status: 'skipped', transactionsImported: 0,
  //     transactionsSkipped: existing.transaction_count ?? 0,
  //     previouslyImported: { filePath: existing.file_path, importedAt: existing.imported_at,
  //                           transactionCount: existing.transaction_count },
  //     message: `This file was already imported on ${existing.imported_at} (${existing.transaction_count} transactions).` };

  // ── 3+4. external_id + row-level dedup (mirror csv-import.ts steps 5–6) ──
  //   const newRows: ImportTransactionInput[] = []; let skipped = 0;
  //   for (const t of body.transactions) {
  //     const extId = t.external_id ?? computeExternalId({ date: t.date, description: t.description, amount: t.amount });
  //     if (checkExternalId(db, extId)) { skipped++; } else { newRows.push(t); }
  //   }
  //   if (newRows.length === 0) return { status: 'skipped', transactionsImported: 0, transactionsSkipped: skipped,
  //     message: `All ${body.transactions.length} transactions already exist (skipped as duplicates).` };

  // ── 5. Bulk insert (mirror toInsert in csv-import.ts) ──
  //   const txns: TransactionInsert[] = newRows.map((t) => ({
  //     date: t.date, description: t.description, amount: t.amount,
  //     bank: t.bank ?? body.bank,                    // row bank wins, top-level bank is the fallback
  //     source_file: body.filename,
  //     external_id: t.external_id ?? computeExternalId({ date: t.date, description: t.description, amount: t.amount }),
  //     merchant_name: t.merchant_name, category: t.category, category_detailed: t.category_detailed,
  //     payment_channel: t.payment_channel, pending: t.pending ? 1 : 0,
  //     authorized_date: t.authorized_date, account_last4: t.account_last4,
  //   }));
  //   const count = insertTransactions(db, txns);

  // ── Date range (mirror step 9: lexicographic sort works for YYYY-MM-DD) ──
  //   const dates = newRows.map((t) => t.date).sort();
  //   const dateRangeStart = dates[0]; const dateRangeEnd = dates[dates.length - 1];

  // ── Ledger record (mirror step 10) ──
  //   Ledger bank: body.bank, else the single bank value if all rows agree, else undefined.
  //   recordImport(db, { file_path: body.filename, file_hash: fileHash, bank,
  //     transaction_count: count, date_range_start: dateRangeStart, date_range_end: dateRangeEnd });

  // ── 6. Auto-link accounts by account_last4 (copy the block from csv-import.ts steps: last4 → accounts lookup) ──
  //   const last4Values = [...new Set(txns.map((t) => t.account_last4 ?? null).filter(Boolean))] as string[];
  //   let autoLinked = 0;
  //   for (const last4 of last4Values) {
  //     const account = db.prepare('SELECT id FROM accounts WHERE account_number_last4 = @last4 AND is_active = 1')
  //       .get({ last4 }) as { id: number } | undefined;
  //     if (account) autoLinked += linkTransactionsToAccount(db, account.id, { accountLast4: last4 });
  //   }

  // ── 7. Response ──
  //   let message = `Imported ${count} transactions from ${body.filename} (${dateRangeStart} to ${dateRangeEnd}).`;
  //   if (skipped > 0) message += ` ${skipped} duplicates skipped.`;
  //   if (autoLinked > 0) message += ` ${autoLinked} transactions auto-linked to accounts.`;
  //   return { status: 'imported', transactionsImported: count, transactionsSkipped: skipped,
  //     transactionsLinked: autoLinked, dateRange: { start: dateRangeStart, end: dateRangeEnd }, message };
}
```

Reuse rules (from the task contract): **no new SQL** for the commit path — `insertTransactions`,
`checkImported`, `checkExternalId`, `recordImport`, `linkTransactionsToAccount` are the only DB
primitives; the only inline `prepare()` allowed is the accounts-by-last4 lookup copied from
`csv-import.ts` (it lives in the tool, not `db/queries.ts`, so copying it is the faithful mirror).

Behavioral notes to preserve parity with the CLI:

- **No intra-batch dedup** — the CLI checks each row against the DB only; two identical rows inside
  one payload both insert (same behavior here). Do not "fix" this in this slice.
- **`fileHash` fallback**: when the client omits it, hash the canonical JSON of the transactions
  array. This is best-effort (key order from the sender can differ between runs); row-level dedup
  via `external_id` is the real guarantee. Note it in a code comment.
- **`external_id` is computed from the row exactly as sent** — client parsers already trim
  descriptions and normalize dates, which is what makes CLI and API hashes agree.
- Empty/blank `fileHash` string is treated as absent (trim then check).

## 3. Route — `src/dashboard/server.ts`

1. Add `apiImport` to the existing `import { ... } from './api.js'` list, and
   `import type { ImportRequestBody } from './api.js';` (or inline the body cast).
2. Add a section after the Entities routes and before `// ── Memories ──`, following the file's
   banner style:

```ts
// ── Import ──────────────────────────────────────────────────────────────────

if (path === '/api/import' && req.method === 'POST') {
  if (authEnabled && currentUser && !canWrite(currentUser.role)) {
    return Response.json({ error: 'Forbidden' }, { status: 403, headers });
  }
  const body = await req.json() as ImportRequestBody;
  const result = apiImport(activeDb, body);
  return Response.json(result, { status: result.status === 'failed' ? 400 : 200, headers });
}
```

Why this matches the house pattern: the `if (authEnabled && currentUser && !canWrite(...))` gate is
copy-paste identical to `/api/profiles/switch`, `/api/entities` POST, `/api/memories` POST, and the
transaction PATCH/DELETE routes — when auth is off, `currentUser` is `null` and the route is open;
when auth is on, the middleware above already returned 401 for missing tokens. `activeDb` (the
per-request active-profile DB) is already in scope. `await req.json()` throwing on malformed JSON
falls through to the existing outer catch (500) — same as every other POST route; do not add
special handling.

A `GET /api/import` intentionally falls through to the catch-all 404.

## 4. Tests — `src/__tests__/dashboard-import.test.ts` (new)

Mirror `dashboard-server.test.ts`'s spin-up-and-fetch scaffolding exactly:

```ts
import { describe, expect, test, afterEach } from 'bun:test';
import { createTestDb, makeTmpPath } from './helpers.js';
import { startDashboardServer, stopDashboardServer } from '../dashboard/server.js';
import { setInitialProfile, closeAll } from '../dashboard/db-manager.js';
import { createUser, enableAuth, disableAuth } from '../dashboard/auth.js';
import { initImportTool, csvImportTool } from '../tools/import/csv-import.js';
import { computeExternalId } from '../tools/import/external-id.js';
import { getTransactions } from '../db/queries.js';
import { insertAccount } from '../db/net-worth-queries.js';
import { writeFileSync, unlinkSync } from 'fs';

async function createServer() {
  const db = createTestDb();
  setInitialProfile('test', db);
  const result = await startDashboardServer(db, 0);
  return { db, server: result.server, base: `http://localhost:${result.server.port}` };
}
// afterEach: stop all servers, closeAll()  (copy the servers[] + afterEach block from dashboard-server.test.ts)
```

Shared fixture:

```ts
const ROWS = [
  { date: '2026-01-15', description: 'GROCERY STORE', amount: -85.5 },
  { date: '2026-01-18', description: 'ELECTRIC CO', amount: -120.0 },
  { date: '2026-01-20', description: 'RESTAURANT', amount: -45.0 },
];
const post = (base: string, body: unknown, token?: string) =>
  fetch(base + '/api/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
```

### Happy path + ledger (auth off ⇒ also proves open access when auth disabled)

1. **imports rows and records the ledger entry** — POST `{ filename: 'chase-2026-01.csv', bank: 'chase', fileHash: 'a'.repeat(64), transactions: ROWS }` → 200, `status: 'imported'`, `transactionsImported: 3`, `transactionsSkipped: 0`, `dateRange` = `{ start: '2026-01-15', end: '2026-01-20' }`. Then assert:
   - `GET /api/transactions` returns 3 rows with `source_file === 'chase-2026-01.csv'` and `bank === 'chase'`;
   - `db.prepare('SELECT * FROM imports').all()` has exactly 1 row: `file_path === 'chase-2026-01.csv'`, `file_hash === 'a'.repeat(64)`, `bank === 'chase'`, `transaction_count === 3`, `date_range_start === '2026-01-15'`, `date_range_end === '2026-01-20'`;
   - stored `external_id` values start with `csv-`.
2. **external_id derivation matches the CLI pipeline** — assert the first row's stored `external_id` equals `computeExternalId({ date: '2026-01-15', description: 'GROCERY STORE', amount: -85.5 })`.

### Dedup

3. **file-hash skip returns prior import info** — repeat test 1's POST verbatim → 200, `status: 'skipped'`, `transactionsImported: 0`, `previouslyImported` present with `importedAt` and `transactionCount: 3`; `GET /api/transactions` still returns 3; `imports` table still has 1 row.
4. **row-level dedup skips known external_ids** — POST `ROWS` again with a *different* `fileHash` and `filename: 'chase-2026-01-reexport.csv'` → 200, `status: 'skipped'` (all 3 dupes), `transactionsSkipped: 3`; DB row count unchanged.
5. **mixed batch imports only new rows** — fresh server; POST `ROWS`; then POST one new row + two of `ROWS` with another new `fileHash` → 200, `status: 'imported'`, `transactionsImported: 1`, `transactionsSkipped: 2`; DB has 4 transactions; `imports` has 2 rows.
6. **client-supplied external_id (OFX FITID) is honored** — rows with `external_id: 'FITID-123'` → stored `external_id === 'FITID-123'` (not a `csv-` hash); re-POSTing the same id with a new fileHash is skipped.

### Cross-path dedup (CLI ↔ API) — the acceptance-critical test

7. **a row imported via the API dedups when the CLI imports the same statement** — one server/DB:
   - POST `{ filename: 'chase.csv', transactions: [{ date: '2026-01-15', description: 'GROCERY STORE', amount: -85.5 }] }` → imported 1.
   - `initImportTool(db)`; write a temp Chase CSV containing that same row
     (`Transaction Date,Post Date,Description,Category,Type,Amount,Memo\n01/15/2026,01/16/2026,GROCERY STORE,Groceries,Sale,-85.50,` — copy the fixture style from `csv-import-tool.test.ts`, use `makeTmpPath('.csv')`, clean up in `afterEach`).
   - `await csvImportTool.func({ filePath })` → parsed result `data.transactionsImported === 0` and skipped ≥ 1 (the CLI's row-level `checkExternalId` hit), proving the derivations are byte-identical.
   - DB still has exactly 1 transaction.

### Validation → 400

8. Missing `filename` → 400, `status: 'failed'`, `error` mentions filename.
9. Missing `transactions` → 400.
10. `transactions: 'nope'` (non-array) → 400.
11. `transactions: []` (empty) → 400.
12. Row missing `amount`, and row with `amount: '85.5'` (string) → 400 each.
13. Row with `date: '01/15/2026'` (not `YYYY-MM-DD`) → 400.
14. None of the 400 paths insert rows or ledger entries (assert counts stay 0 after one of them).

### RBAC

15. **401 unauthenticated (auth on)** — `createUser(db,'admin','adminpass','admin')`, `enableAuth(db)`, POST without token → 401.
16. **403 viewer** — also create a viewer, log in via `POST /api/auth/login` (copy `setupRbac()` from `dashboard-server.test.ts`), viewer POST → 403 and DB unchanged (0 transactions).
17. **200 admin** — admin token POST → 200 and 3 rows inserted.
18. **open when auth disabled** — `enableAuth(db)` then `disableAuth(db)` (imported from `dashboard/auth.js`), POST without token → 200.

### Account auto-link

19. **rows with `account_last4` link to a matching account** — `insertAccount(db, { name: 'Chase Card', account_type: 'liability', account_subtype: 'credit_card', account_number_last4: '1234' })` (check `insertAccount`'s accepted fields in `src/db/net-worth-queries.ts` and use the right property name), POST rows carrying `account_last4: '1234'` → response `transactionsLinked === 2` and `GET /api/accounts/1/transactions` (or a direct `db` query `SELECT COUNT(*) FROM transactions WHERE account_id = ...`) shows the linked count. If `insertAccount` doesn't take `account_number_last4`, set it with a direct `UPDATE accounts SET account_number_last4 = '1234'` after insert.

## 5. CHANGELOG

Under `## [Unreleased] → ### Features`, add one bullet in the existing style, e.g.:

```
- feat: dashboard import endpoint — POST /api/import commits client-parsed statement rows into the active profile with file-hash + per-row external_id dedup (sharing the CLI's id derivation, so one statement dedups across both paths) and an imports-ledger record; admin-gated like other dashboard writes (#71)
```

## 6. Out of scope (do not build here)

- Dashboard UI button/form calling `/api/import` (the React app in `src/dashboard/ui/` is untouched).
- Server-side file parsing or multipart upload — the server never sees raw file content.
- Intra-batch duplicate collapsing (mirror the CLI; a potential later fix).
- Any change to the CLI pipeline beyond the mechanical `computeExternalId` extraction.

## 7. Verification

1. `bun run typecheck` — must pass (there is **no lint script** in `package.json`; CI gates are typecheck + `bun test`).
2. `bun test src/__tests__/dashboard-import.test.ts` — new tests green.
3. `bun test src/__tests__/csv-import-tool.test.ts` — still green after the extraction (parity proof).
4. Full suite the way CI runs it (each file in its own process):
   `for f in src/__tests__/*.test.ts; do bun test "$f" || FAIL=1; done; echo $FAIL` — or at minimum
   `bun test src/__tests__/dashboard-server.test.ts src/__tests__/dashboard-auth.test.ts src/__tests__/dashboard-api.test.ts src/__tests__/csv-import-tool.test.ts src/__tests__/dashboard-import.test.ts`.
5. **Manual check (required by acceptance criteria)** — with auth off:
   ```bash
   bun run src/index.tsx --dashboard --port 3141 &
   sleep 2
   curl -s -X POST http://localhost:3141/api/import \
     -H 'Content-Type: application/json' \
     -d '{"filename":"chase-2026-01.csv","bank":"chase","transactions":[{"date":"2026-01-15","description":"GROCERY STORE","amount":-85.50,"bank":"chase"},{"date":"2026-01-18","description":"ELECTRIC CO","amount":-120.00,"bank":"chase"}]}'
   # expect: {"status":"imported","transactionsImported":2,...,"dateRange":{"start":"2026-01-15","end":"2026-01-18"},...}
   curl -s 'http://localhost:3141/api/transactions'   # rows appear (filter/inspect as needed)
   ```
   Rows land in the active profile's real DB (harmless — re-running the same POST returns
   `status: "skipped"`); optionally clean up with `DELETE /api/transactions/:id` as admin or by
   removing the profile's DB. Re-run the identical curl to eyeball the file-hash skip
   (`previouslyImported` in the response).

## Acceptance criteria → coverage map

| Criterion | Covered by |
|---|---|
| Happy path / file-hash skip / row-dup skip / 400s tested with spin-up-and-fetch pattern | Tests 1–14 |
| external_id derivation identical to CLI (cross-path dedup) | Tests 2 and 7 |
| RBAC: 401 / 403 viewer / 200 admin / open when auth off | Tests 15–18 (+ test 1 runs with auth off) |
| Ledger row + date-range asserted | Test 1 |
| test / lint / typecheck pass | Verification steps 1–4 (no lint script exists — typecheck + tests are the gates) |
| Manual check: auth-off POST of Chase fixture → 200 + GET transactions shows rows | Verification step 5 |

## Risks / notes for the builder

- `imports.file_hash` is `NOT NULL UNIQUE` — that's what makes the file-hash skip a pure lookup;
  the fallback hash (hash of the JSON payload) also lands there, so two different clients posting
  identical payloads dedup too.
- `checkImported`/`checkExternalId`/`recordImport`/`insertTransactions` take `(db, ...)` — always
  pass `activeDb` (route) / the handler's `db` param, never the CLI tool's module-level handle.
- The 400 mapping lives in the route (`result.status === 'failed' ? 400 : 200`); do not throw from
  `apiImport` for validation errors — thrown errors become 500s via the outer catch, which would
  fail the acceptance criteria.
- Keep `computeExternalId`'s string template byte-identical during the move; a test pins it against
  the CLI, so drift fails loudly.
- `GET /api/transactions` returns rows newest-first with all columns — filter in the test on
  `description`/`source_file` rather than index.