# Plan: Auto-book executes only through the visible confirmation gate

**Repo:** `/home/jd/.spf/watch/wilson/worktrees/issue-94` (branch `spf-watch/94-auto-book-executes-only-through-the`, base = `origin/main` HEAD `ec75bff` — **#93 and #92 are already landed on this branch**, so the Demo tab and the agent trace exist here).
**Issue:** #94, decomposed from #58; parent artifact #91. Blocked-by #93 is satisfied (commit `ec75bff`).
**Outcome:** On a predicted transaction in the Demo tab's agent trace, an explicit **"Auto-book this"** action opens a visible confirmation naming the exact change (which transaction, from/to category); the booking write — through the existing transaction update path — executes **only** after explicit approval through the dashboard's WebMCP tool-gate substrate (spec-50). Denying leaves the data untouched and says so. Never silently, including demo mode.

## Grounding — what exists today (all verified on this worktree)

- **Spec-50 substrate is fully landed (#99, `cc74c17`), reusable as-is:**
  - `src/mcp/engine.ts` — grants + prepare/commit protocol. `prepareOperation` (validates a **grant** for source `'webmcp'`, computes the delta via `prepareMutation`, creates the pending operation), `approveWebMcpOperation` (mints a one-shot token, consumes it, commits), `rejectOperation`, `exposedTools` (empty until grants exist), `listCatalog`, grant create/revoke/revoke-all.
  - `src/mcp/store.ts` — durable `mcp_grants` / `mcp_operations` / `mcp_approval_tokens` (schema.ts:488–535, migration v26). `OPERATION_TTL_MS = 5 * 60 * 1000`; expired pending ops are swept by `expireStaleOperations`.
  - `src/mcp/tool-catalog.ts` — the shared catalog. **`categorize_transaction` is already a mutating tool** whose `commitMutation` calls `updateTransaction(db, id, {category, entity_id}, expectedRevision)` — **this is the existing transaction update path** (same `updateTransaction` the REST `PATCH /api/transactions` route uses, with the revision precondition). `prepareMutation` already resolves the real row and computes `{transactionId, revision, before:{category,entity_id}, after:{…}, summary: 'Categorize "<description>" (<date>) as "<category>"'}`. `toolAnnotations` marks mutating tools `consequentialHint: true`.
  - `src/dashboard/webmcp-bridge.ts` — the in-page bridge: grant panel (🤖 "Agent access", bottom-left; checkbox per catalog tool; Apply/Revoke all), confirmation card (bottom-right overlay) rendering the server-computed before/after delta with Approve/Reject, poller for pending ops (1.5 s), per-tab `sessionGeneration` in `sessionStorage` key `wilson_mcp_session_generation` (fresh per tab, never shared), tool registration only for granted tools (AbortController unregister, 10 s resync).
  - `src/dashboard/mcp-routes.ts` — HTTP routes: `/api/mcp/catalog|tools|grants|read|prepare|operations[/:id/approve|reject]`. Scope (role/profile/origin/sessionGeneration) is re-derived server-side from the request; never trusted from the client.
  - Tests already pinning the substrate: `src/__tests__/mcp-store.test.ts`, `mcp-tool-catalog.test.ts`, `mcp-bridge-server.test.ts` ("zero grants means zero exposed tools", "admin can grant and use a mutating tool end to end (prepare -> approve -> committed)", "revoke-before-commit …", "duplicate commit attempt …", "stale revision …", "viewer role is blocked from granting a mutating tool").
- **#93 agent trace is landed:** `src/demo/statement-trace.ts` (four steps `import → embed → predict → reconcile`; `predictStep` is strictly display-only — **no DB access by design**, pinned by `statement-trace.test.ts:146`); `src/dashboard/api.ts:1141` `apiDemoTraceStep` dispatcher; route `POST /api/demo/trace/step` at `src/dashboard/server.ts:512` (import step mirrors `/api/import`'s `canWrite` 403). UI: `src/dashboard/ui/src/demo/AgentTraceSection.tsx` (586 lines) — drop zone, four-node flow diagram with `pending/running/done/skipped/error` states, embed table (click a row → re-predict), predict card showing `description → category (similarity …)` plus the chip **"prediction only — nothing written"**, reconcile hint cards. The import detail carries `importedIds: number[]` (sorted) — **descriptions and ids are not currently joined anywhere**.
- **The gap the card has today:** `prepareMutation` computes a human `summary` (names the transaction + target category) but `createOperation` (store.ts:207) does **not** persist it, and the bridge card (`webmcp-bridge.ts:131`) renders only the key/value delta table — so the confirmation names the *field* change but not *which transaction*. That is the one substrate gap this slice closes.
- **Vendored fixture:** `demos/fixtures/august-2026-chase.csv` — 34 rows. First row is `PAYROLL DEPOSIT - ACME CORP` (+3200.00), which appears **twice** in August; `MAPLE AVE APARTMENTS RENT` appears once. So the *default* predicted row is ambiguous (2 candidate transactions) and the candidate-picker is a first-class demo beat, not an edge case.
- **Dashboard UI build:** React 19 + Vite + Tailwind, `src/dashboard/ui/`; manual gate `cd src/dashboard/ui && npm install && npm run build` → `dist/index.html` (root `tsconfig.json` excludes ui sources). Pure DOM-free modules under the ui tree are testable from root `bun test` (established pattern: `showdown-ui-core.test.ts` importing `../dashboard/ui/src/demo/core.js`). Cross-tree imports from the ui use the vite alias + tsconfig `paths` pattern (`@import-tools/*` → `../../tools/import/*`, `vite.config.ts:61`).
- **Gates:** `bun run typecheck`; CI-style per-file test loop over `src/__tests__/*.test.ts`; the ui build. **There is no root `lint` or `build` script.**
- **RBAC:** `canCommitImport(authStatus)` (client-import substrate) is the admin predicate the trace section already uses for the import step; mutating WebMCP grants are admin-only (`grantLocalAccess` 403s viewers).

## Design decisions (and why)

1. **The booking write rides the substrate's real mutation path — no new write code.** Auto-book prepares the **existing** `categorize_transaction` WebMCP tool (`prepareMutation` → confirmation card → `commitMutation` → `updateTransaction` with the revision precondition). The demo section calls the same `/api/mcp/prepare` + `/api/mcp/operations/:id/approve|reject` routes any WebMCP client uses. There is no demo bypass, no "it's a demo, just write it" flag — the gate applies identically in demo mode because demo mode *is* this tab and these routes.
2. **The TUI approval semantics map onto the two substrate layers — do not invent a third.** The TUI prompt (`src/components/approval-prompt.ts`, `ApprovalDecision = 'allow-once' | 'allow-session' | 'deny'`) maps as:
   - **allow once** → the confirmation card's **Approve** (commits this one prepared operation; single-use token, idempotent per operation id).
   - **allow always (session)** → the **Agent access panel opt-in**: the attendee grants `categorize_transaction` to this tab's agent session; it shows in the exposed-tools list and is revocable at any time. It does **not** skip future confirmations — every mutating call still prepares and waits for a card (non-negotiable 1). For this reason a "don't ask again" button must **not** be added to the card.
   - **deny** → the card's **Deny** (operation `rejected`, nothing written).
3. **The card must name the transaction, not just the field delta.** Persist the server-computed `summary` from `prepareMutation` on `mcp_operations` (additive nullable column, migration v27) and render it as the card's context line. The summary is server-derived truth — consistent with the card's pinned principle ("always renders the structured delta the server computed in prepare — never the agent's own prose"). Card for auto-book then reads: human tool label ("Categorize Transaction"), `Categorize "MAPLE AVE APARTMENTS RENT" (2026-08-01) as "Home"`, delta table `category: — → Home`, Approve/Deny.
4. **Confirmation-card content becomes a pure, root-testable module.** Extract the card's *content model* (tool label, source label, summary line, delta rows, fallbacks) from `webmcp-bridge.ts` into `src/mcp/confirmation-card.ts` (browser-safe, zero imports). The bridge keeps only DOM assembly. This gives the "semantic context" requirement real test coverage without a browser, and the same model serves chat- and http-mcp-sourced cards.
5. **Grant posture is unchanged and re-pinned in the demo context.** Default state is zero tools exposed; the attendee opts in through the Agent access panel (which lists the full catalog, shows what's granted, and revokes any time); the mutating route rejects un-gated calls; a revoke between prepare and approve yields `stale`. All of this exists; the new tests pin the arc end-to-end in the auto-book flow.
6. **Which transaction? Resolved server-side, explicitly.** New read-only route `POST /api/demo/autobook/candidates {description, importedIds}` → exact-description matches among the freshly imported rows, as server truth `{id, date, description, amount, category}`. One match → prepare immediately; several (PAYROLL ×2) → the section shows the matching rows (date + amount + current category) and the attendee picks one — the confirmation card then names that exact row. Zero matches → honest error. This keeps the prediction step display-only (its pinned invariant is untouched) and avoids the UI guessing ids from parsed rows.
7. **One confirmation surface, not two.** The React section never renders its own approve/deny dialog. It prepares, then polls `GET /api/mcp/operations/:id` until the operation resolves (the bridge's poller shows the card). The section's node renders the *state* (awaiting / booked / denied / stale) — never a second set of buttons.
8. **State machine is pure and tested.** `src/dashboard/ui/src/demo/auto-book.ts` (DOM-free): grant lookup, phase transitions, outcome mapping, and the exact honest copy strings — unit-tested from root like `showdown-ui-core.test.ts`.

## Non-negotiables carried verbatim into the demo context (spec-50)

1. Every mutating call requires explicit visible confirmation — no silent autonomous writes.
2. Before granting, the attendee can see exactly which tools the agent session has access to, and revoke at any time.
3. Default state is zero tools exposed — the attendee opts in.

## Data flow (one auto-book, end to end)

```
Attendee taps "Auto-book this" on the predict card (predicted description → category)
  → GET /api/mcp/tools?sessionGeneration=<tab>          // exposed tools for THIS tab
       ↳ []  → node state 'needs-grant': "zero tools exposed — grant categorize_transaction
                to Wilson's agent session" + button that dispatches
                CustomEvent('wilson:open-agent-panel') → the bridge opens its grant panel;
                attendee opts in (sees the whole catalog, revocable), section re-checks
  → POST /api/demo/autobook/candidates {description, importedIds}
       ↳ 0      → honest error, nothing prepared
       ↳ 1      → prepare(row.id)
       ↳ N > 1  → phase 'choose': rows (date · amount · current category); attendee picks → prepare(id)
  → POST /api/mcp/prepare {sessionGeneration, grantId, tool:'categorize_transaction', args:{id, category}}
       ↳ 403 (no/revoked/foreign grant, viewer) → 'needs-grant' with the server's reason; NO operation, NO write
       ↳ 200 pending operation (summary + before/after computed server-side)
  → bridge poller renders THE confirmation card:
      "Confirm: Categorize Transaction" · "Requested by: this page (WebMCP)"
      summary: Categorize "MAPLE AVE APARTMENTS RENT" (2026-08-01) as "Home"
      delta:   category  — → Home        [Approve] [Deny]
  → section polls GET /api/mcp/operations/:id (800 ms, ≤5 min — OPERATION_TTL_MS)
       ↳ Approve → commitMutation → updateTransaction(revision-checked) → outcome 'committed'
            node ✓ done; predict card shows "booked — category written";
            the Transactions tab shows the new category on the row
       ↳ Deny → outcome 'rejected' → "Auto-book denied — nothing changed"; row untouched
       ↳ row changed between prepare and approve → 'stale' → "the row changed — nothing written; review and retry"
       ↳ grant revoked between prepare and approve → 'stale' (substrate re-validates at commit)
```

Until the card is approved, **no write exists anywhere in this flow** — `prepare` only inserts a pending `mcp_operations` row; the DB write happens exclusively inside `commitMutation`, which runs only after `consumeApprovalToken` succeeds.

## Files to touch

| File | Change |
|---|---|
| `src/db/schema.ts` | Add `MCP_OPERATION_SUMMARY_COLUMN` const (`ALTER TABLE mcp_operations ADD COLUMN summary TEXT;`) with the same "ALTER-only convention" comment style as `TRANSACTION_REVISION_COLUMN` (schema.ts:477). Do **not** edit the v26 `CREATE TABLE`. |
| `src/db/migrations.ts` | Migration v27 `add_mcp_operation_summary` using the new const. |
| `src/mcp/store.ts` | `McpOperation` gains `summary: string \| null`; `createOperation` persists `params.summary ?? null` (add to the INSERT); `getOperation`/`listPendingOperations` already `SELECT *` so it flows out. |
| `src/mcp/engine.ts` | `prepareOperation` passes `summary: delta.summary` into `createOperation`. |
| `src/mcp/confirmation-card.ts` | **New, pure (zero imports, browser-safe).** `confirmationCardModel(op)` → `{ title, sourceLabel, summary, deltaRows }`: human tool label map (`categorize_transaction` → "Categorize Transaction", `edit_transaction` → "Edit Transaction", `tax_flag` → "Tax Flag", fallback = raw name), source label (`webmcp` → "this page (WebMCP)", `chat` → "dashboard chat", `http-mcp` → "external MCP client"), `summary` passthrough (null-safe), delta rows built from `before_json`/`after_json` with the bridge's current `formatValue` rules (null → "—", objects → JSON) — extracted verbatim from the bridge so rendering doesn't drift. |
| `src/dashboard/webmcp-bridge.ts` | (a) `McpOperation` interface gains `summary: string \| null`; card renders the summary line between the source line and the delta box, title from `confirmationCardModel().title`. (b) Additive: `window.addEventListener('wilson:open-agent-panel', …)` opens the existing grant panel (used by the demo's opt-in CTA). (c) Import the shared session-key constant (below) instead of the inline literal. Everything else (poller, panel, registration) unchanged. |
| `src/dashboard/webmcp-session.ts` | **New, pure.** `export const WILSON_MCP_SESSION_KEY = 'wilson_mcp_session_generation';` — imported by the bridge and the ui's auto-book module so the key can't drift; a root test imports it. |
| `src/demo/auto-book.ts` | **New.** `AutoBookCandidate {id, date, description, amount, category}`; `resolveAutoBookCandidates(db, {description, importedIds})` — exact description match, ids constrained to the imported set, chunked `IN (…)` SELECTs (≤500 params), sorted by date then id; `apiDemoAutoBookCandidates(db, body)` — dispatcher-style validation mirroring `apiDemoTraceStep` (400-style typed errors: body object, non-empty `description`, `importedIds` a non-empty number array ≤ `MAX_TRACE_ROWS`). **Read-only: no writes of any kind.** |
| `src/dashboard/server.ts` | One route beside the trace route: `POST /api/demo/autobook/candidates` → `Response.json({candidates})` / 400 on validation error. Read-only → no `canWrite` gate (same posture as other reads in the authed section). |
| `src/dashboard/ui/src/demo/auto-book.ts` | **New, pure.** `AUTOBOOK_TOOL = 'categorize_transaction'`; `pickGrant(exposedTools)` → grantId or null; `phaseFor(op, prior)` → `'awaiting' \| 'booked' \| 'denied' \| 'stale' \| 'error'` from the operation's status/outcome; `requiresChoice(candidates)`; the exact status-copy strings ("denied — nothing changed", "the row changed since you saw it — nothing was written", "still awaiting your decision on the confirmation card"). No React, no DOM, no fetch — decisions only. |
| `src/dashboard/ui/src/demo/AgentTraceSection.tsx` | The auto-book beat: "Auto-book this" button on the predict card (hidden/disabled when `!mayCommit` or the predict node isn't done); new fifth diagram node `autobook` after `reconcile` (`STEP_LABELS.autobook = 'Auto-book'`) with states `pending` ("not requested — tap Auto-book this above") / `needs-grant` (opt-in copy + panel-open button) / `awaiting` ("confirmation card open — approve or deny") / `done` ✓ (names the booked change) / `denied` / `stale` / `error`; candidate picker (date · amount · current category) when >1 match; predict-card chip flips to "booked — category written" for the booked row only. Driver: `api()` calls only — `/api/mcp/tools`, `/api/demo/autobook/candidates`, `/api/mcp/prepare`, `GET /api/mcp/operations/:id` poll (800 ms, 5-min cap → honest "still pending / expires" copy). One auto-book in flight per section. |
| `src/dashboard/ui/vite.config.ts`, `src/dashboard/ui/tsconfig.json` | Alias `@webmcp-session` → `../../dashboard/webmcp-session` (exact pattern of `@import-tools`, vite.config.ts:57–61). No new deps. |
| `src/__tests__/demo-auto-book.test.ts` | **New.** HTTP-layer gate tests (§Tests A). |
| `src/__tests__/mcp-confirmation-card.test.ts` | **New.** Card model tests (§Tests B). |
| `src/__tests__/demo-auto-book-ui.test.ts` | **New.** Pure client state machine (§Tests C). |
| `src/__tests__/mcp-store.test.ts` | **Update:** createOperation persists `summary` (one test). |
| `src/__tests__/mcp-bridge-server.test.ts` | **Update:** the end-to-end prepare→approve test also asserts the pending operation carries the summary (what the card renders). |
| `CHANGELOG.md` | One `feat:` bullet under `## [Unreleased] → ### Features`. |

**Do not touch:** `predictStep` (stays no-DB, display-only — its pinned test must keep passing), the four-step chain/orchestrator, `apiImport`, `updateTransaction`/`commitMutation` semantics, the TUI approval prompt (`src/components/approval-prompt.ts`), `chat.ts`'s approval flow (its cards render summary `null` gracefully), the grant/prepare/approve engine semantics, `mcp_operations`' existing columns, the bridge's poller/panel mechanics beyond the two additive changes above.

## Steps

### Step 1 — Schema: operation summary (migration v27)

`MCP_OPERATION_SUMMARY_COLUMN` + registry entry. Fresh DBs get it via the v26 CREATE followed by the v27 ALTER; existing profiles migrate in place (runner applies pending versions). `store.ts`: extend `McpOperation`, the INSERT, and `createOperation`'s params (`summary?: string \| null`). `engine.ts`: pass `delta.summary`. Chat's `createOperation` call passes nothing → `null` → the card renders the "no structured delta" fallback as today.

### Step 2 — Confirmation card model (pure) + bridge rendering

Create `src/mcp/confirmation-card.ts`; refactor `webmcp-bridge.ts`'s `showConfirmationCard` to assemble DOM from the model (title, source line, **new summary line** — visually emphasized, e.g. semibold — delta table, buttons). Formatting rules move verbatim. Add the `wilson:open-agent-panel` listener. The card must not gain a "don't ask again" affordance (decision 2).

### Step 3 — Server: candidates module + route

`src/demo/auto-book.ts` + `POST /api/demo/autobook/candidates` (§Files). Validation errors are 400s with precise messages, mirroring `apiDemoTraceStep`'s style. The route performs zero writes — assert-worthy by construction (no mutation helper is imported).

### Step 4 — Client: pure state machine + section wiring

`src/dashboard/ui/src/demo/auto-book.ts` per §Files. In `AgentTraceSection.tsx`: add the `autobook` node + `STEP_LABELS` entry (the four-node chain driver stays byte-for-byte in behavior), the predict-card button, the candidate picker, and the driver. Use the shared session key from `@webmcp-session` (alias per §Files). RBAC: when `mayCommit` is false, the button is not offered (the section already shows the admin hint); the server still enforces everything regardless.

### Step 5 — Tests

### Step 6 — CHANGELOG

Under `### Features`:
```
- feat: auto-book through the visible confirmation gate — the Demo tab's agent trace gains an explicit "Auto-book this" action on a predicted transaction; tapping it requires opting the tab's agent session in via the Agent access panel (zero tools exposed by default, revocable any time), then a confirmation card names the exact change (which transaction, from/to category, server-computed delta) and the booking write — the same updateTransaction path as the transactions editor — lands only on explicit approval; denying leaves the data untouched and says so (#94)
```

## Tests (all written or updated in this slice)

### A. `src/__tests__/demo-auto-book.test.ts` — HTTP layer (boot the server on port 0, `statement-trace-endpoints.test.ts` pattern; import the fixture via `POST /api/demo/trace/step`)

1. **Exposed-tools list starts empty and grants are revocable:** fresh `sessionGeneration` → `GET /api/mcp/tools` → `tools: []`; grant `categorize_transaction` → one tool with `grantId` + `annotations.consequentialHint === true` + `readOnlyHint === false`; `DELETE /api/mcp/grants/:id` → `tools: []` again. (`mcp-bridge-server.test.ts` pins fragments of this; this file pins the whole arc in the auto-book flow.)
2. **The mutating route rejects un-gated calls:** `POST /api/mcp/prepare` with an unknown grantId → 403; with a revoked grant → 403; with a foreign `sessionGeneration` → 403; in every case the transaction row is byte-identical afterwards (category NULL, revision unchanged).
3. **No write until the confirmation round-trip completes:** grant → prepare `categorize_transaction {id, category:'Home'}` → 200 pending → **assert the row's category is still unchanged and revision unmoved** → `POST /api/mcp/operations/:id/approve` → `{outcome:'committed'}` → row now `Home`, revision bumped exactly +1.
4. **Deny produces no data change:** prepare → reject → `{outcome:'rejected'}`; row unchanged; a repeat approve on the rejected op returns the stored outcome (never re-applies).
5. **Revoke-before-commit (auto-book context):** prepare → revoke → approve → `{outcome:'stale'}`; row unchanged.
6. **Candidates route:** after fixture import — `PAYROLL DEPOSIT - ACME CORP` → exactly 2 candidates (ids/dates/+3200.00, category null); `MAPLE AVE APARTMENTS RENT` → 1; unknown description → 0; candidates scoped to `importedIds`; validation failures (empty description, non-numeric/empty importedIds) → 400; repeating the POST changes nothing (read-only).
7. **The operation names the change:** the pending operation from (3) carries a `summary` containing the row's description, its date, and the target category (this is what the confirmation card renders).

### B. `src/__tests__/mcp-confirmation-card.test.ts` — card model (root-runnable, no DOM)

Title label map (categorize/edit/tax_flag/fallback), source labels per `source`, summary passthrough + null fallback, delta rows from/to with `formatValue` parity with today's bridge output (null → "—"), "No fields changed." / "No structured delta available for this action." fallbacks for chat-shaped ops, and **never** rendering raw JSON blobs.

### C. `src/__tests__/demo-auto-book-ui.test.ts` — pure client state machine

`pickGrant` (grantId for `categorize_transaction`; null when absent); `requiresChoice` (>1 candidates); `phaseFor` mapping (pending → awaiting, committed → booked, rejected → denied, stale → stale, unexpected → error with honest copy); the exact status strings ("denied — nothing changed", …) pinned so the deny path always *says so*.

### Updated existing tests

- `mcp-store.test.ts`: `createOperation` persists `summary`.
- `mcp-bridge-server.test.ts`: the end-to-end test asserts `GET /api/mcp/operations/:id` (and the pending queue) expose the summary.
- `statement-trace.test.ts` / `statement-trace-endpoints.test.ts`: must pass **unchanged** (the predict step and chain are untouched — that's the point).

## Verification

Gates (the repo has no root lint/build scripts — these are the gates):

1. `bun run typecheck`
2. CI-style loop: `for f in src/__tests__/*.test.ts; do bun test "$f" 2>&1 || FAIL=1; done; echo FAIL=$FAIL`
3. UI build (required for the feature to exist in the served dashboard): `cd src/dashboard/ui && npm install && npm run build` → `dist/index.html`; `tsconfig.tsbuildinfo` churns — commit or restore it (spec-93 note).

Manual checks (fresh profile, `bun run start`, dashboard → `#demo` → drop `demos/fixtures/august-2026-chase.csv`):

- **M1 — the money shot:** chain runs; the predict card shows `PAYROLL DEPOSIT - ACME CORP → Income (similarity …)` with "prediction only — nothing written" and the **"Auto-book this"** button. Tap it → the Auto-book node shows "zero tools exposed — grant categorize_transaction" with the opt-in button; the 🤖 Agent access panel opens listing the full catalog with nothing checked (default zero tools). Check `categorize_transaction` → Apply (the panel shows exactly what's granted; unchecking revokes).
- **M2 — the picker + the card:** tap Auto-book again → "2 transactions match — pick one" (both payroll rows: date · amount). Pick one → the confirmation card slides in bottom-right: `Confirm: Categorize Transaction`, `Requested by: this page (WebMCP)`, summary `Categorize "PAYROLL DEPOSIT - ACME CORP" (2026-08-01) as "Income"`, delta `category: — → Income`, Approve / Deny. **Approve** → the Auto-book node lights ✓ done; the predict card shows "booked — category written"; the Transactions tab shows the row categorized.
- **M3 — deny:** tap Auto-book on another prediction → **Deny** → the node shows "denied — nothing changed"; the Transactions tab row is untouched; nothing anywhere changed.
- **M4 — un-gated rejection:** revoke the grant in the panel (or use a second tab), tap Auto-book → the section reports the 403 reason; no operation appears, no card, no write.
- **M5 — demo-mode parity:** repeat M2/M3 entirely within the Demo tab — identical behavior; there is no demo bypass to find (the section's only mutating call is `/api/mcp/prepare`, and the write only ever happens inside the substrate's commit).

## Acceptance-criteria map

| Criterion | Covered by |
|---|---|
| No write until the confirmation round-trip completes (tests in this slice) | §A.3 (+ substrate pins `mcp-bridge-server.test.ts`) |
| Deny produces no data change | §A.4 + manual M3 |
| Exposed-tools list starts empty and grants are revocable | §A.1 + manual M1/M4 |
| The mutating route rejects un-gated calls | §A.2, §A.5 |
| Repo test / typecheck / build pass | §Verification 1–3 (no lint/build scripts exist) |
| Manual: tap auto-book → exact before/after named → approve → reflected; repeat → deny → nothing changed | §M2, §M3, §M5 |

## Risks / notes for the builder

- **The bridge is the one confirmation surface for WebMCP, HTTP-MCP, and chat.** Keep both bridge changes additive (summary line + panel-open listener); don't move the poller into React, don't add a second approval UI, don't add a "don't ask again" button (it would violate non-negotiable 1 — "always" lives in the grant panel).
- **`prepareMutation`'s summary is the only sanctioned card context.** Never render agent/UI-provided prose on the card — server-computed delta + summary only.
- **Don't touch the chain.** `predictStep` must remain DB-free (pinned test); the auto-book beat is additive state in the section, not a fifth chain step in `runStatementChain`.
- **Candidates are exact-description matches scoped to `importedIds`.** No fuzzy matching, no global DB search — the demo's semantic is "book THIS statement's row".
- **Polling parity:** the section's operation poll (800 ms, 5-min cap) mirrors the bridge's `PREPARE_POLL_TIMEOUT_MS` and the server's `OPERATION_TTL_MS`. On timeout the operation is still valid server-side — the copy must say the card is still open, not "failed".
- **Stale is a typed outcome, not an error:** render it as "the row changed — nothing was written; review and retry".
- **The ui build is a manual gate**; without it the legacy `html.ts` fallback serves and the feature is invisible. `@webmcp-session` must resolve in the vite build (mirror the `@import-tools` plumbing exactly).
- **`webmcp-session.ts` and `confirmation-card.ts` must stay import-free** — the bridge is bundled by Bun.build at server startup, and root tests import them without a DOM.
- **Migration discipline:** ALTER-only convention (schema.ts:477 comment); never edit the v26 CREATE TABLE.
- **Viewer RBAC:** mutating grants are admin-only (existing 403); the section hides auto-book behind the same `mayCommit` predicate it already computes for the import step; the server enforces regardless.

## Out of scope

- TUI approval-prompt changes; the CLI agent's `categorize` approval flow.
- Chat approval-card changes (summary renders only when present; chat keeps `null`).
- `edit_transaction` / `tax_flag` auto-book variants; bulk auto-book; entity assignment UI.
- Changes to the grant model, token mechanics, TTLs, or RBAC; the HTTP-MCP fallback.
- #95 privacy validator; #91 tab polish; QR/auth flows; writing embeddings; the showdown arms.