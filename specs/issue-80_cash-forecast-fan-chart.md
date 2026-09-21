# Plan: Client-side Monte Carlo cash forecast fan chart on Overview (issue-80)

Decomposed from #54. Builds directly on the landed #79 wire-format fix (commit 83fa52b — `Account` in `src/dashboard/ui/src/types.ts` already carries `account_type`/`account_subtype`/`current_balance`, pinned by field-name tests in `src/__tests__/dashboard-server.test.ts`). One new read-only endpoint, no schema change; the simulation is a pure client-side module; one new card on Overview.

## Where things stand (verified in this worktree)

- `getProfitLoss` (`src/db/queries.ts:326`) is the classification source of truth:
  - income = rows where `amount > 0 OR category = 'Income'`
  - expenses = rows where `amount < 0 AND COALESCE(category, '') NOT IN ('Income', 'Transfer')`
- `getMonthlySavingsData` (`src/db/queries.ts:379`) counts **every** `amount < 0` row as an expense — including `Transfer` rows — which is exactly the double-count the forecast must avoid (a credit-card payment is an expense in that series *and* the card charge was too).
- `getMonthlySavingsData`'s window also includes the current, still-ongoing (partial) month; sampling a half-elapsed month as a full month would badly understate spend. The new series returns **complete calendar months only** (window ends at the last day of the previous month).
- The account subtype taxonomy (`src/tools/net-worth/account-types.ts`) is lowercase snake_case; liquid asset subtypes are exactly `checking`, `savings`, `cash` (investment/real_estate/vehicle/crypto/other_asset are NOT liquid).
- Root `tsconfig.json` excludes `src/dashboard/ui` from `include`, but files imported from included test files still join the root program (proven by `src/__tests__/local-chat-bundle.test.ts` importing `../dashboard/ui/src/hybrid/core.js` at runtime). The sim module must therefore be dependency-free, browser-API-free, and clean under both the root tsconfig (ESNext, `declaration: true`, strict) and the UI tsconfig (ES2022, noEmit).
- Both `node_modules` dirs are missing in this worktree — verification needs `bun install` (root) and `bun install` in `src/dashboard/ui` first.
- Overview row placement: `src/dashboard/ui/src/tabs/OverviewTab.tsx` has a `grid grid-cols-2 gap-4` row with `BudgetCountdown` + `SavingsSparkline`. The forecast card joins that row.
- Cards that ignore the global month filter (`SavingsSparkline`, net-worth surfaces) simply call their endpoints without `useFilterParams()` — the forecast card does the same.

## Changes

### 1. `src/db/queries.ts` — new `MonthlyCashflowRow` + `getMonthlyCashflowData`

Add below `getMonthlySavingsData` (keep `getMonthlySavingsData` untouched — its semantics are the savings card's business):

```ts
export interface MonthlyCashflowRow {
  month: string;    // 'YYYY-MM', complete calendar months only (current partial month excluded)
  income: number;   // sum of amounts where amount > 0 OR category = 'Income'  (P&L income rule)
  expenses: number; // sum of ABS(amount) where amount < 0 AND COALESCE(category,'') NOT IN ('Income','Transfer')  (P&L expense rule)
}

/**
 * Monthly income/expense series classified exactly like getProfitLoss, so a
 * cash projection never counts transfers between accounts as spending (the
 * monthly savings series does, double-counting card payments). Window covers
 * the `months` complete calendar months ending with the last complete month
 * before `endMonth` (default: the current month).
 */
export function getMonthlyCashflowData(
  db: Database,
  endMonth?: string,
  months: number = 24,
): MonthlyCashflowRow[]
```

Implementation:

- `endMonth ?? new Date().toISOString().slice(0, 7)`; parse `YYYY-MM`.
- Window end = last day of the month **before** the end month: `new Date(year, mon - 1, 0).toISOString().slice(0, 10)` (for endMonth `2026-09` → endDate `2026-08-31`). Window start = first day of the month `months - 1` months before that end month: `new Date(year, mon - 1 - (months - 1), 1)` formatted `YYYY-MM-01`.
- Single SQL statement, mirroring the P&L predicates:

```sql
SELECT strftime('%Y-%m', date) AS month,
  COALESCE(SUM(CASE WHEN amount > 0 OR category = 'Income' THEN amount ELSE 0 END), 0) AS income,
  COALESCE(SUM(CASE WHEN amount < 0 AND COALESCE(category, '') NOT IN ('Income', 'Transfer')
    THEN ABS(amount) ELSE 0 END), 0) AS expenses
FROM transactions
WHERE date >= @startDate AND date <= @endDate
GROUP BY strftime('%Y-%m', date)
ORDER BY month
```

- No accountId/entityId filters: the projection is portfolio-level cash (all-accounts flows vs a liquid-cash starting balance); account-scoped flows would not line up with it.
- Months with no transactions are simply absent from the result (same as the savings series) — the bootstrap samples from observed months only.

### 2. `src/dashboard/api.ts` — `apiCashflowMonthly`

```ts
export function apiCashflowMonthly(db: Database, params: URLSearchParams) {
  const months = Math.min(120, Math.max(1, parseInt(params.get('months') ?? '24', 10) || 24));
  return getMonthlyCashflowData(db, undefined, months);
}
```

Place it next to `apiSavings`; import `getMonthlyCashflowData` from `../db/queries.js`.

### 3. `src/dashboard/server.ts` — route

Right after the `if (path === '/api/savings')` block:

```ts
if (path === '/api/cashflow/monthly') {
  return Response.json(apiCashflowMonthly(activeDb, url.searchParams), { headers });
}
```

Add `apiCashflowMonthly` to the import list from `./api.js`. GET-only, read-only, no RBAC gate (same posture as `/api/savings`).

### 4. `src/dashboard/ui/src/types.ts` — wire type

```ts
// Matches GET /api/cashflow/monthly response (MonthlyCashflowRow in src/db/queries.ts).
// Complete calendar months only — the current partial month is never included.
export interface MonthlyCashflowRow {
  month: string;
  income: number;
  expenses: number;
}
```

### 5. `src/dashboard/ui/src/lib/cashflowForecast.ts` — new file, pure simulation engine

Framework-free, zero imports, no DOM/browser APIs, no `import.meta.env` (so root tsc, UI tsc, and vite are all happy; same pattern as `hybrid/core.ts`).

```ts
export interface CashflowMonth { month: string; income: number; expenses: number; }

export interface ForecastPoint {
  step: number;  // 0 = anchor (now); 1..horizonMonths
  label: string; // 'Now' for step 0, else 'MMM YYYY' (e.g. 'Oct 2026')
  p10: number; p25: number; p50: number; p75: number; p90: number;
}

export interface CashflowForecast {
  points: ForecastPoint[]; // length = horizonMonths + 1
  startBalance: number;
  pathCount: number;
}

export const FORECAST_PATHS = 500;
export const FORECAST_HORIZON_MONTHS = 12;
export const MIN_HISTORY_MONTHS = 2;   // 'a couple of months' — below this the card shows the empty state
export const DEFAULT_SEED = 1337;

/** Mulberry32 — tiny seeded PRNG, deterministic under test. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Nearest-rank percentile of an ascending-sorted array. */
export function percentile(sortedAsc: number[], p: number): number {
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil((p / 100) * sortedAsc.length) - 1));
  return sortedAsc[idx];
}

export function runCashflowForecast(opts: {
  history: CashflowMonth[];
  startBalance: number;
  /** 'YYYY-MM' the projection starts from (the card passes the current month); required for deterministic labels. */
  startMonth: string;
  horizonMonths?: number; // default 12
  paths?: number;         // default 500
  seed?: number;          // default DEFAULT_SEED
}): CashflowForecast | null
```

Behavior:

1. Drop history rows whose `income`/`expenses` are not finite (defensive). If fewer than `MIN_HISTORY_MONTHS` rows remain → return `null` (the card renders the empty state; single source of truth for "too short").
2. Build `incomes` and `expenses` arrays from the filtered history.
3. `const rng = mulberry32(seed)`. Draw helper: `const pick = (arr: number[]) => arr[Math.min(arr.length - 1, Math.floor(rng() * arr.length))]`.
4. For each of `paths` paths: `balance = startBalance`; for step `1..horizonMonths`: `balance += pick(incomes) - pick(expenses)`; push the running balance into that step's collection. Income and expense are drawn independently each month (bootstrap with replacement) — the pairing-of-a-good-month-with-a-good-month noise is the point of the fan.
5. Sort each step's array ascending; extract p10/p25/p50/p75/p90 via `percentile`.
6. `points[0]` is the anchor: `{ step: 0, label: 'Now', p10..p90: startBalance }`. Steps `1..horizonMonths` get labels from `startMonth` + k months using a fixed `['Jan','Feb',...]` name array (no `Intl` — keeps bun/browser output identical).
7. Return `{ points, startBalance, pathCount: paths }`.

Cost: 500 × 12 × 2 ≈ 12k draws — well under a millisecond; main thread is fine (no Web Worker).

### 6. `src/dashboard/ui/src/components/CashflowForecast.tsx` — new card

Structure mirrors `SavingsSparkline`/`PnlCard` (same shell classes `bg-surface-raised border border-border rounded-lg p-4`, same `text-xs text-text-secondary uppercase tracking-wide` title — title: `Cash Forecast`).

- Data: `const { data: history, loading } = useApi<MonthlyCashflowRow[]>('/api/cashflow/monthly?months=24')` — **no `useFilterParams()`**, so the header month/account/category filters are ignored by construction (it projects from now, like the net-worth surfaces).
- Starting balance: `const { data: accounts } = useApi<Account[]>('/api/accounts')`; then
  ```ts
  const LIQUID_SUBTYPES = ['checking', 'savings', 'cash']; // ASSET_SUBTYPES that are liquid (see src/tools/net-worth/account-types.ts)
  const startBalance = useMemo(
    () => (accounts ?? [])
      .filter((a) => a.account_type === 'asset' && LIQUID_SUBTYPES.includes(a.account_subtype))
      .reduce((sum, a) => sum + a.current_balance, 0),
    [accounts],
  );
  ```
  (Taxonomy values are lowercase; direct comparison. Investment/crypto/vehicle/real-estate assets are excluded — liquid cash, not net worth.)
- `const forecast = useMemo(() => history ? runCashflowForecast({ history, startBalance, startMonth: currentMonth() }) : null, [history, startBalance]);` where `currentMonth()` is a tiny local `new Date().toISOString().slice(0, 7)`.
- **Loading:** pulse skeleton like SavingsSparkline's but taller (`h-[120px]`).
- **Empty state:** when `!forecast` — keep the title, then a short explainer: "Not enough history yet — the projection needs a couple of months of income and expenses. Import more statements and check back." (`text-sm text-text-secondary`). No chart.
- **Chart** (recharts is already a dependency): map points to stacked-band data and render in a `ResponsiveContainer` (~`h-[160px]`):
  ```ts
  const chartData = forecast.points.map((pt) => ({
    label: pt.label,
    p10: pt.p10,
    p50: pt.p50,
    band25: pt.p25 - pt.p10,
    band50: pt.p50 - pt.p25,
    band75: pt.p75 - pt.p50,
    band90: pt.p90 - pt.p75,
  }));
  ```
  - `<ComposedChart data={chartData}>` (or `AreaChart`) with:
    - `<Area dataKey="p10" stackId="fan" stroke="none" fill="transparent" />` — invisible base; because bands stack additively this stays correct even when p10 goes negative.
    - `<Area dataKey="band25" stackId="fan" stroke="none" fill="#233046" fillOpacity={0.55} />` (outer low band)
    - `<Area dataKey="band50" stackId="fan" stroke="none" fill="#2e4a6b" fillOpacity={0.55} />` (inner band)
    - `<Area dataKey="band75" stackId="fan" stroke="none" fill="#2e4a6b" fillOpacity={0.55} />`
    - `<Area dataKey="band90" stackId="fan" stroke="none" fill="#233046" fillOpacity={0.55} />` (outer high band)
    - `<Line dataKey="p50" stroke="#e4e4e7" strokeWidth={2} dot={false} />` — median path
    - `<Line dataKey="p10" stroke="#ef4444" strokeWidth={1} strokeDasharray="4 4" dot={false} />` — dashed pessimistic edge
    - XAxis `dataKey="label"`, `<Tooltip>` styled like SavingsSparkline's (dark `contentStyle`), formatter showing month + `Median $X` and `Range $p10–$p90` in dollars; YAxis `tickFormatter` like `$${(v / 1000).toFixed(0)}k` for |v| ≥ 1000 else `$${v}`.
  - The band hexes are suggestions — any muted two-tone blues that read as translucent layers on the dark surface are fine; keep bands translucent, median line solid.
- **Takeaway line** (below the chart, `text-sm text-text`): computed from the result —
  ```ts
  const last = forecast.points[forecast.points.length - 1];
  const lowIdx = forecast.points.findIndex((pt) => pt.step > 0 && pt.p10 < 0);
  ```
  Text: `Median cash in ${last.label}: ${fmtUsd(last.p50)}` plus, when `lowIdx >= 0`, ` — pessimistic path runs low around ${forecast.points[lowIdx].label}`. `fmtUsd` rounds to whole dollars and uses `toLocaleString('en-US')`.
- **Muted assumption line** (below the takeaway, `text-xs text-text-muted mt-2`): "Transfers between accounts and debt payments aren't modeled." Always shown with the chart, not with the empty state.

### 7. `src/dashboard/ui/src/tabs/OverviewTab.tsx` — place the card

In the "Budget countdown + Savings sparkline" row: change `grid grid-cols-2 gap-4` → `grid grid-cols-3 gap-4` and add `<CashflowForecast />` after `<SavingsSparkline />` (import from `@/components/CashflowForecast`). Result:

```tsx
{/* Budget countdown + Savings sparkline + Cash forecast */}
<div className="grid grid-cols-3 gap-4">
  <BudgetCountdown />
  <SavingsSparkline />
  <CashflowForecast />
</div>
```

### 8. Tests — `src/__tests__/cashflow-forecast.test.ts` (new, pure, no DB)

Imports from `../dashboard/ui/src/lib/cashflowForecast.js` (bun resolves `.js` → `.ts`; root tsc pulls the file into the program exactly like the hybrid-core tests do).

1. **mulberry32 determinism**: two instances with seed 42 emit the identical sequence; pin the first five values with `toBe` (exact IEEE doubles, same code path):
   `0.6011037519201636, 0.44829055899754167, 0.8524657934904099, 0.6697340414393693, 0.17481389874592423`
   Also: every value in `[0, 1)`, and seed 1's sequence differs (first value `0.6270739405881613`).
2. **percentile nearest-rank**: on `[1..100]` ascending — `p10 === 10`, `p50 === 50`, `p90 === 90`, `p0 === 1`, `p100 === 100`.
3. **bands stay ordered**: 6-month varied history (e.g. incomes 3800–4700, expenses 2200–2900), `startBalance: 5000`, `startMonth: '2026-09'`, fixed seed → for **every** point assert `p10 <= p25 <= p50 <= p75 <= p90`.
4. **every path starts at the seeded starting balance**: `points[0].step === 0`, `points[0].label === 'Now'`, and all five percentiles of `points[0]` equal `startBalance` exactly (the anchor is not simulated).
5. **horizon length honored**: `horizonMonths: 12` → `points.length === 13`; `horizonMonths: 6` → `7`.
6. **deterministic under fixed seed**: two runs with identical inputs (incl. seed) `toEqual` each other; a run with a different seed has a different p50 series somewhere (use varied history so this is robust, not luck).
7. **degenerate history is exact**: a history where every month has the same income (3000) and expenses (2000) makes every draw identical → every path is the same line → at step k **all five percentiles** equal `startBalance + k * 1000` (strong correctness pin: bootstrap + percentile + accumulation all verified exactly).
8. **short/empty history degrades gracefully**: `history: []` → `null`; one month → `null`; exactly two months → a result whose percentiles are all finite (`Number.isFinite`). No throw in any case.

### 9. Tests — extend `src/__tests__/dashboard-server.test.ts`

Add a `describe('cashflow monthly')` block. Import `apiCashflowMonthly` from `../dashboard/api.js`, `type MonthlyCashflowRow` from `../dashboard/ui/src/types.js`.

⚠️ Date seeding trap: the series covers **complete months only**, so `daysAgo(N)` rows usually land in the current partial month and never appear. Seed with explicit calendar dates in completed months, e.g. `${previousMonth()}-15` (helpers exports `previousMonth()`; see the comment in `seedTestData` about the same trap, #23). For a second month of history compute a `twoMonthsAgo` `YYYY-MM` inline (`new Date(); setMonth(getMonth() - 2)`).

1. **Transfer-category expense is not counted** (the AC pin): seed one completed month with paycheck `+3000` `Income`, groceries `-400` `Groceries`, and a credit-card payment `-250` `Transfer`. Call `apiCashflowMonthly(db, new URLSearchParams())` directly (same direct-api pattern as the wire tests). Assert the previous month's row has `income === 3000` and `expenses === 400` — the Transfer payment contributed nothing. Also assert no row exists for the current month (complete-months-only rule).
2. **Income-side P&L parity (deliberate pin)**: seed a `+250` `Transfer` row (transfer-in) → it counts as income. Comment in the test: this mirrors `getProfitLoss`'s income rule (`amount > 0 OR category = 'Income'`) exactly, by design; changing it is a conscious later decision, not a bug fix here. (Two-sided transfers in the data can then net out imperfectly for cash purposes — accepted for this slice, see Out of scope.)
3. **Wire shape pin**: `Object.keys(rows[0]).sort()` deep-equals `['expenses', 'income', 'month']`, and a compile-time belt mirrors #79's pattern:
   ```ts
   const typed: MonthlyCashflowRow[] = apiCashflowMonthly(db, new URLSearchParams());
   ```
   (type-only import; erased at runtime so `bun test` is unaffected).
4. **months window**: with `?months=1` the series contains at most one row — the last complete month.
5. **HTTP route**: `GET /api/cashflow/monthly` → 200, JSON array; `?months=1` respected.

### 10. `CHANGELOG.md`

One `feat:` bullet under `## [Unreleased]` → `### Features`, matching the existing one-line-with-detail style and ending `(#80)`: client-side Monte Carlo cash forecast card on Overview — `GET /api/cashflow/monthly` (P&L-classified, complete-months, transfer-excluding income/expense series), seeded bootstrap of 500 twelve-month paths in the browser, recharts fan chart (p10–p90 bands around the median) beside Savings Rate, plain-language takeaway, and an empty state until a couple of months of history exist.

## Out of scope

- No Web Worker (12k draws is trivial), no persistence of results, no goal integration, no seasonality/interest modeling.
- No change to `getMonthlySavingsData` or `SavingsSparkline` — the savings series keeps its current (transfer-counting) semantics; only the forecast uses the new series.
- No schema change, no new dependencies.
- Income-side transfer parity quirk: positive `Transfer` rows count as income (P&L parity, pinned by test 2 above). With two-sided transfer data this can overstate projected income; refining that is a later, deliberate decision — do not "fix" it silently in this slice.
- Debt payments are modeled as neither income nor expense (the `Transfer` exclusion covers the payment leg; loan interest/principal effects are not modeled) — that is what the card's muted assumption line states.

## Verification

1. `bun install` (root, fresh worktree), then `bun test src/__tests__/cashflow-forecast.test.ts src/__tests__/dashboard-server.test.ts`, then full `bun test`.
2. `bun run typecheck` — root tsc; this also typechecks `cashflowForecast.ts` (pulled in via the test import) and the compile-time `MonthlyCashflowRow` belt.
3. Dashboard UI build: `cd src/dashboard/ui && bun install && bun run build` (runs `tsc -b && vite build`). UI tsc covers the new lib + component; vite bundles them into the main single-file app chunk (they are not imported by `hybrid/standalone.ts`, so the hybrid chunk is untouched).
4. Manual check — scratch profile with realistic history (`bun scratch-cashflow.ts`, delete the file after):

```ts
// scratch-cashflow.ts
import { createTestDb } from './src/__tests__/helpers.js';
import { insertTransactions } from './src/db/queries.js';
import { insertAccount } from './src/db/net-worth-queries.js';
import { setInitialProfile, closeAll } from './src/dashboard/db-manager.js';
import { startDashboardServer } from './src/dashboard/server.js';

const db = createTestDb();
insertAccount(db, { name: 'Checking', account_type: 'asset', account_subtype: 'checking', current_balance: 4200 });
insertAccount(db, { name: 'Savings', account_type: 'asset', account_subtype: 'savings', current_balance: 9800 });
insertAccount(db, { name: 'Wallet', account_type: 'asset', account_subtype: 'cash', current_balance: 120 });
insertAccount(db, { name: 'Brokerage', account_type: 'asset', account_subtype: 'investment', current_balance: 25000 }); // must NOT count toward the starting balance
insertAccount(db, { name: 'Visa', account_type: 'liability', account_subtype: 'credit_card', current_balance: 900 });

const txns: Parameters<typeof insertTransactions>[1] = [];
const now = new Date();
for (let k = 1; k <= 8; k++) { // k = complete months ago; the current partial month stays empty
  const d = new Date(now.getFullYear(), now.getMonth() - k, 15);
  const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  txns.push({ date: `${ym}-03`, description: 'Paycheck', amount: 4200 + (k % 3) * 250, category: 'Income' });
  txns.push({ date: `${ym}-05`, description: 'Rent', amount: -1750, category: 'Housing' });
  txns.push({ date: `${ym}-12`, description: 'Groceries', amount: -420 - (k % 4) * 60, category: 'Groceries' });
  txns.push({ date: `${ym}-20`, description: 'Dining', amount: -160 - (k % 5) * 45, category: 'Dining' });
  txns.push({ date: `${ym}-24`, description: 'Credit card payment', amount: -560, category: 'Transfer' });
}
insertTransactions(db, txns);
setInitialProfile('scratch', db);
await startDashboardServer(db, 3141);
process.on('SIGINT', () => { closeAll(); process.exit(0); });
```

Then `bun scratch-cashflow.ts` and open http://localhost:3141 (Overview tab):

- Card sits in the 3-column row **beside Savings Rate**, titled Cash Forecast.
- Starting balance is **14,120** (checking + savings + cash; the 25k brokerage and the Visa are excluded) — sanity-check via `curl -s localhost:3141/api/cashflow/monthly | head` too (8 rows, months end with last complete month, and per-month expenses ≈ rent + groceries + dining ≈ 2.3–3.2k with **no** 560 Transfer component; income ≈ 4.2–4.7k).
- Fan chart renders: translucent bands widening over the horizon around a solid median line; median at month 12 lands around **$37k ± a couple k** (≈ 14,120 + 12 × ~1.95k monthly net); takeaway reads like "Median cash in <month+12>: $37,xxx".
- Muted assumption line under the takeaway mentions transfers/debt payments not being modeled.
- Empty state: comment out the `insertTransactions(db, txns)` line, rerun → card shows the "needs a couple of months of history" explainer instead of the chart.

## Acceptance criteria mapping

- Client-side projection from the user's own history; sampling series excludes transfers (pinned test) → §1 (P&L-classified series), §5 (client-side bootstrap), §9 test 1.
- Simulation engine covered by deterministic seeded tests: bands ordered, paths start at seeded balance, horizon honored, short/empty degrades → §8 tests 3, 4, 5, 7, 8.
- `bun test`, root typecheck, dashboard UI build pass → Verification 1–3.
- Manual check: card beside Savings Rate with fan chart + takeaway on seeded data; explainer on empty history → Verification 4.