# Plan: What-if controls on the forecast card — horizon + income/expense assumptions (issue-81)

Decomposed from #54. Builds directly on the landed #80 fan chart (commit 15b6c0e): the pure simulation engine `src/dashboard/ui/src/lib/cashflowForecast.ts` already accepts `horizonMonths`/`paths`/`seed`, and the card `CashflowForecast.tsx` already renders the fan + takeaway from a `useMemo`. This slice adds the missing piece — income/expense scaling as engine parameters — and the interactive controls on top. **No new endpoints, no schema change, no refetching of history: every control is client-side state that re-runs the already-fetched series through the pure engine.**

## Where things stand (verified in this worktree)

- `runCashflowForecast` (`src/dashboard/ui/src/lib/cashflowForecast.ts`) takes `{ history, startBalance, startMonth, horizonMonths? = 12, paths? = 500, seed? = 1337 }` and bootstraps `paths` paths month-by-month: `balance += pick(incomes) - pick(expenses)`, drawing income and expense independently each month with a single `mulberry32` stream. It returns `{ points, startBalance, pathCount }`; `points` has length `horizonMonths + 1` (step 0 = anchor at `startBalance`, unsimulated).
- `CashflowForecast.tsx` fetches `/api/cashflow/monthly?months=24` (no `useFilterParams()`) and `/api/accounts`, computes `startBalance` from liquid asset subtypes (`checking|savings|cash`), runs the forecast in a `useMemo` keyed on `[history, startBalance]`, and renders the recharts fan, a takeaway line (`Median cash in <label>: $X` + optional "pessimistic path runs low around <label>"), and the muted assumptions line. Horizon is implicitly the engine default (12). **No controls exist yet.**
- Engine tests live in `src/__tests__/cashflow-forecast.test.ts` (pure, no DB, no DOM): mulberry32 pins, percentile pins, band ordering, anchor exactness, horizon length (12→13 points, 6→7), fixed-seed determinism, degenerate-history exact percentiles, short-history null.
- The card sits in `src/dashboard/ui/src/tabs/OverviewTab.tsx` inside `grid grid-cols-3 gap-4` (line 41) next to `BudgetCountdown` and `SavingsSparkline` — placement stays as is.
- UI conventions to reuse (all verified):
  - Segmented preset pills (Header.tsx:46): container `flex items-center gap-0.5 bg-surface border border-border rounded-md p-0.5`; button `px-2 py-1 text-xs font-medium rounded cursor-pointer border-none transition-colors`, active `bg-green/20 text-green`, inactive `bg-transparent text-text-muted hover:text-text`.
  - Ghost button (ImportStatementDialog cancel): `bg-transparent text-text-muted border border-border px-3 py-1.5 rounded text-sm cursor-pointer hover:text-text`, disabled adds `disabled:cursor-not-allowed` (+ `disabled:opacity-50` is fine).
  - Accent color exists as a theme token (`--color-accent: #22c55e` in `src/dashboard/ui/src/styles/app.css`; `accent-green` is already used on a checkbox in `ChatTab.tsx:89`) — native `<input type="range">` can take `accent-green`.
  - **No `type="range"` input exists anywhere yet** — this slice introduces the first; keep styling minimal (`w-full accent-green cursor-pointer`), no custom thumb CSS.
- `CHANGELOG.md` head is `## [v0.7.0] — 2026-09-21` — there is no `## [Unreleased]` section right now; add one.
- Both `node_modules` dirs are **missing** in this worktree — verification needs `bun install` (root) and `bun install` in `src/dashboard/ui` first.
- Root `tsconfig.json` still pulls UI-lib files into the root program via test imports (how `cashflowForecast.ts` is typechecked at root today), so the engine must stay dependency-free and DOM-free. The engine already is; keep it that way.

## Changes

### 1. `src/dashboard/ui/src/lib/cashflowForecast.ts` — what-if scales as engine parameters

Keep the module dependency-free and DOM-free. Three edits:

a) Export the UI-bound constants next to the existing ones so card and tests share them:

```ts
/** What-if slider bounds (percent of observed monthly values) and step. */
export const WHATIF_MIN_PCT = 50;   // −50%
export const WHATIF_MAX_PCT = 150;  // +50%
export const WHATIF_STEP = 5;
```

b) Extend the `runCashflowForecast` opts:

```ts
  /** Multiplier applied to every drawn income month. Default 1 (no adjustment). */
  incomeScale?: number;
  /** Multiplier applied to every drawn expense month. Default 1 (no adjustment). */
  expenseScale?: number;
```

Sanitize defensively at the top (same no-throw posture as the non-finite history-row filter):

```ts
function sanitizeScale(v: number | undefined, fallback = 1): number {
  return v === undefined || !Number.isFinite(v) || v < 0 ? fallback : v;
}
const incomeScale = sanitizeScale(opts.incomeScale);
const expenseScale = sanitizeScale(opts.expenseScale);
```

(Private helper — behavior is pinned through `runCashflowForecast` tests, not exported.)

c) Apply the scales **after** the draw, inside the path loop:

```ts
balance += pick(incomes) * incomeScale - pick(expenses) * expenseScale;
```

**Determinism/honesty invariant (why after the draw matters):** multiplying the picked value instead of pre-scaling the arrays keeps the RNG draw sequence and draw count identical regardless of the assumptions. Under one seed: (1) the same assumptions always produce the same projection; (2) two runs that differ only in assumptions consume identical randomness, so band shifts reflect the assumptions, not re-sampling luck; (3) horizon prefix-stability holds — a 24-month run's first 12 steps equal the 12-month run's steps exactly, because the per-path draw order is unchanged. Add a comment at the multiplication site stating exactly this.

Nothing else in the engine changes: `CashflowForecast`/`ForecastPoint` shapes, anchor, labels, percentile extraction, and the `MIN_HISTORY_MONTHS` gate all stay. The anchor (`startBalance`) is deliberately NOT scaled — the what-if adjusts future flows, not the cash you have today.

### 2. `src/dashboard/ui/src/components/CashflowForecast.tsx` — controls + in-place recompute

Keep the existing data fetching, `startBalance` memo, loading skeleton, empty state, chart config, and muted assumptions line untouched. Add:

a) **State** (only rendered when a forecast exists):

```tsx
const [horizon, setHorizon] = useState(12);
const [incomePct, setIncomePct] = useState(100);   // percent, 50..150 — slider-native integers
const [expensePct, setExpensePct] = useState(100);
const atBaseline = horizon === 12 && incomePct === 100 && expensePct === 100;
```

Percent state (not float scale) keeps the slider simple; convert at the call site (`incomePct / 100`).

b) **Recompute in place** — extend the existing `useMemo` deps; the data deps (`history`, `startBalance`) are unchanged, so no refetch ever happens:

```tsx
const forecast = useMemo(
  () =>
    history
      ? runCashflowForecast({
          history,
          startBalance,
          startMonth: currentMonth(),
          horizonMonths: horizon,
          incomeScale: incomePct / 100,
          expenseScale: expensePct / 100,
        })
      : null,
  [history, startBalance, horizon, incomePct, expensePct],
);
```

c) **Controls block** between the title and the chart (only in the chart branch, not the loading/empty states). Two rows:

Row 1 — horizon pills + reset, `flex items-center justify-between mb-2`:
- Segmented control with the three horizon options `[{ id: 6, label: '6m' }, { id: 12, label: '12m' }, { id: 24, label: '24m' }]`, Header-preset-pill styling (container `flex items-center gap-0.5 bg-surface border border-border rounded-md p-0.5`; button `px-2 py-1 text-xs font-medium rounded cursor-pointer border-none transition-colors`; active `bg-green/20 text-green`, inactive `bg-transparent text-text-muted hover:text-text`; `aria-pressed={horizon === id}`).
- Reset ghost button (`text-xs` variant of the dialog ghost style), label `Reset`, `onClick={() => { setHorizon(12); setIncomePct(100); setExpensePct(100); }}`, `disabled={atBaseline}` with `disabled:cursor-not-allowed disabled:opacity-50`.

Row 2 — the two what-if sliders, `grid grid-cols-2 gap-3 mb-1`:
- Each cell: a one-line label `flex items-center justify-between text-xs` — name (`text-text-muted`, `Income` / `Expenses`) and live value (`${pctLabel}`), where `pctLabel` is `+${pct - 100}%` / `-${100 - pct}%` / `0%` (sign only when off 100). Value span: `text-green` when off-baseline, `text-text-muted` otherwise.
- Under it: `<input type="range" min={WHATIF_MIN_PCT} max={WHATIF_MAX_PCT} step={WHATIF_STEP} value={incomePct} onChange={(e) => setIncomePct(Number(e.target.value))} className="w-full accent-green cursor-pointer" aria-label="Assumed monthly income, percent of history" />` (mirror for expenses, `aria-label="Assumed monthly expense, percent of history"`).

d) **Takeaway annotation** — the takeaway text already recomputes from `forecast.points`; when the assumptions are off-baseline, append what they are so the line is self-describing. After building the existing `takeaway` string:

```ts
const adjustments: string[] = [];
if (incomePct !== 100) adjustments.push(`income ${incomePct > 100 ? '+' : '-'}${Math.abs(incomePct - 100)}%`);
if (expensePct !== 100) adjustments.push(`expenses ${expensePct > 100 ? '+' : '-'}${Math.abs(expensePct - 100)}%`);
const takeawayFull = adjustments.length > 0 ? `${takeaway} · assuming ${adjustments.join(', ')}` : takeaway;
```

Render `takeawayFull`. (The "pessimistic path runs low" clause keeps working unchanged at any horizon.)

No other render changes: `chartData` mapping, bands, median line, X/Y axes, tooltip, and the footer line are horizon-agnostic and re-render from the new `forecast` automatically.

### 3. Tests — extend `src/__tests__/cashflow-forecast.test.ts`

Add a `describe('what-if assumptions')` block inside `runCashflowForecast`'s coverage (reuse the file's existing `variedHistory` fixture where noted). Import `WHATIF_MIN_PCT`, `WHATIF_MAX_PCT`, `WHATIF_STEP` alongside the existing imports.

1. **Lowering assumed expenses raises the median under the same seed** (AC pin):
   - Varied history + `seed: 42`, `startBalance: 5000`, `startMonth: '2026-09'`: baseline vs `expenseScale: 0.5` — assert `cheaper.points[i].p50 >= baseline.points[i].p50` for **every** step, and `cheaper.points[12].p50 > baseline.points[12].p50` (deterministic under the fixed seed, so the strictness is stable).
   - Degenerate exact pin: identical-month history (income 3000, expenses 2000, like the existing degenerate test) with `expenseScale: 0.5` → at every step k, **all five** percentiles equal `1000 + k * 2000` exactly (`toBe`). Proves the scale reaches the simulation through bootstrap + percentile + accumulation.
2. **Raising assumed income raises the median under the same seed** (symmetric pin): degenerate history with `incomeScale: 1.5` → step k percentiles equal `1000 + k * 4500 - k * 2000` exactly; and with **both** scales (`incomeScale: 1.5, expenseScale: 0.5`) → `1000 + k * 3500` exactly.
3. **A longer horizon yields a longer series** (AC pin): `horizonMonths: 24` → `points.length === 25` and `points[24].step === 24`; `horizonMonths: 6` → 7 (already pinned; keep it passing).
4. **Horizon prefix-stability under one seed** (honesty pin): the 24-month run's first 13 points `toEqual` the 12-month run's 13 points (same seed, same assumptions). Comment in the test: extending the horizon must not reshuffle earlier months — the per-path draw order is unchanged.
5. **Determinism with assumptions**: two runs identical in every opt **including `incomeScale`/`expenseScale`** `toEqual` each other; a run differing only in `incomeScale` has a different p50 series somewhere (varied history).
6. **Scale sanitization**: `incomeScale: Number.NaN` and `expenseScale: -1` each behave exactly like the default (degenerate history, compare `toEqual` against the unscaled run); `WHATIF_MIN_PCT === 50`, `WHATIF_MAX_PCT === 150`, `WHATIF_STEP === 5` pinned.
7. **Anchor unaffected by scales**: with `incomeScale: 1.5, expenseScale: 0.5`, `points[0]` percentiles all still equal `startBalance` exactly.

No new test files; no component tests (the repo has no React test rig — engine tests are the deterministic contract, per AC).

### 4. `CHANGELOG.md`

Add a new `## [Unreleased]` section above `## [v0.7.0]`, with a `### Other` heading (where #80's card landed) and one bullet matching the house one-line-with-detail style, ending `(#81)`:

`Add what-if controls to the Cash Forecast card: 6/12/24-month horizon selector and ±50% income/expense assumption sliders that re-run the seeded in-browser simulation in place (#81)`

## Out of scope

- No persistence of what-if settings (fresh visit = baseline), no URL/state serialization, no goal integration, no seasonality/interest/tax modeling.
- No change to the fetch: `/api/cashflow/monthly?months=24` stays; the sampling pool is 24 months of history regardless of the projection horizon (24-month projections bootstrap from the same observed months).
- No change to the engine's result shape, anchor semantics, seed defaults, or `MIN_HISTORY_MONTHS` gate; no new endpoint; no schema change; no new dependencies.
- No Web Worker (24 × 500 × 2 ≈ 24k draws is still trivial on the main thread).
- The empty state and loading skeleton get no controls — there is nothing to adjust until a forecast exists.

## Verification

1. `bun install` (root — node_modules are missing in this fresh worktree), then `bun test src/__tests__/cashflow-forecast.test.ts`, then full `bun test`.
2. `bun run typecheck` (root tsc; the engine is pulled into the root program via the test import).
3. Dashboard UI build: `cd src/dashboard/ui && bun install && bun run build` (runs `tsc -b && vite build`); UI tsc covers the modified lib + component.
4. Manual check — scratch profile with realistic history (same pattern as the #80 scratch; accounts: checking 4200 + savings 9800 + cash 120 liquid, a brokerage account that must NOT count, 8 complete months of ~4.2–4.7k income vs ~2.3–3.2k expenses, a Transfer credit-card payment row; delete the scratch file afterwards). Open http://localhost:3141 → Overview:
   - Controls appear above the chart: `6m | 12m | 24m` pills (12 active), Reset disabled at baseline, two sliders at 0%.
   - Drag the **Expenses** slider down (e.g. −25%): the fan bands shift **up immediately** with no network request (verify in devtools Network tab: no new `/api/cashflow/monthly` or `/api/accounts` call), the pct label turns green and the takeaway gains `· assuming expenses -25%`.
   - Switch the horizon 12 → 24: the chart extends to 24 projected months, the takeaway's "Median cash in <label>" moves 12 months out; the earlier half of the fan keeps its shape (prefix-stability).
   - Switch to 6: the chart contracts to 6 months.
   - Hit **Reset**: sliders return to 0%, horizon to 12m, takeaway loses the assumption clause and matches the pre-interaction baseline exactly (same seed + same assumptions ⇒ same projection).
   - Empty-history check: comment out the transaction seeding, rerun → no controls, "needs a couple of months" explainer, as before.

## Acceptance criteria mapping

- Horizon + income/expense reach the simulation as parameters; deterministic tests pin lower-expenses-raises-median and longer-horizon-longer-series → §1 (scales as opts), §3 tests 1–4.
- Controls recompute chart + takeaway in place without refetching history; reset restores baseline → §2 (state + memo deps unchanged on data, reset button), §4 manual check (Network tab + reset comparison).
- `bun test`, root typecheck, dashboard UI build pass → Verification 1–3.
- Manual: expense drag shifts bands up + takeaway updates; horizon 12→24 extends; reset returns baseline → Verification 4.