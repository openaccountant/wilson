# Plan: percentage-of-income targets for `goal_manage`

**Repo:** `/home/jd/.spf/watch/wilson/worktrees/issue-34` (branch for issue #34)
**Goal:** Add an optional `targetPercent` to `financial` goals so a goal can mean "save N% of actual income per period", with the target computed dynamically from real transaction data each time it's evaluated. Fixed `targetAmount` goals stay exactly as they are.

## Problem recap

`src/tools/goals/goal-manage.ts` only supports a static `targetAmount` on financial goals. Variable-income users (hourly, freelance, commission, child support) can't express "save 10% of whatever I make" once — the dollar target goes stale the first time income changes. Motivating case: the demo-cf persona in `docs/journal/2026-08-29-new-profile-walkthrough.md` with a 75/10/15 spend/save/invest split and irregular income.

## Design decisions (follow these; they were made deliberately)

1. **Field names:** `targetPercent` in the tool schema / TS interfaces, `target_percent` column in SQLite. Percent is 1–100 (a share of income, not a multiplier).
2. **Period basis:** a second optional field `incomePeriod` (`'month' | 'quarter' | 'year'`, column `income_period`, default `'month'`) declares which period the percent applies to. The motivating case is monthly.
3. **Mutual exclusivity:** a financial goal has *either* `targetAmount` *or* `targetPercent` — never both. On `update`, passing either target field **redefines** the target and NULLs the other (so switching modes works without a nullable-clear protocol).
4. **Effective target for a period** = `totalIncome(period window) × target_percent / 100`, where income is `getProfitLoss(db, start, end).totalIncome` from `src/db/queries.ts` (already handles the `amount > 0 OR category = 'Income'` rule — do not write a new income query).
5. **Progress semantics for percent goals:** progress for the current period is the period's net savings (`totalIncome + totalExpenses`, expenses negative) when the agent doesn't supply `currentAmount`; manual `currentAmount` still wins when supplied. A percent goal's `current_amount` therefore means "this period's progress", and the effective target resets each period — that's the point of the feature.
6. **Migration, not schema-table edit:** add columns via migration v22 only. Do **not** add `target_percent` to the `GOALS_TABLE` / `GOAL_SNAPSHOTS_TABLE` CREATE statements in `src/db/schema.ts` — this repo's convention (see migration 21 `ENTITY_ID_COLUMNS`) is that CREATE TABLE keeps the original shape and later migrations ALTER. Fresh DBs run all migrations in order, so they end up correct; editing the CREATE too would make v22's `ALTER TABLE ADD COLUMN` fail with "duplicate column" on fresh installs.
7. **Snapshot history:** extend `goal_snapshots` with the resolved target at snapshot time (`resolved_target REAL`), so trend history shows what the target was on each date even though it moves with income.

## Changes by file

### 1. `src/db/migrations.ts` — migration v22
- Import nothing new; add one entry after v21:
  `{ version: 22, name: 'add_goal_target_percent', up: GOAL_TARGET_PERCENT_COLUMNS }`
- Define `GOAL_TARGET_PERCENT_COLUMNS` in `src/db/schema.ts` (next to `ENTITY_ID_COLUMNS`, which is the pattern to copy):
  ```sql
  ALTER TABLE goals ADD COLUMN target_percent REAL;
  ALTER TABLE goals ADD COLUMN income_period TEXT;
  ALTER TABLE goal_snapshots ADD COLUMN resolved_target REAL;
  ```

### 2. `src/db/goal-queries.ts` — types + resolution helper
- `GoalRow`: add `target_percent: number | null;` and `income_period: string | null;`
- `GoalInsert` / `GoalUpdate`: add optional `targetPercent?: number;` and `incomePeriod?: 'month' | 'quarter' | 'year';`
- `upsertGoal`:
  - INSERT: include `target_percent`, `income_period` columns (`targetPercent ?? null`, `incomePeriod ?? null`).
  - UPDATE branch: set them when provided. When `targetAmount` is provided also set `target_percent = NULL`; when `targetPercent` is provided also set `target_amount = NULL` and (if not otherwise given) `income_period` defaults to `'month'`. This implements the exclusivity rule from Design decision 3.
- New exports at the bottom (import `getProfitLoss` from `./queries.js` — no circular import; `queries.ts` does not import goal-queries):
  ```ts
  export interface ResolvedGoalTarget {
    start: string; end: string; label: string; // period window, e.g. 2026-09-01..2026-09-30, "September 2026"
    income: number;    // totalIncome for the window
    target: number;    // income * target_percent / 100, rounded to cents
    progress: number;  // net savings for the window (income + expenses, expenses negative)
  }
  export function getPeriodWindow(period: 'month'|'quarter'|'year', offset = 0): { start: string; end: string; label: string }
  export function resolveGoalTarget(db: Database, goal: GoalRow): ResolvedGoalTarget | null
  ```
  - `getPeriodWindow` is a local date-math helper (month/quarter/year start–end, `toLocaleString('en-US', { month: 'long', year: 'numeric' })` labels). Do **not** import `getPeriodDates` from `src/tools/query/spending-summary.ts` — db code must not import from the tools layer. (Its logic is the reference implementation, ~line 30 of spending-summary.ts.)
  - `resolveGoalTarget` returns `null` when `goal.target_percent` is null; otherwise computes income via `getProfitLoss(db, start, end)` for the window derived from `goal.income_period ?? 'month'` (offset 0 = current period), `target = Math.round(income * target_percent) / 100`-style cent rounding, and `progress = pnl.totalIncome + pnl.totalExpenses`.
- Extend `updateGoalProgress(db, goalId, amount, resolvedTarget?: number)`: snapshot INSERT gains `resolved_target` (store `@resolvedTarget ?? null`). Only caller is goal-manage, so the optional param is safe.

### 3. `src/tools/goals/goal-manage.ts` — tool schema + actions
- Schema: add
  - `targetPercent: z.number().min(0).max(100).optional().describe('Target as % of income for the period (financial goals; e.g. 10 = save 10% of income)')`
  - `incomePeriod: z.enum(['month', 'quarter', 'year']).optional().describe('Period the percent applies to (default month)')`
- `add`:
  - Validation before `upsertGoal`: `targetPercent` on a `behavioral` goal → error ("targetPercent is only supported on financial goals"); both `targetAmount` and `targetPercent` → error ("specify either targetAmount or targetPercent, not both"); `financial` with neither → keep it permissive? No — require one ("financial goals need targetAmount or targetPercent"). Percent of 0 → error.
- `update`: same validation whenever either target field is present; pass-through to `upsertGoal` (which implements the clear-the-other rule).
- `progress`:
  - Keep requiring `currentAmount` for fixed-dollar goals.
  - For percent goals (`goal.target_percent != null`): `currentAmount` optional. Resolve via `resolveGoalTarget`, amount = `currentAmount ?? resolved.progress`, call `updateGoalProgress(db, goalId, amount, resolved.target)`.
  - Response message for percent goals: `$X of $Y (10% of September 2026 income $4,500)` and the existing `Target reached!` when `amount >= resolved.target`. If income for the period is 0, say so plainly ("no income recorded yet for September 2026 — target will update as income is logged") instead of a confusing $0 target.
- `list`: enrich each row — for percent goals attach `effective_target` and `period_income` from `resolveGoalTarget` (spread onto the row; leave fixed goals untouched). Keep `activeCount`/`totalCount` as-is.
- Bump the tool `description` to mention percent-of-income goals.

### 4. Display surfaces (all three read `getActiveGoals`; percent goals need the resolved target)
- **`src/agent/prompts.ts` `buildGoalContext`** (~line 429): for `g.target_percent` goals emit
  `Financial: "<title>" — $<progress> of $<resolved.target> this <income_period> (<target_percent>% of <label> income $<income>)` using `resolveGoalTarget(goalDb, g)`; keep the fixed-dollar branch untouched.
- **`src/components/context-hints.ts` `buildGoalProgressHints`** (~line 103): percent goals — compute resolved target, same `pct >= 80` "Almost there" hint but phrased against the period target (e.g. `'Save 10%' is 85% of this month's target`). Note this function already has `db` in scope; it runs on every prompt render, so it's 2 extra queries per percent goal — acceptable.
- **Dashboard:**
  - `src/dashboard/api.ts` `apiGoals` (~line 265): map rows, adding `effective_target: number | null` (and `period_income`) for percent goals; fixed goals get `effective_target: null` (UI falls back to `target_amount`).
  - `src/dashboard/ui/src/types.ts` `Goal` (~line 254): add `target_percent: number | null; income_period: string | null; effective_target?: number | null;`
  - `src/dashboard/html.ts` `loadGoals` (~lines 870–950): use `g.effective_target ?? g.target_amount` as the denominator for the progress bar/pct/label (lines ~885 and ~908–948 region); when `g.target_percent` is set, the amount label reads `$X of $Y (10% of monthly income)`. This file is a template string of inline JS — edit carefully, no TS features inside it.

### 5. `src/tools/registry.ts`
- `GOAL_MANAGE_DESCRIPTION` (~line 316): add a bullet under "Use when" ("When the user wants a percentage-of-income goal — 'save 10% of every paycheck'") and under notes ("Financial goals use target_amount for fixed figures or target_percent + income_period for a share of actual period income; the dollar target is computed from real income each period").

### 6. `CHANGELOG.md`
- Add an entry under Unreleased/Features: percentage-of-income goals (`targetPercent` on `goal_manage` financial goals, dynamic target from actual income per period).

## Tests — new file `src/__tests__/goal-percent.test.ts`

Follow `profit-loss-tool.test.ts`: `createTestDb()` (already runs all migrations, so v22 columns exist), `initGoalManageTool(db)`, then `goalManageTool.func(...)`. Seed income with `insertTransactions(db, [{ date: daysAgo(2), description: 'Paycheck', amount: 2000, category: 'Income' }, ...])` — **don't rely on `seedTestData`'s $3500 paycheck**, since `daysAgo(30)` can fall in the previous month depending on run date; seed explicit current-month transactions for deterministic targets.

Cases:
1. `add` financial with `targetPercent: 10` → created; row has `target_amount = null`, `target_percent = 10`, `income_period = 'month'`.
2. `add` rejects: percent on behavioral; both target fields; financial with neither; percent 0 / >100.
3. `progress` auto-computes: income $2000 + expenses $600 in current month, `progress` with only `goalId` → amount $1400, message shows target $200, `Target reached!` (1400 ≥ 200). Snapshot row has `resolved_target = 200`.
4. `progress` with explicit `currentAmount` on a percent goal uses the supplied amount.
5. `update` switching modes: percent goal updated with `targetAmount: 500` → `target_amount = 500`, `target_percent = null`; reverse direction too.
6. `list` includes `effective_target` for the percent goal (income $2000 × 10% = $200) and `null` for fixed goals.
7. Fresh-DB migration: `createTestDb()` then `PRAGMA table_info(goals)` includes `target_percent` / `income_period` (implicitly covered by every other test, but assert it once for clarity).
8. Prompt context: set db via `initGoalContext`, percent goal → `buildGoalContext()` output contains the percent phrasing; fixed goal output unchanged.

## Verification

```bash
bun test src/__tests__/goal-percent.test.ts   # new tests
bun test                                       # full suite, nothing regressed
bun run typecheck                              # tsc --noEmit
```

Manual smoke (optional): with a dev profile DB, `goal_manage` add → progress → list, then check the dashboard Goals tab renders the percent goal.

## Out of scope (do not build now)

- Rollover/accumulation across periods (percent goals are per-period, target resets).
- Per-account or per-category income filtering (goals already have `account_id`; a later change could scope the income query with it).
- Backfilling/renaming the demo persona data from `docs/journal/2026-08-29-new-profile-walkthrough.md` — that worktree (`worktree-fix+profile-switch-dashboard`) can adopt `targetPercent` once this lands.
- Behavioral goals with percent targets (category-based behavioral goals keep `targetAmount`).