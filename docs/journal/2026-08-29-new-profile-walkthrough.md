# Journal: New-profile walkthrough (2026-08-29)

**Purpose:** Jd is walking through the "create a profile → sync data → use the
dashboard" flow with real financial data, cataloging bugs found along the way.
This journal is source material for a lesson in `../demo-cf` (see its
`CURRICULUM.md`) — it should stay narratable as a sequence of steps a learner
could follow, not a raw session transcript.

**Ground rule:** Jd drives every step that touches real financial data.
Claude does not read, import, or summarize the content of real transactions —
only structural signals (counts, error text, pass/fail) get reported back.

**Branch:** `worktree-fix+profile-switch-dashboard` (worktree at
`cli/.claude/worktrees/fix+profile-switch-dashboard/`)

---

## Bugs found

| # | Bug | Root cause | Fix | Status |
|---|-----|------------|-----|--------|
| 1 | `/profile switch <name>` crashed with `EADDRINUSE` | Re-execs the CLI as a child process (for clean DB/tool state) without first stopping the parent's dashboard server, which still holds port 3141 | Stop the dashboard server before respawning (`src/cli.ts`) | ✅ Fixed, verified live by Jd |
| 2 | No way to add a profile from the dashboard | `ProfileSection` (Settings tab) hid itself entirely with only one profile, and even when visible only offered a `<select>` over *existing* names | Always render the section; add a name input + "+ Add" button wired to the existing `/api/profiles/switch` (`src/dashboard/ui/src/tabs/SettingsTab.tsx`) | ✅ Fixed, pending live verification |
| 3 | `/api/profiles/switch` accepted unvalidated names into a filesystem path (`../../etc` style traversal) | No input validation on a now-network-facing endpoint | Added `^[a-zA-Z0-9_-]{1,64}$` validation client + server side (`src/dashboard/server.ts`) | ✅ Fixed |
| 4 | `/import <path>` failed with `ENOENT` on a path containing shell-escaped characters (e.g. `Jd\'s\ Finances.csv`) | The TUI editor isn't a shell — input is never tokenized by one — but the `/import` handler only stripped *surrounding* quotes, never unescaped backslash-escapes; typing shell-style escapes (natural muscle memory / pasted from a terminal) left literal backslashes in the path | Extracted parsing into `parseFilePathArg()` (`src/utils/path-arg.ts`), which unescapes `\X` -> `X` in addition to quote/`@`-stripping; wired into `src/cli.ts` | ✅ Fixed, verified live by Jd |
| 5 | Quicken "Transaction Report" CSV export failed with `Could not auto-detect CSV columns` | `parseGenericCSV` assumed line 1 is the header row; Quicken's report export prepends a title (`All Transactions`) and metadata line (`Report Created: ...`) first — unlike `parseBofA`, which already strips an analogous preamble, `parseGenericCSV` had no equivalent | Added `stripReportPreamble()` to `generic.ts` — scans the first 20 lines for one that looks like a real header (both a date-like and description-like column) and strips everything before it, same approach as `parseBofA`'s `stripNonCsvHeaders` | ⚠️ Necessary but not sufficient — see #6 |
| 6 | Bug #5's fix still didn't parse Jd's real export — same error persisted | Two compounding issues invisible from the error text alone: (1) the real preamble is deeper/richer than assumed (`Filter Criteria:` rows etc., still within the 20-line scan window so harmless) and, critically, (2) Quicken labels its description column **`Payee/Security`** (it covers investment-security rows too), which didn't exact-match `DESCRIPTION_PATTERNS`'s `payee` alternative, so `hasDesc` stayed false and the header row was never recognized; also found a leading UTF-8 BOM on line 1 (latent, didn't hit this file's header row but would corrupt one starting on line 1 elsewhere) | Diagnosed via a throwaway script that imported the real `generic.ts`/`detect-bank.ts` modules against the real file and printed only structural output (line shapes, header cell names, pass/fail, count, date range) — any line matching a decimal-amount pattern was redacted before printing, so no transaction content was read. Extended `DESCRIPTION_PATTERNS` to accept `payee(\s*/\s*security)?`; added a defensive leading-BOM strip | ✅ Fixed, confirmed against the real file: **779 transactions, 2026-01-01 to 2026-08-27** |
| 7 | Import crashed with `SQLiteError: UNIQUE constraint failed: transactions.external_id` instead of importing | `external_id` is a hash of date+description+amount; `checkExternalId()` only checks against rows already *in the DB*, never against other rows in the *same* incoming batch. Quicken's export legitimately contains two rows that hash identically (e.g. two same-day, same-amount, same-description transactions) — both pass the DB-only check, both get queued for insert, and the second one crashes the whole atomic `insertTransactions` batch (which rolls back cleanly — no partial-insert corruption, since it's wrapped in `db.transaction()`) | Track a `seenInBatch` Set alongside the existing DB check in `csv-import.ts`'s dedup loop — a same-batch repeat is now skipped exactly like a cross-file duplicate, instead of reaching the insert at all | ✅ Fixed, verified live by Jd — "Import was a success" |
| 8 | Dashboard Transactions tab showed a stray `0` next to every non-pending transaction's description | Classic React footgun: `{tx.pending && <span>pending</span>}` — `pending` is a SQLite `0`/`1` integer at runtime (the frontend `boolean` type is aspirational, nothing coerces it), so for every non-pending row (`pending === 0`) the expression evaluates to the number `0`, and React renders literal falsy-but-non-boolean values as text instead of skipping them | Changed to `{!!tx.pending && (...)}` in `TransactionsTab.tsx`. Codebase already knew this pattern elsewhere (`SettingsTab.tsx` uses `!!e.is_default`) — this was a one-off miss, not a systemic gap; grepped for the same bare-`&&`-on-a-0/1-field shape elsewhere in the dashboard UI, found none. Rebuilt the dashboard bundle (`bun run build` in `src/dashboard/ui/`) | ✅ Fixed, pending live verification |
| 9 | CSV import never associated transactions with an account — Jd correctly spotted this, worse than it looked | `ParsedTransaction` had no `account_name`/`account_last4` field at all, and `toInsert()` never forwarded either to `TransactionInsert` even where the DB column existed — the pre-existing "auto-link by account_last4" step was dead code for every CSV import. Quicken's combined "Transaction Report" export already names the real account per row via its own `Account` column, which `generic.ts` discarded entirely — exactly Jd's 5-accounts-in-one-file situation | Added `account_name` to `ParsedTransaction`; `generic.ts` detects an `Account`/`Account Name` column and captures it per row; `toInsert()` forwards it; auto-link step now also matches distinct `account_name` values against tracked accounts (exact, case-insensitive, only when unambiguous). Also found & fixed a related gap: `TransactionRow` was missing `account_id`/`account_name` entirely | ✅ Fixed for future imports; does **not** retroactively backfill the 766 already-imported rows (would need a one-off re-parse + `UPDATE ... WHERE external_id = ...`, not run without Jd's go-ahead) |

## Steps

### 1. Set up isolated worktree
- `EnterWorktree` → `cli/.claude/worktrees/fix+profile-switch-dashboard`, branch
  `worktree-fix+profile-switch-dashboard`.

### 2. Reproduce & fix bugs #1–#3
- Traced `/profile switch` to `src/cli.ts` — confirmed missing `stopDashboardServer` call.
- Traced dashboard add-profile gap to `src/dashboard/ui/src/tabs/SettingsTab.tsx`.
- Fixed both; added path-traversal validation while touching the now-network-facing endpoint.
- `bun run typecheck` clean; `bun test` — 200 existing + 3 new tests pass.
- Rebuilt the dashboard UI bundle (`bun install && bun run build` in `src/dashboard/ui/`)
  since it ships as a pre-built `dist/index.html`, not raw source.
- Committed as `0bf1332`.

### 3. Jd verifies live
- Ran `wilson` from the worktree, created a new profile named **Jd**, switched to it via
  `/profile switch Jd` — **no crash**. Bug #1 confirmed fixed.

### 4. First real task: import data into the `Jd` profile
- Real accounts in scope: a credit card, a robo-investing account, two bank/checking
  accounts, and a brokerage account — five in total.
- Personal and a side business run through the same accounts, uncategorized. This
  shaped the "what am I missing" plan below and became **Persona 1** for demo-cf
  (see [Personas](#personas-for-demo-cf) — scrubbed, no real institution/account detail).
- Recommended order worked out live (not yet executed): import each account
  individually → `link-transactions` (catch internal transfers between the five
  accounts before they double-count) → `entity-classify` (split personal/business
  *before* categorizing broadly) → categorize → review what's left uncategorized →
  `tax-flag` business-deductible items → `account-manage`/`balance-update` for the
  investment-account balances (categorization alone won't cover those) →
  `budget-set`/`budget-check` → `rule-manage` for recurring merchants → `goal-manage` →
  `alert-check`. One `anomaly-detect` pass before trusting the first budget's numbers.
- **Lesson for demo-cf:** most naive walkthroughs go straight from import to budget.
  A multi-account, comingled-finances persona is exactly the case that breaks that —
  worth a dedicated curriculum beat on *why* link → split → categorize → budget is
  the right order, not import → categorize → budget.

---

## Personas for demo-cf

Four reusable teaching personas, each exercising a different slice of the tool
registry. Persona 1 is scrubbed from this walkthrough — no real institution names,
account numbers, or amounts, just the *shape* of the situation.

### Persona 1 — "The Comingled Founder"
- **Accounts:** 5 — one credit card, one robo-investing account, two bank/checking
  accounts, one brokerage account.
- **Situation:** Runs a side business through personal accounts; nothing separated.
  Wants to import, sync, categorize, and budget, but the real problem underneath is
  untangling personal from business before any of those numbers mean anything.
- **Showcases:** `link-transactions` (internal transfers across 5 accounts),
  `entity-manage`/`entity-classify` (personal vs. business split), `tax-flag`
  (business deductions from comingled accounts), `profit-loss`.

### Persona 2 — "The New Grad"
- **Accounts:** 2 — one checking, one credit card, plus a student loan tracked as a
  recurring debt.
- **Situation:** First job, first real budget, paying down student debt while trying
  to start an emergency fund from nothing.
- **Showcases:** `budget-set`/`budget-check`, `goal-manage` (debt payoff + emergency
  fund goals), `savings-rate`.

### Persona 3 — "The Dual-Income Household"
- **Accounts:** 4 — one joint checking, two individual credit cards, one joint
  savings, plus a mortgage.
- **Situation:** A couple splitting who-pays-what across individual cards while
  sharing a joint account and a savings goal (house project, kid, vacation).
- **Showcases:** `net-worth`, `mortgage-manage`, `account-manage` across
  joint + individual accounts, budget categories that span two spenders,
  `goal-manage` for a shared goal.

### Persona 4 — "The Near-Retiree"
- **Accounts:** 3 — checking, a brokerage account, a retirement account.
- **Situation:** Less about day-to-day budgeting, more about net worth trend,
  withdrawal/savings rate, and catching fraud early given the larger balances at
  stake.
- **Showcases:** `net-worth` trend over time, `savings-rate`, `anomaly-detect`,
  `alert-check`.

### Persona 5 — "The Single Parent"
- **Accounts:** 1 — checking, fed by two income streams (hourly job + irregular
  child support).
- **Situation:** One income, paid hourly (so it varies week to week), childcare,
  school fees, and a margin thin enough that a bad week produces an overdraft fee.
- **Showcases:** `budget-set`/`budget-check` under real constraint, `category-manage`
  (childcare isn't a default category), `goal-manage` (a small, attainable goal
  rather than an aspirational one), `alert-check` (the whole point of this persona
  is catching the low-balance moment *before* the overdraft, not after).

---

## Built out: synthetic seed data (2026-08-29, later same day)

All 5 personas now have actual seed CSVs under `scripts/demos/personas/`, matching
demo-cf's existing `chase-demo.csv` convention (real bank parser formats, fictional
merchants/employers, one planted anomaly each). Full detail — including built-in
linkage/anomaly design per persona — is in
`scripts/demos/personas/README.md`; this entry just records how they were verified.

- Persona 1 gets two files (checking + card) since it's the only persona that needs
  `link-transactions` to demonstrate cross-account transfer matching — the two
  files share a $600 transfer that should resolve to one internal movement, not an
  expense + income pair.
- Verified every file against the **real parsers** (`parseBofA`, `parseAmexCSV`,
  `parseGenericCSV`) before writing them up, not just eyeballed: row count in ==
  transactions parsed out, and income/expense sign came out right post-parse
  (important for the generic-format personas, since that parser auto-negates if
  >60% of raw amounts are positive — verified none of them tripped that heuristic).
- Investment/retirement/mortgage accounts are called out as balance-only
  (`account-manage`/`balance-update`) rather than given a transaction CSV — there's
  no per-line history to synthesize for those in a one-month demo window.

## Revision: bank diversity, 75/10/15 goals, entities-vs-accounts (2026-08-29, later)

Jd asked for three things: (1) don't have every persona on the same bank, (2) every
persona targets 75% spend / 10% save / 15% invest, expressed as goals, and (3)
whether "accounts used for automatic separation" (life, business, home, investment,
vacation, retirement) are `entities`.

- **(3) answered by reading the tool source, not guessing:** `entity_manage`'s own
  description is "Manage *business* entities" — it's a business-vs-personal tagger,
  the right fit for exactly the "business" bucket. The other five buckets are
  `account_manage` records (a real separate account per purpose) optionally paired
  with a `goal_manage` target. Full mapping, and which buckets each persona has vs.
  deliberately lacks, is in the README now.
- **(2):** computed each persona's actual monthly income from their seed data and
  sized 10%/15% goal amounts off that, rather than inventing round numbers. Surfaced
  a real product gap while doing it: `goal_manage` has no percentage-of-income
  target, only a fixed dollar `targetAmount` — fine for steady-income personas, but
  Persona 5's income is genuinely irregular, so its goal figures go stale by
  design. Logged as a feature-request-worthy finding, not something to paper over
  in the demo data.
- **(1):** reassigned personas across wilson's full parser matrix — Chase+Amex
  (Persona 1), BofA (Persona 2), OFX (Persona 3), QIF (Persona 4, nicely on-theme
  given Jd's own next step), generic CSV (Persona 5). All five now exercise a
  different format.
- **Verification caught a real near-miss:** re-checked every file against the
  actual `detectFormat`/`detectBank` pipeline instead of just calling the target
  parser function directly (which is what the first verification pass did — a
  mistake in method, not just luck that it needed catching). Persona 1's original
  `card.csv` had `Date,Description,Amount` only; `parseAmexCSV` handled it fine
  when called directly, but `detectBank` requires a `Card Member` or `Account #`
  column to route a file to Amex at all — under real `/import`, it would have
  silently gone through the generic parser instead. Coincidentally still correct
  in this one case (Amex's sign convention matches generic's auto-negate
  heuristic), but that's luck, not verification. Fixed by adding `Card Member`.

**Filed:** [openaccountant/wilson#34](https://github.com/openaccountant/wilson/issues/34) —
percentage-of-income targets for `goal_manage`.

### Next: Jd's own import
Jd has a Quicken CSV export ready for their real `Jd` profile. Per the working
agreement, Jd runs `/import` themselves — no file content in this journal, only
the outcome once reported.

**Hit bug #4 live:** the real export's filename contains an apostrophe
(`Jd's Finances-export-2026-08-29.csv`). Two attempts, both `ENOENT`:
unquoted with shell escapes, then quoted with the same inner escapes still
present. Diagnosed and fixed per the table above — `bun run typecheck` clean,
`bun test` unaffected (3 pre-existing failures in `alerts.test.ts`, unrelated
to this change — confirmed by diff scope, not touched by this fix). Filename
itself confirmed to exist via `ls` only, per the working agreement (no file
content read). Awaiting Jd's retry to confirm the fix live, then the actual
import outcome (count/format/date range).

**Bug #4 confirmed fixed live** — retry with the identical shell-escaped command
produced a clean `Importing /Users/jdfiscus/Documents/Jd's Finances-export-2026-08-29.csv...`
(no stray backslashes), proving `parseFilePathArg` resolved the path correctly.

**Hit bug #5 immediately after:** `Could not auto-detect CSV columns. Found
headers: All Transactions, Report Created: 2026-08-29 11:52:17 -0400.` — the
real export is Quicken's "Transaction Report" CSV format (title + metadata
preamble before the real header row), not a plain transaction-per-row CSV.
Diagnosed and fixed per the table above using only the error text's header
names (no transaction rows read, per the working agreement) — `bun run
typecheck` clean, `bun test`: 1386 pass / 3 pre-existing-and-unrelated fail in
`alerts.test.ts` (same 3 as before this change, confirmed unrelated by diff
scope). Awaiting Jd's retry.

**Confusion round:** Jd renamed the export (apostrophe -> hyphen, same file)
between attempts, so the escaped-apostrophe `/import` retry pointed at a file
that no longer existed. Separately, Jd also tried `/skill import-transactions`
against the renamed file — exactly the path the original handoff flagged as
unreliable (no `.env`/LLM provider configured in this worktree). It reproduced
that prediction concretely: the tool call itself reported success
(`Imported transactions in 23ms`), but the model's follow-up text claimed a
header-detection failure (bug #5's symptom) that contradicts its own tool
result — a hallucinated narrative, not a real outcome. Tried to settle it
independently by checking the `Jd` profile's transaction count directly
(structural signal only), but `~/.openaccountant/profiles/Jd/data.db` is
encrypted at rest — can't be read outside the app. Asked Jd to re-run plain
`/import` (not the skill) against the current filename and paste the actual
result line.

**Both attempts kept failing identically** — turned out bug #5's fix wasn't
sufficient; see bug #6 above. Root-caused and fixed with a structural-only
diagnostic script (import the real parser modules, redact any line matching
a decimal-amount pattern before printing). Confirmed working against the
real file: **779 transactions, date range 2026-01-01 to 2026-08-27**. Jd
still needs to run the actual `/import` in the TUI to get them into the `Jd`
profile DB — the diagnostic only proved the parser now succeeds, it didn't
insert anything.

**Import confirmed successful.** Four real bugs (#4-#7) found and fixed along
the way to a single real-world CSV import — none of them hit by the demo-cf
personas' synthetic files, all of them by Jd's actual export. Worth a callout
in the demo-cf lesson: synthetic seed data validated against the real parser
pipeline is necessary but not sufficient — it won't surface format quirks
(shell-escaped filenames, report-style preambles, non-standard column names,
intra-file hash collisions) that only show up in a messy real-world export.

**Correction to the recommended order (self-caught, no code bug):** "link-transactions"
is not a skill and does not do internal-transfer matching. It's the
`link_transactions` *tool* (`src/tools/net-worth/link-transactions.ts`,
registered in `registry.ts`) — it assigns a transaction's `account_id` by
matching `account_last4`/bank/`account_name` against tracked accounts, which
is a different job (account association) from catching same-amount,
opposite-sign transfer pairs across accounts to avoid double-counting. Grepped
the codebase for actual transfer-pair handling: doesn't exist as a dedicated
mechanism. The closest thing is `categorize` applying a "Transfer" category
label to individual legs (an LLM judgment call per-transaction, not a
rules-based pair match) — whether that's enough to keep double-counting out
of `spending_summary`/budget totals is unverified, not something to assume.
The step that *does* match the original "split before categorizing" rationale
is the `multi-entity` skill (personal/business split via `entity_classify`,
paid tier) — recommended that instead of following `link_transactions`'s own
suggestion straight into `smart-categorize`. Pipeline description above and
in the Persona 1 showcase list should be read with this correction in mind;
not rewriting those sections retroactively since they document what was
believed at the time, but this entry is the correction of record.

**Import reconciled.** A subsequent `/skill import-transactions` run on the
same file (same `Jd` profile, confirmed by Jd) reported a fresh
imported/skipped breakdown — 766 imported + 13 skipped — rather than hitting
the file-level "already imported" shortcut, which raised a flag (two
profiles? a partial earlier insert?). Resolved by reconciling numbers instead
of inspecting the DB: 766 + 13 = 779, exactly matching the earlier structural
diagnostic's total parse count, with 13 matching the known bug #7 intra-file
collision count. Internally consistent — no evidence of double-counting or a
split-profile issue, so treating this run's result as the definitive final
state without further forensic digging.

**`link_transactions` behaves exactly as corrected above:** invoking
`/skill link-transactions` correctly fell back to "I couldn't find a
'link-transactions' skill, but I can use the `link_transactions` tool" and
asked Jd for each account's name/last-4 to match against — confirming it's
account-association, not transfer-pair matching, and that it needs Jd's own
real account details supplied directly (not relayed through this journal).

**Product gap spotted by Jd: CSV import never creates account records — fixed
the deeper version of it (bug #9), not just filed.** Investigating turned up
something worse than "no auto-create": `ParsedTransaction` had no
`account_name`/`account_last4` field at all, and `toInsert()` never forwarded
either even where `TransactionInsert` supported them — so the existing
"auto-link by account_last4" step was dead code for every CSV import, always
operating on an empty set. Worse, Quicken's own combined "Transaction Report"
export *already includes an `Account` column naming the real account per
row* (visible in the header captured for bug #6:
`...,Category,Amount,Account`), and `generic.ts` discarded it entirely —
exactly Jd's situation, one file spanning all 5 real accounts. | Added
`account_name` to `ParsedTransaction`; `generic.ts` now detects an
`Account`/`Account Name` column and captures it per row; `toInsert()` forwards
it to `TransactionInsert.account_name` (already-existing DB column, just
never populated); `importSingleFile`'s auto-link step now also matches
distinct `account_name` values against tracked accounts by exact case-insensitive
name (only when exactly one active account matches — ambiguous names are left
for `link_transactions` rather than guessed at). Net effect: every future
Quicken-shaped import shows the *real* account name in the dashboard
immediately (independent of whether a tracked `accounts` record exists yet),
and auto-links to one when it does. New tests in `generic-parser.test.ts` and
`csv-import-tool.test.ts`; `TransactionRow` was also missing `account_id`/
`account_name` fields entirely (a separate pre-existing type-completeness gap
surfaced while wiring the test) — added those too. `bun run typecheck` clean;
full suite 1391 pass, same 3 pre-existing/unrelated `alerts.test.ts` failures.
**Does not retroactively backfill** the 766 rows already imported (re-running
the same file now hits file/external_id dedup, so it wouldn't touch existing
rows) — a backfill would need a one-off UPDATE re-parsing the file and
matching by `external_id`; not run without Jd's go-ahead, since it writes to
the real `Jd` profile DB.

**Bug #8, also spotted by Jd:** a stray `0` next to every transaction
description in the dashboard's Transactions tab (`localhost:3141/#transactions`),
confirmed live. See bug table above — classic `{value && <jsx>}` footgun on a
SQLite 0/1 integer. Fixed and dashboard bundle rebuilt — `server.ts` loads
`ui/dist/index.html` once at startup (not per-request), so the already-running
dashboard server needs a restart (`/dashboard` again, or restart wilson) to
actually serve the rebuilt bundle. Pending live re-verification after that.

## Notes for the demo-cf lesson

- This maps cleanly onto demo-cf's CLI-track lesson structure: create profile → import → verify.
- Consider a new lesson (or an addendum to the existing import lesson) specifically about
  *creating a second profile*, since demo-cf's seeded `demo` profile is created for the learner
  ahead of time — this walkthrough is the first time that flow gets exercised end-to-end.
- The dashboard add-profile UI (bug #2) gives the Dashboard track an equivalent lesson it didn't
  have before — worth a mirrored lesson on that track too.
- The four personas above could become four separate demo-cf seed profiles (parallel to the
  existing `demo` Chase dataset), each landing on a different corner of the tool registry.
  Persona 1 is the richest for teaching the "order matters" lesson; 2–4 are each closer to a
  single-topic lesson (budgeting basics, household/joint accounts, net-worth & fraud watch).
