# Plan: Forecast tab — Monte Carlo net-worth fan chart with live what-if sliders (issue-42)

Slice one of the net-worth projection surface. Issue #42 cites a design doc
(`docs/plans/2026-09-08-003-monte-carlo-fan-chart-slice1-design.md`) that was **never committed and does not
exist** — this spec is that design work. A new top-level **Forecast** tab projects net worth as p10/p25/p50/p75/p90
bands over a 5–40 year horizon, driven by four live sliders. The simulation runs in a dedicated Web Worker (plain
JS, no new dependencies) and the existing cash-forecast engine is generalized so both surfaces share one core.

**No new endpoints, no schema change, no new dependencies, no data leaves the machine.**

## Where things stand (verified in this worktree)

- **Existing engine** `src/dashboard/ui/src/lib/cashflowForecast.ts` (161 lines) exports `CashflowMonth`,
  `ForecastPoint {step,label,p10,p25,p50,p75,p90}`, `CashflowForecast`, `FORECAST_PATHS=500` (:38),
  `FORECAST_HORIZON_MONTHS=12` (:39), `MIN_HISTORY_MONTHS=2` (:41), `DEFAULT_SEED=1337` (:42),
  `WHATIF_MIN_PCT/MAX_PCT/STEP` (:45–47), `mulberry32` (:52), `percentile` (:64, nearest-rank, **not**
  interpolated), `runCashflowForecast` (:77).
- Its sim (:120–133) is a bootstrap-with-replacement resample, **step-major / path-minor**, per-path balance carried
  across steps, what-if scales multiplied **after** the draw. The comment at :112–119 states the three invariants
  that buys: reproducibility, horizon prefix-stability, and what-if replay stability. All three are pinned by tests.
- **Baseline confirmed in this worktree:** `bun test src/__tests__/cashflow-forecast.test.ts` → **21 pass, 0 fail,
  2539 expect() calls**, 17 ms. `bun run typecheck` clean.
- `src/__tests__/cashflow-forecast.test.ts:26-49` pins mulberry32's exact IEEE doubles for seeds 42 and 1. Its
  import list (:2-11) is the API contract the refactor must not break: `mulberry32`, `percentile`,
  `runCashflowForecast`, `MIN_HISTORY_MONTHS`, `WHATIF_MIN_PCT`, `WHATIF_MAX_PCT`, `WHATIF_STEP`, type
  `CashflowMonth`.
- **Shipped card** `src/dashboard/ui/src/components/CashflowForecast.tsx` (288 lines) recomputes **synchronously on
  the main thread** in a `useMemo` (:112-125) on every slider `onChange` (:229, :247) — no debounce, no worker. Fine
  for 24k draws; not viable for 20,000 × 480. The new tab uses a worker instead.
- **Recharts fan technique** (`CashflowForecast.tsx:154-163`, `:273-279`): stack band *deltas* on an invisible p10
  base (`band25 = p25 - p10`, …) with `stackId="fan"`, every series `isAnimationActive={false}`. Colors are
  hardcoded hex (`#233046`, `#2e4a6b`, `#e4e4e7`, `#ef4444`, axis `#a1a1aa`); chrome uses Tailwind tokens
  (`bg-surface-raised border border-border rounded-lg p-4`, `text-text-secondary`, …). recharts is already a
  dependency (`src/dashboard/ui/package.json`: `recharts ^2.15.3`).
- **Worker precedent exists and already solves the singlefile problem:** `src/dashboard/ui/src/store/mirror-worker.ts`
  is imported as `'./mirror-worker.ts?worker&inline'` (`mirror-client.ts:11`); `vite.config.ts:52-55` sets
  `worker: { format: 'es', plugins: () => [waSqliteWasmInline()] }` alongside `viteSingleFile()` (:48). The worker's
  request/response protocol (`mirror-worker.ts:6-11`, `:75-85`) is `{ id, type, … }` → `{ id, ok, result|error }`,
  serialized through a promise chain (:73). The `?worker&inline` module type resolves via `vite/client`
  (`src/dashboard/ui/src/vite-env.d.ts`), which the UI tsconfig picks up through `include: ["src"]`.
- **Endpoints already exist.** `GET /api/net-worth` (`server.ts:611` → `apiNetWorth`, `api.ts:476` →
  `getNetWorthSummary`, `net-worth-queries.ts:362`) returns `NetWorthSummary` — UI wire type `NetWorthResponse`
  (`types.ts:179-186`) carries `netWorth`, `totalAssets`, `totalLiabilities`, `accounts`.
  `GET /api/cashflow/monthly?months=24` (`server.ts:427` → `apiCashflowMonthly`, `api.ts:148`) returns
  `MonthlyCashflowRow[]` (`types.ts:125-129`) — complete calendar months only.
- **Offline:** the mirror (schema v3) does not carry `accounts`; `src/__tests__/mirror-fallback.test.ts:97` pins
  `/api/net-worth` as unmirrored (and `:98` pins `/api/cashflow/monthly` likewise). `CashflowForecast.tsx:135-137`
  is the precedent: `offline && !data` → `<OfflineUnavailable title=… />`
  (`src/dashboard/ui/src/components/OfflineUnavailable.tsx`). `useApi` already exposes `offline`
  (`hooks/useApi.ts:10`, `:39`).
- **Tab registration needs three edits in lockstep:** `components/TabBar.tsx:1-12` `TABS`, `App.tsx:26-37`
  `TAB_COMPONENTS`, and the hand-maintained `valid: TabId[]` in `App.tsx:22`. Current tabs: overview, transactions,
  review, accounts, goals, chat, demo, llm, logs, settings.
- **Test/typecheck topology:** root `tsconfig.json` excludes `src/dashboard/ui` from `include` but imported files
  join the root program; root is ESNext + `declaration: true` + strict, UI is ES2022 + `noEmit` + `isolatedModules`.
  Root scripts: `"typecheck": "tsc --noEmit"`, `"test": "bun test --isolate"`. CI (`.github/workflows/ci.yml`)
  runs ubuntu-latest + macos-latest, bun 1.4.2, `bun install --frozen-lockfile`, `bun run typecheck`, then **each**
  `src/__tests__/*.test.ts` in its own process.
- Source-file assertions in tests have precedent (`src/__tests__/transformers-webgpu-ep.test.ts:2`, `:15`,
  `:52`, `:64` read `package.json`/`bun.lock` with `readFileSync`) — used below to pin the tab-registration lockstep
  and the worker-boundary architecture.
- `src/tools/query/forecast.ts`, `src/orchestration/chains/cash-flow-forecast.yaml` and
  `src/skills/cash-flow-forecast/SKILL.md` are the separate paid-tier deterministic forecasting surface.
  **Not touched, not coupled to.**
- `CHANGELOG.md` head is `## [v0.9.1] — 2026-09-25`; there is no `## [Unreleased]` section — add one.

### Measured on this machine (bun 1.4.2, darwin), driving the exact loop specified below

| paths | months | quarterly buckets | wall clock |
|---|---|---|---|
| 5,000 | 240 | 80 | ~50 ms |
| 5,000 | 480 | 160 | ~88 ms |
| 20,000 | 240 | 80 | ~137 ms |
| 20,000 | 480 | 160 | ~295 ms |

The worst case (20k paths × 40 years) is ~300 ms of worker time — comfortably inside the "20,000 on release"
budget, and the reason the CI ceilings below are set generously at ~15× headroom.

## Changes

### 1. `src/dashboard/ui/src/lib/forecastCore.ts` — NEW: the shared simulation core

Zero imports. No DOM, no `import.meta.env`, no browser APIs — it joins the **root** tsc program through the test
imports, exactly like `hybrid/core.ts`, so it must be clean under root (ESNext, `declaration: true`, strict) **and**
UI (ES2022, `noEmit`, `isolatedModules`) tsconfigs.

**Moved verbatim from `cashflowForecast.ts`** (same function bodies, byte-for-byte — the goldens at
`cashflow-forecast.test.ts:26-49` are the gate):

```ts
export interface ForecastPoint {
  /** 0 = anchor (now, unsimulated); thereafter the simulated step index. */
  step: number;
  /** 'Now' for step 0, else 'MMM YYYY' (e.g. 'Oct 2026'). */
  label: string;
  p10: number; p25: number; p50: number; p75: number; p90: number;
}

export const DEFAULT_SEED = 1337;

/** Mulberry32 — tiny seeded PRNG, deterministic under test. */
export function mulberry32(seed: number): () => number;  // body verbatim from cashflowForecast.ts:52-61

/** Nearest-rank percentile of an ascending-sorted array. */
export function percentile(sortedAsc: ArrayLike<number>, p: number): number;  // body verbatim from :64-70

/** Non-finite or negative what-if scales fall back to no adjustment (no-throw posture). */
export function sanitizeScale(v: number | undefined, fallback?: number): number;  // body verbatim from :73-75
```

**One deliberate widening:** `percentile`'s parameter goes `number[]` → `ArrayLike<number>` so the net-worth
simulator can pass a `Float64Array` without a copy. The body is unchanged (`.length` + index access only) and
`number[]` still satisfies `ArrayLike<number>`, so `cashflow-forecast.test.ts:52-61` passes untouched.
`sanitizeScale` is promoted from private to exported — the net-worth simulator reuses it.

**New, layered on top of the existing uniform source:**

```ts
const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

/** 'Now' for step 0, else 'MMM YYYY' offset `step` months from `startMonth` ('YYYY-MM'). */
export function stepLabel(startMonth: string, step: number): string;

/**
 * One standard-normal draw via Box–Muller, layered on top of an existing
 * uniform source. Consumes EXACTLY two uniforms per call and deliberately
 * discards the sine component: caching the second variate would make RNG
 * consumption depend on call parity, which would break the step-major
 * prefix-stability invariant the engine is built around. `1 - rng()` maps
 * [0, 1) onto (0, 1] so Math.log is always finite.
 */
export function standardNormal(rng: () => number): number {
  const u1 = 1 - rng();
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/** p10/p25/p50/p75/p90 of an ascending-sorted sample, nearest-rank. */
export function bands(sortedAsc: ArrayLike<number>): Omit<ForecastPoint, 'step' | 'label'>;
```

`standardNormal` is **new math above** the existing uniform source. It does not touch the bootstrap draw path and
does not change how `runCashflowForecast` consumes its RNG — the cash forecast never calls it.

### 2. `src/dashboard/ui/src/lib/cashflowForecast.ts` — MODIFIED: delegate + re-export

This is the whole of "how the 21 existing tests keep passing unchanged."

**Deleted from this file:** the bodies of `mulberry32`, `percentile`, `sanitizeScale`, the `MONTH_NAMES` array, the
`ForecastPoint` interface, and `DEFAULT_SEED`.

**Added at the top:**

```ts
import { mulberry32, percentile, sanitizeScale, stepLabel, DEFAULT_SEED } from './forecastCore.js';
import type { ForecastPoint } from './forecastCore.js';

// Re-exported so this module's public surface is byte-identical to what it
// shipped with: src/__tests__/cashflow-forecast.test.ts and
// components/CashflowForecast.tsx both import these names from HERE.
export { mulberry32, percentile, DEFAULT_SEED } from './forecastCore.js';
export type { ForecastPoint } from './forecastCore.js';
```

(`isolatedModules` is satisfied: values re-export with `export {}`, types with `export type {}`.)

**Unchanged in this file:** `CashflowMonth`, `CashflowForecast`, `FORECAST_PATHS`, `FORECAST_HORIZON_MONTHS`,
`MIN_HISTORY_MONTHS`, `WHATIF_MIN_PCT/MAX_PCT/STEP`, and the entire body of `runCashflowForecast` — including the
step-major loop, the scale-after-the-draw multiplication at :130, the anchor construction, and the
`MIN_HISTORY_MONTHS = 2` gate, which stays **2** (it is the cash card's gate; the net-worth forecast has its own).
The only edit inside `runCashflowForecast` is that the label construction at :135, :149, :152 collapses to
`stepLabel(opts.startMonth, step)` — same output, same `new Date(year, mon - 1 + step, 1)` arithmetic.

**Net effect on tests:** `src/__tests__/cashflow-forecast.test.ts` is **not edited**. All 21 tests / 2539 assertions
must still pass byte-for-byte. If any of them needs a change, the refactor is wrong — fix the refactor.

### 3. `src/dashboard/ui/src/lib/netWorthForecast.ts` — NEW: the net-worth simulator

Pure, dependency-free, DOM-free (imports only `./forecastCore.js`). Tested from root.

```ts
export interface NetWorthSimInput {
  /** Net worth today, from GET /api/net-worth (`netWorth`). May be negative. */
  startNetWorth: number;
  /**
   * Pool of observed monthly net cash flows (income − expenses) to bootstrap
   * contributions from. In manual-inputs mode this is a single-element pool,
   * which makes contributions deterministic through the identical code path.
   */
  contributionPool: number[];
  /** Dollars/month added AFTER each bootstrap draw (the savings-rate slider). */
  contributionDelta: number;
  /** Median real annual compound return, e.g. 0.05. Real dollars; nominal is not modeled. */
  realAnnualReturn: number;
  /** Annual return volatility. FIXED at 0.15 by the caller; an input only so tests can set 0. */
  annualVolatility: number;
  /** 60..480. */
  horizonMonths: number;
  /** One-off net-worth shock applied at the START of `month` (1-based), before that month's return. */
  shock: { month: number; amount: number } | null;
  paths: number;
  seed: number;
  /** Emit a point every N simulated months. 3 (quarterly) in the UI. */
  bucketMonths: number;
  /** 'YYYY-MM' the projection starts from; required for deterministic labels. */
  startMonth: string;
}

export interface NetWorthForecast {
  /** Anchor + one point per bucket: length = 1 + floor(horizonMonths / bucketMonths). */
  points: ForecastPoint[];
  startNetWorth: number;
  pathCount: number;
  horizonMonths: number;
}

export const NET_WORTH_MIN_HISTORY_MONTHS = 6;
export const FIXED_ANNUAL_VOLATILITY = 0.15;
export const BUCKET_MONTHS = 3;
export const DRAG_PATHS = 5_000;
export const RELEASE_PATHS = 20_000;
export const STEP_CHUNK = 6;               // yield to the worker message queue every 2 quarters

/** Slider bounds (UI-bound, exported so component and tests share one source). */
export const SAVINGS_DELTA_MIN_PP = -10;   // percentage points of monthly income
export const SAVINGS_DELTA_MAX_PP = 25;
export const SAVINGS_DELTA_STEP_PP = 1;
export const RETURN_MIN = -0.02;           // real annual
export const RETURN_MAX = 0.10;
export const RETURN_STEP = 0.0025;
export const RETURN_DEFAULT = 0.05;
export const HORIZON_MIN_YEARS = 5;
export const HORIZON_MAX_YEARS = 40;
export const HORIZON_DEFAULT_YEARS = 20;
export const SHOCK_MIN = -100_000;
export const SHOCK_MAX = 100_000;
export const SHOCK_STEP = 5_000;
export const SHOCK_DEFAULT_YEAR = 5;

/** Drive the generator to completion on the calling thread (tests, and the non-chunked path). */
export function runNetWorthForecast(input: NetWorthSimInput): NetWorthForecast | null;

/**
 * The same simulation as a generator, yielding a 0..1 progress fraction at
 * every chunk boundary. The worker drives this so a long run can be aborted
 * or superseded between chunks; `runNetWorthForecast` is literally
 * `for (const _ of simulateNetWorth(i)); return gen.return-value`.
 * ONE engine — the chunked and unchunked results are identical by construction
 * and pinned by test.
 */
export function simulateNetWorth(
  input: NetWorthSimInput,
): Generator<number, NetWorthForecast | null, void>;

/** History → simulator inputs. Returns null below NET_WORTH_MIN_HISTORY_MONTHS. */
export function deriveNetWorthInputs(history: CashflowLike[]): {
  contributionPool: number[];      // income − expenses per observed month
  medianMonthlyIncome: number;     // converts the savings-rate slider to dollars
  medianMonthlyContribution: number;
  months: number;
} | null;

/** Percentage-point savings-rate delta → dollars/month. */
export function savingsDeltaToDollars(deltaPp: number, medianMonthlyIncome: number): number;
```

**Sanitization (no-throw posture, matching `sanitizeScale`).** Return `null` when, after dropping non-finite entries,
`contributionPool.length < 1`, or `paths < 1`, or `horizonMonths < 1`, or `bucketMonths < 1`, or `startNetWorth` /
`realAnnualReturn` / `annualVolatility` is non-finite, **or `realAnnualReturn <= -1`** (`Math.log(1 + r)` is
`-Infinity` at exactly `-1` and `NaN` below it, so without this guard a "finite" input silently yields a chart of
`NaN` bands instead of an honest `null`; unreachable from the UI, where `RETURN_MIN` is `-0.02`). `paths`,
`horizonMonths` and `bucketMonths` are checked with `Number.isFinite` *before* the `< 1` comparison — `NaN < 1` is
`false`, so a bare `< 1` test would let `NaN` through to `new Float64Array(NaN)` — and are floored, since a
fractional `paths` makes the `Float64Array` constructor throw. A `shock` whose `month` is non-finite, `< 1`, or
`> horizonMonths` is treated as `null`. A non-finite `contributionDelta` falls back to 0.

**The model, per path per month `t = 1..horizonMonths`:**

```
muMonthlyLog = Math.log(1 + realAnnualReturn) / 12     // slider = MEDIAN compound real return
sigmaMonthly = annualVolatility / Math.sqrt(12)

if (shock && t === shock.month) nw += shock.amount     // start of month, before the return
contribution = pick(contributionPool) + contributionDelta   // scaled AFTER the draw
z = standardNormal(rng)
// Growth applies ONLY to a positive balance. A negative (underwater) net worth
// is carried flat and is climbed out of by contributions — never compounded.
grown = nw > 0 ? nw * Math.exp(muMonthlyLog + sigmaMonthly * z) : nw
nw = grown + contribution                              // end-of-month contribution
```

Log-normal growth (not arithmetic) so the **median** path compounds at exactly the slider's stated rate, no path can
cross zero from returns alone, and the assumptions panel has one honest sentence to say about it.

**Underwater balances are never compounded.** `startNetWorth` may legitimately be negative (a mortgage or student
loans exceeding assets is a common real state — §11 allows it). Applying exponential growth to a signed net worth
would compound *debt* at the equity return, so an underwater user's projection would spiral downward and could
never recover. Growth is therefore gated on `nw > 0`: a non-positive balance is carried flat through the return
step and moves only by contributions and shocks. Consequences to pin by test (§14 test 21): a path at exactly `0`
stays `0` under returns alone; a negative path never becomes *more* negative from returns; and with a positive
contribution an underwater path does reach and cross zero, after which normal compounding resumes. Recorded in the
assumptions panel as limitation 10 (§12).

**Loop order is step-major / path-minor**, identical in shape to `cashflowForecast.ts:122-133` — that is what buys
horizon prefix-stability (dragging the horizon slider never reshuffles the months already on screen) and
what-if replay stability (changing only the return or the savings delta consumes identical randomness). Exactly
**three uniforms per path-step**: one for the bootstrap pick, two for the normal.

**Storage:** one `Float64Array(paths)` carries the running net worth. At every bucket boundary
(`step % bucketMonths === 0`) take `nw.slice()`, call `.sort()` — `Float64Array.prototype.sort` is **numeric by
default**, unlike `Array.prototype.sort`; do not pass a comparator — and extract the five bands with the shared
`percentile`. Note `Float64Array` is stack-allocated once outside the loop; nothing is allocated per path.

**Chunking:** `simulateNetWorth` yields `step / horizonMonths` after finishing every `STEP_CHUNK` steps and once
more at the end. Total yields ≤ `Math.ceil(horizonMonths / STEP_CHUNK) + 1`. Yielding is pure bookkeeping; it does
not touch the RNG.

**Anchor:** `points[0] = { step: 0, label: 'Now', p10..p90: startNetWorth }`, never simulated, never shocked,
never scaled — same semantics as the cash forecast's anchor.

### 4. `src/dashboard/ui/src/lib/netWorthForecastProtocol.ts` — NEW: the worker message contract

Pure, zero imports except types from `./netWorthForecast.js`. Lives in its own module so the supersession logic is
unit-testable from root **without a worker or a DOM**.

```ts
export type ForecastQuality = 'draft' | 'final';

/** main → worker */
export type ForecastRequest =
  | { type: 'run'; runId: number; input: NetWorthSimInput; quality: ForecastQuality }
  | { type: 'cancel'; runId: number };

/** worker → main */
export type ForecastResponse =
  | { type: 'result'; runId: number; quality: ForecastQuality; forecast: NetWorthForecast | null; elapsedMs: number }
  | { type: 'progress'; runId: number; fraction: number }
  | { type: 'cancelled'; runId: number }
  | { type: 'error'; runId: number; message: string };

export function pathsFor(quality: ForecastQuality): number;   // 'draft' → 5_000, 'final' → 20_000

/**
 * A request is accepted only if it is strictly newer than what the worker is
 * already running or has already run. Late/duplicate posts are dropped, which
 * is what makes out-of-order delivery during a fast drag harmless.
 */
export function shouldStart(runId: number, activeRunId: number): boolean;   // runId > activeRunId

/** An in-flight run aborts at its next chunk boundary once a newer run arrives. */
export function shouldAbort(myRunId: number, activeRunId: number): boolean; // myRunId !== activeRunId
```

`pathsFor` is the single source of the "5,000 while dragging / 20,000 on release" rule from the issue.

### 5. `src/dashboard/ui/src/lib/netWorthForecast.worker.ts` — NEW: the worker

Mirrors `store/mirror-worker.ts` in structure and in its `WorkerScope` shim (`mirror-worker.ts:64-69`) — the UI
tsconfig does not include `lib.webworker.d.ts`, so the same minimal interface is redeclared here (with
`postMessage`, `onmessage`).

```ts
import { simulateNetWorth } from './netWorthForecast.js';
import { shouldStart, shouldAbort, pathsFor } from './netWorthForecastProtocol.js';

let activeRunId = 0;

async function run(runId: number, input: NetWorthSimInput, quality: ForecastQuality): Promise<void> {
  const t0 = performance.now();
  const gen = simulateNetWorth({ ...input, paths: pathsFor(quality) });
  let next = gen.next();
  while (!next.done) {
    if (shouldAbort(runId, activeRunId)) {
      gen.return(null);                         // release the Float64Array immediately
      ctx.postMessage({ type: 'cancelled', runId });
      return;
    }
    ctx.postMessage({ type: 'progress', runId, fraction: next.value });
    // A macrotask, NOT a microtask: only a task boundary lets the worker's
    // message queue deliver a newer 'run' while this one is mid-flight.
    await new Promise((r) => setTimeout(r, 0));
    next = gen.next();
  }
  if (shouldAbort(runId, activeRunId)) { ctx.postMessage({ type: 'cancelled', runId }); return; }
  ctx.postMessage({
    type: 'result', runId, quality,
    forecast: next.value, elapsedMs: performance.now() - t0,
  });
}
```

`onmessage` handles `'run'` by checking `shouldStart(msg.runId, activeRunId)`, setting `activeRunId = msg.runId`,
and calling `run(...)` **without awaiting** (so the handler returns and the queue keeps draining); `'cancel'` sets
`activeRunId = msg.runId + 1` so the in-flight loop aborts. Any throw is caught and posted as
`{ type: 'error', runId, message }` — the worker never dies on a bad input.

Unlike the mirror worker there is **no promise chain serializing dispatch**: superseding an in-flight run is the
whole point, so messages must be processed as they arrive.

### 6. `src/dashboard/ui/src/lib/netWorthForecastClient.ts` — NEW: main-thread client

```ts
import ForecastWorkerCtor from './netWorthForecast.worker.ts?worker&inline';
```

Exactly the `?worker&inline` form `mirror-client.ts:11` uses, so `viteSingleFile()` + `worker: { format: 'es' }`
(`vite.config.ts:48`, `:52-55`) keep producing a single `dist/index.html`. **This module must never be imported
from a root test** — it is the only one in this slice that needs `vite/client` types.

```ts
export interface ForecastClient {
  /** Post a run; supersedes anything in flight. Returns the runId issued. */
  request(input: NetWorthSimInput, quality: ForecastQuality): number;
  subscribe(fn: (r: ForecastResponse) => void): () => void;
  dispose(): void;
}
export function createForecastClient(): ForecastClient | null;  // null if Worker is unavailable
```

Lazy spawn on first `request`. Monotonic `runId`. A `worker.onerror` disposes the worker and emits
`{ type: 'error' }` so the UI can fall back (see §8). No timeouts: a run either completes, is cancelled, or the
worker errors.

### 7. `src/dashboard/ui/src/hooks/useNetWorthForecast.ts` — NEW: the drag/release escalation

Owns the two-tier quality policy the issue asks for.

```ts
export interface UseNetWorthForecast {
  forecast: NetWorthForecast | null;   // last completed result of EITHER quality
  quality: ForecastQuality | null;     // quality of `forecast`
  refining: boolean;                   // a 'final' run is in flight over a shown 'draft'
  progress: number;                    // 0..1 of the in-flight run
  error: string | null;
  /** Call on every slider onChange. */
  onInputChange(input: NetWorthSimInput): void;
  /** Call on pointerup / keyup / blur — escalates to 20,000 paths. */
  onInputSettled(input: NetWorthSimInput): void;
}
```

Policy:

1. `onInputChange` stores the input in a ref and schedules a `requestAnimationFrame` if none is pending. On the
   frame, it posts **one** `'draft'` (5,000-path) run with the latest input. Coalescing to one post per frame is
   what keeps a fast drag from queueing dozens of runs; superseding in the worker handles whatever still slips
   through.
2. `onInputChange` also arms a **250 ms settle timer**, reset on every change. If it fires, it behaves as
   `onInputSettled`. This is the keyboard/assistive-tech path — `<input type="range">` arrowed with the keyboard
   never fires `pointerup`.
3. `onInputSettled` cancels the settle timer and posts a `'final'` (20,000-path) run immediately.
4. `refining` is true from posting a `'final'` until its `result` arrives; the chart keeps showing the last draft
   meanwhile (no flicker, no empty frame).
5. `'result'` messages whose `runId` is older than the newest issued id are ignored on the main thread too —
   belt and braces against out-of-order delivery.
6. On unmount, `dispose()`.

**Honesty note to carry into the code comment and the UI:** a 5,000-path draft and a 20,000-path final are
*different samples*, not a prefix of one another — step-major/path-minor means path `p` at step `t` consumes a
different slice of the stream when `paths` changes. Bands therefore shift slightly (measured: ~0.7 % on the p50 at
20 years) when the final lands. That is sampling error, and the readout quotes the **final** numbers. The tradeoff
is deliberate: step-major is what makes the *horizon* slider stable, which the user sees constantly; the
draft→final shift happens once per drag.

### 8. `src/dashboard/ui/src/tabs/ForecastTab.tsx` — NEW: the tab

Shell matches the other tabs: `<div className="flex-1 overflow-y-auto p-6 space-y-4">` (`GoalsTab.tsx:154`,
`OverviewTab.tsx:32`).

Data (neither call uses `useFilterParams()` — the projection starts from now, same posture as
`CashflowForecast.tsx:88-94`):

```tsx
const { data: nw, loading: nwLoading, offline: nwOffline } = useApi<NetWorthResponse>('/api/net-worth');
const { data: history, loading: hLoading } = useApi<MonthlyCashflowRow[]>('/api/cashflow/monthly?months=24');
```

Render order:

1. `nwLoading || hLoading` → pulse skeleton (`h-[320px] animate-pulse bg-border-muted rounded`).
2. `nwOffline && !nw` → `<OfflineUnavailable title="Forecast" />` — the exact precedent
   `CashflowForecast.tsx:135-137` sets. `/api/net-worth` is unmirrored by design
   (`mirror-fallback.test.ts:97`); **`MIRROR_SCHEMA_VERSION` is not bumped and no mirror code changes.**
3. `createForecastClient()` returned `null`, or the client reported `{ type: 'error' }` → an inline muted notice
   ("This projection needs a Web Worker, which this browser blocked.") plus the assumptions panel. No main-thread
   fallback: a 20,000-path run on the main thread is exactly the freeze the worker exists to prevent.
4. `deriveNetWorthInputs(history)` returned `null` (fewer than 6 usable months) → `<ManualInputsForm>` (§11) above
   the chart; everything else renders normally from the manual values.
5. Otherwise the chart, the controls, the readout, and the assumptions panel.

Slider state is `useState` in this component. **Not persisted** — no localStorage, no URL hash, per the founder
decision. A remount is a fresh baseline.

Composed input:

```ts
const simInput: NetWorthSimInput = {
  startNetWorth: manual ? manualStartNetWorth : (nw?.netWorth ?? 0),
  contributionPool: manual ? [manualMonthlyContribution] : derived.contributionPool,
  contributionDelta: savingsDeltaToDollars(savingsDeltaPp, manual ? manualMonthlyIncome : derived.medianMonthlyIncome),
  realAnnualReturn,
  annualVolatility: FIXED_ANNUAL_VOLATILITY,
  horizonMonths: horizonYears * 12,
  shock: shockAmount === 0 ? null : { month: (shockYear - 1) * 12 + 1, amount: shockAmount },
  paths: DRAG_PATHS,                 // overwritten by pathsFor(quality) in the worker
  seed: DEFAULT_SEED,
  bucketMonths: BUCKET_MONTHS,
  startMonth: new Date().toISOString().slice(0, 7),
};
```

Readout under the chart (`text-sm text-text`), always quoting the **final** run when one exists:

> Median net worth in {last.label}: **{fmtUsd(last.p50)}** · 10th–90th percentile {fmtUsd(last.p10)} –
> {fmtUsd(last.p90)} · {pathCount.toLocaleString()} simulated paths{refining ? ' · refining…' : ''}

### 9. `src/dashboard/ui/src/components/ForecastFanChart.tsx` — NEW

Same technique and the same hardcoded palette as `CashflowForecast.tsx:154-163` and `:253-282`, scaled up
(`h-[360px]`), with the band-delta mapping reused verbatim:

```ts
const chartData = forecast.points.map((pt) => ({
  label: pt.label, p10: pt.p10, p50: pt.p50, p90: pt.p90,
  band25: pt.p25 - pt.p10, band50: pt.p50 - pt.p25,
  band75: pt.p75 - pt.p50, band90: pt.p90 - pt.p75,
}));
```

- `<ComposedChart>`; invisible `p10` base `<Area stackId="fan" fill="transparent">`; four band Areas
  (`#233046` outer, `#2e4a6b` inner, `fillOpacity={0.55}`); `<Line dataKey="p50" stroke="#e4e4e7" strokeWidth={2}
  dot={false}>`. **Every series `isAnimationActive={false}`** — non-negotiable at 30 re-renders/second.
- Axis ticks `{ fontSize: 10, fill: '#a1a1aa' }`, `tickLine={false}`, `axisLine={false}`,
  `interval="preserveStartEnd"`. Y `tickFormatter`: `≥1e6 → $Xm`, `≥1000 → $Xk`, else `$X`.
- **No dashed p10 line** (the cash card's `#ef4444` line at :279): over 40 years the pessimistic edge is not a
  "running low" signal, and the assumptions panel says explicitly that p10 is not a floor.
- Tooltip is a local component styled like `FanTooltip` (`CashflowForecast.tsx:37-66`), showing the quarter label,
  median, and the p10–p90 range.
- `<ReferenceLine y={0} stroke="#2a2d37" />` when `points.some(p => p.p10 < 0)`.

At 40 years / quarterly, `points.length === 161`. Verified against the measured table above: recharts renders 7
series × 161 points without animation comfortably inside a frame.

### 10. `src/dashboard/ui/src/components/ForecastControls.tsx` — NEW

Four controls in a `grid grid-cols-2 gap-4` panel (`bg-surface-raised border border-border rounded-lg p-4`). Every
slider is a native `<input type="range" className="w-full accent-green cursor-pointer">` with
`onChange` → `onInputChange`, and `onPointerUp` / `onKeyUp` / `onBlur` → `onInputSettled`. Each has an `aria-label`
and a live value span (`text-green` when off default, `text-text-muted` at default) — the exact affordance
`CashflowForecast.tsx:216-251` established.

| Control | `aria-label` | min / max / step | default | live label |
|---|---|---|---|---|
| Savings-rate delta | `Savings rate change, percentage points of monthly income` | −10 / 25 / 1 | 0 | `+3 pp (≈ $420/mo)` |
| Real annual return | `Assumed real annual return, percent` | −0.02 / 0.10 / 0.0025 | 0.05 | `5.00% real` |
| Horizon | `Projection horizon, years` | 5 / 40 / 1 | 20 | `20 years` |
| One-off shock | `One-off net worth shock, dollars` | −100000 / 100000 / 5000 | 0 | `−$50,000 in year 5` |

The shock pairs its amount slider with a small year `<input type="range" min={1} max={horizonYears} step={1}>`
(`aria-label="Year of the one-off shock"`), disabled while `shockAmount === 0`, and clamped whenever the horizon
slider shrinks below `shockYear`. Two controls rather than one is a deliberate elaboration of the issue's "one-off
shock": an amount with no timing is not simulatable.

A `Reset` ghost button (`CashflowForecast.tsx:202-213` styling), `disabled` at the default tuple, restores
`(0, 0.05, 20, 0, 5)`.

### 11. `src/dashboard/ui/src/components/ManualInputsForm.tsx` — NEW: manual-inputs mode

Shown when `deriveNetWorthInputs(history)` returns `null` — fewer than `NET_WORTH_MIN_HISTORY_MONTHS = 6` usable
complete months. The panel leads with one muted line: *"Less than six months of history — the projection is using
the numbers you enter below instead of your transaction history."*

Three `<input type="number" inputMode="decimal">` fields in a `grid grid-cols-3 gap-3`:

| Field | Default | Validation |
|---|---|---|
| Starting net worth | `nw.netWorth` from `/api/net-worth` | any finite number, **negative allowed** (underwater is a real state) |
| Monthly income | median income of whatever partial history exists, else `0` | finite, clamped to `>= 0` |
| Monthly savings | median (income − expenses) of partial history, else `0` | finite, **negative allowed** (drawing down) |

Validation posture matches `sanitizeScale`: **never throw, never block**. A blank or unparseable field is treated
as its default and the field gets `border-red` plus a `text-xs text-red` hint; the simulation keeps running on the
last good value. When monthly income is 0 the savings-rate slider is `disabled` with the hint *"Enter monthly
income to use the savings-rate slider."* — the percentage-point delta has no dollar meaning without it.

Prefilling from partial history (1–5 months) is deliberate: it is strictly better than zeros and costs one call to
the same median helper.

Manual values are **not persisted** — same rule as the sliders.

### 12. `src/dashboard/ui/src/components/ForecastAssumptions.tsx` — NEW: assumptions & limitations panel

A **first-class deliverable per the issue**, so: a full-width panel rendered directly below the readout, **always
visible** (not a collapsed `<details>`), present in the manual-inputs and worker-unavailable states too. Two
columns (`grid grid-cols-2 gap-6`) inside the standard card shell, headings `text-xs text-text-secondary uppercase
tracking-wide`, items `text-xs text-text-muted` in a `list-disc pl-4 space-y-1`.

**Assumptions — what this model does**

1. Every figure is in **today's dollars**. The return slider is a *real* return; inflation is not modeled
   separately and nominal balances will look larger.
2. Monthly returns are drawn independently from a log-normal whose **median** compounds at the slider's real annual
   rate, with **volatility fixed at 15% a year**. Volatility is not adjustable in this slice.
3. Volatility is **not fitted from your data**. Net-worth snapshots mix your contributions with market moves, and
   the two cannot be separated from balances alone.
4. Your **whole** net worth is modeled as one blended portfolio growing at that return — cash, property and debt
   included. There is no per-account modeling.
5. Contributions are resampled at random, with replacement, from your observed monthly net cash flow (up to 24
   months), then shifted by the savings-rate slider. They are added at the **end** of each month.
6. Returns and contributions are drawn **independently** — a bad market and a bad savings month never coincide by
   design.
7. The one-off shock is applied at the **start** of its month, before that month's return.
8. The starting point is your current net worth as the accounts table reports it.
9. The simulation is **seeded and deterministic**: the same inputs always produce the same fan.
10. Everything runs in your browser, in a background worker. **No data leaves this machine.**

**Limitations — what this model does not do**

1. **No retirement drawdown.** The model contributes for the entire horizon and never spends the portfolio down.
   Do not read a retirement date off this chart.
2. No taxes, fees, or account-type differences (401(k) vs taxable vs mortgage).
3. Returns are i.i.d. month to month — **no mean reversion, no fat tails, no clustering**. Real crashes arrive in
   runs; these do not, so the model understates sequence-of-returns risk.
4. No income growth, promotions, job loss, or life events beyond the single shock you set.
5. No debt amortisation — debts are netted into a single balance and are never paid down on a schedule. While your
   net worth is positive, liabilities are blended into the portfolio and implicitly grow at the portfolio return,
   which is wrong in detail.
6. Bands are **nearest-rank estimates from a finite sample**. With 5,000 paths the edges move a little between
   runs; the quoted figures come from the 20,000-path run.
7. **p90 is not a promise and p10 is not a floor.** By construction 1 path in 10 finishes outside each edge.
8. Up to 24 months of cash flow is a small sample and may not describe your future.
9. Below six months of history the projection uses the numbers you typed, not your data.
10. **While your net worth is negative, it grows only by what you save** — market returns are not applied to an
    underwater balance, and debts are not modelled as compounding. Once contributions carry you above zero, normal
    compounding resumes.

A closing `text-xs text-text-muted` line names the sources: *"Starting net worth from your accounts
(`/api/net-worth`); contributions from your transaction history (`/api/cashflow/monthly`)."*

### 13. `src/dashboard/ui/src/components/TabBar.tsx` + `src/dashboard/ui/src/App.tsx` — register the tab

Three edits, in lockstep (pinned by a test in §16):

1. `TabBar.tsx:6` — insert `{ id: 'forecast', label: 'Forecast' },` after `goals`.
2. `App.tsx:22` — `const valid: TabId[] = ['overview','transactions','review','accounts','goals','forecast','chat','demo','llm','logs','settings'];`
3. `App.tsx:26-37` — add `forecast: ForecastTab,` to `TAB_COMPONENTS`, plus
   `import { ForecastTab } from '@/tabs/ForecastTab';`.

`TabId` widens automatically from the `TABS` const assertion (`TabBar.tsx:14`).

### 14. `src/__tests__/net-worth-forecast.test.ts` — NEW: the determinism + correctness gate

Imports `../dashboard/ui/src/lib/forecastCore.js` and `../dashboard/ui/src/lib/netWorthForecast.js` (bun resolves
`.js` → `.ts`; both join the root tsc program). Pure — no DB, no DOM, no worker.

**Box–Muller goldens** (computed against the specified implementation in this worktree; pin with `toBe`):

```ts
// standardNormal(mulberry32(42)) — first five
-1.2848381576290195, -0.9453528099747296, -0.6112802846514629,
-0.5658325852126875, -1.9727758972262703
// standardNormal(mulberry32(1337)) — first five  (DEFAULT_SEED)
0.23509028585214065, -1.1291464760850458, -0.7786192506746321,
-1.1663525205128167, -1.2064328428408957
```

1. **Normal goldens** — both seeds above, exact `toBe`.
2. **Exactly two uniforms per normal draw** — after one `standardNormal(mulberry32(42))`, the next `rng()` is
   `0.8524657934904099`, which is mulberry32(42)'s **third** value (verified). Pins that the sine half is
   discarded, not cached.
3. **Bootstrap path untouched** — re-assert mulberry32(42)'s first five inside this file. A refactor that perturbs
   the uniform source fails here as well as in `cashflow-forecast.test.ts`.
4. **Distribution sanity** — 200,000 draws from `mulberry32(2024)`: `|mean| < 0.02`, `|sd − 1| < 0.02`, fraction
   within ±3 in `[0.995, 0.999]`. (Measured at 1M draws across five seeds: mean ≤ 0.0018, sd within 0.0012 of 1,
   skew ≤ 0.005, kurtosis 2.99–3.01.) Deterministic — fixed seed, no flake.
5. **`percentile` accepts a `Float64Array`** and returns the same values as for the equivalent `number[]`;
   `Float64Array.prototype.sort()` with no comparator sorts numerically.
6. **Determinism** — two `runNetWorthForecast` calls with identical inputs `toEqual`.
7. **Bands ordered** — `p10 ≤ p25 ≤ p50 ≤ p75 ≤ p90` at every point, varied pool, non-zero vol.
8. **Anchor** — `points[0].step === 0`, `label === 'Now'`, all five percentiles `toBe(startNetWorth)`, including
   with a shock at month 1 and a non-zero savings delta.
9. **Quarterly bucketing** — `horizonMonths: 120, bucketMonths: 3` → `points.length === 41`,
   `points[k].step === k * 3`, `points[1].label` is three months after `startMonth`, `points[40].step === 120`.
   Also `horizonMonths: 480` → `161` points.
10. **Zero-volatility closed form** — `annualVolatility: 0`, pool `[1000]`, `contributionDelta: 0`,
    `realAnnualReturn: 0.05`, `startNetWorth: 100000`, 120 months: every percentile at the final point equals
    `100000·g¹²⁰ + 1000·(g¹²⁰ − 1)/(g − 1)` with `g = exp(ln(1.05)/12)`, within `1e-9` relative. (Verified:
    iterative and closed-form agree to 8.8e-15.) With `realAnnualReturn: 0` the same setup gives exactly
    `100000 + 1000·k` at step `k` — `toBe`.
11. **Horizon prefix-stability** — a 240-month run's first 41 points `toEqual` a 120-month run's points, same seed,
    same `paths`, same assumptions. The honesty pin for the horizon slider.
12. **Savings-rate delta reaches the simulation** — zero-vol degenerate pool with `contributionDelta: +500` gives
    exactly `start + 1500·k`; with non-zero vol and the same seed, every point's p50 is `>=` the baseline's and the
    last point's is `>`.
13. **Return slider reaches the simulation** — same seed, `0.07` vs `0.05`: last point's p50 strictly greater;
    every point `>=`.
14. **Shock** — `realAnnualReturn: 0`, zero vol, shock `{ month: 13, amount: -50000 }`: points at steps ≤ 12
    `toEqual` the no-shock run's; every point from step 15 on is exactly 50,000 lower.
15. **Shock sanitization** — `month: 0`, `month: horizonMonths + 1`, and non-finite `month`/`amount` all behave
    exactly like `shock: null` (`toEqual` the unshocked run).
16. **Input sanitization** — empty `contributionPool`, all-non-finite pool, `paths: 0`, `horizonMonths: 0`,
    `bucketMonths: 0`, non-finite `startNetWorth` / `realAnnualReturn` / `annualVolatility` each return `null`; a
    non-finite `contributionDelta` `toEqual`s the zero-delta run. Nothing throws.
17. **Chunked ≡ unchunked** — driving `simulateNetWorth` to completion `toEqual`s `runNetWorthForecast` for the
    same input, at three horizons (60/240/480 months). **This is the real gate on the worker path**, and it needs
    no worker and no timing. Also: the generator yields at most `ceil(horizonMonths / STEP_CHUNK) + 1` times, and
    every yielded fraction is in `(0, 1]` and non-decreasing.
18. **Hand-rolled reference** — for `paths: 2, horizonMonths: 2, bucketMonths: 1`, reimplement the loop inline in
    the test with its own `mulberry32` + `standardNormal` and assert the engine's points match exactly. Pins the
    RNG consumption order (pick, then two normal draws) per path-step, which nothing else pins directly.
19. **`deriveNetWorthInputs`** — 6 clean months → pool of 6 net flows, correct medians; 5 months → `null`; 7 months
    where 2 are non-finite → `null` (5 usable); non-finite rows dropped before the count.
20. **Constants** — `NET_WORTH_MIN_HISTORY_MONTHS === 6`, `FIXED_ANNUAL_VOLATILITY === 0.15`,
    `BUCKET_MONTHS === 3`, `DRAG_PATHS === 5000`, `RELEASE_PATHS === 20000`, and every slider bound in §3.
    `MIN_HISTORY_MONTHS` (cash) is still `2` — re-asserted here so a future edit to the net-worth gate cannot
    silently move the cash card's.
21. **`savingsDeltaToDollars`** — `(3, 8000) === 240`; income `0` → `0`; non-finite income → `0`.

### 15. `src/__tests__/net-worth-forecast-perf.test.ts` — NEW: the CI-runnable performance gate

Runs on both matrix OSes. Every case does one discarded warm-up run first so the ceilings measure steady-state, not
JIT warm-up, and each ceiling carries ~15× headroom over the measurements in "Where things stand".

1. **Release budget** — `paths: 20_000, horizonMonths: 480, bucketMonths: 3` completes in **< 5000 ms**; all 161
   points finite and ordered. (measured ~295 ms)
2. **Drag budget** — `paths: 5_000, horizonMonths: 240, bucketMonths: 3` completes in **< 1500 ms**.
   (measured ~50 ms)
3. **Frame-budget proxy (deterministic, no timing)** — for the drag configuration, the largest single chunk is
   `STEP_CHUNK` steps; assert `STEP_CHUNK * DRAG_PATHS <= 30_000` path-steps, the unit of work between two worker
   yields. This is the assertion that actually guarantees responsiveness under supersession, and unlike a wall
   clock it cannot flake.
4. **No per-path allocation** — 20,000-path and 5,000-path runs at the same horizon produce the same
   `points.length`; `pathCount` matches the requested `paths`.
5. **Scaling sanity** — a 480-month run takes no more than 4× a 240-month run at the same path count (linear in
   steps, not quadratic). Asserted as a ratio with a generous bound, so a return to per-step re-sorting of the full
   history would fail here.

All timing assertions use `performance.now()` and are one-sided ceilings — they can only fail on a genuine
regression, never on a fast machine.

### 16. `src/__tests__/net-worth-forecast-protocol.test.ts` — NEW: protocol + architecture pins

Imports the pure protocol module; uses `readFileSync` for the source-level pins, following
`transformers-webgpu-ep.test.ts:2,15`.

1. **`pathsFor`** — `'draft' → 5000`, `'final' → 20000`, matching `DRAG_PATHS` / `RELEASE_PATHS`. The issue's
   "5,000 while dragging, 20,000 on release" lives here and nowhere else.
2. **`shouldStart`** — strictly-newer only: `(5, 4) → true`, `(4, 4) → false`, `(3, 4) → false`. A replayed or
   out-of-order post is dropped.
3. **`shouldAbort`** — `(4, 4) → false`, `(4, 5) → true`, `(5, 4) → true` (a run whose id is not the active one
   aborts in either direction).
4. **Drag simulation** — feed `[run 1 draft, run 2 draft, run 3 draft, run 4 final]` through a tiny in-test
   reducer built from `shouldStart`/`shouldAbort`: only run 4 survives to produce a result; runs 1–3 abort.
5. **Worker boundary (source pin)** — `tabs/ForecastTab.tsx` source contains **no** import of
   `lib/netWorthForecast` (only the hook/client); `lib/netWorthForecastClient.ts` contains
   `'./netWorthForecast.worker.ts?worker&inline'`. Guards against a "just call it directly" regression that would
   freeze the main thread.
6. **Single-file build invariant** — `vite.config.ts` still contains `viteSingleFile()` and `format: 'es'` in its
   `worker` block. The inline worker depends on both.
7. **Tab registration lockstep** — parse `TABS` out of `components/TabBar.tsx` and `valid` + the
   `TAB_COMPONENTS` keys out of `App.tsx`; assert all three lists are equal (same members, same order) and each
   contains `'forecast'`. This is the test that makes the three-edit hazard mechanical instead of tribal, and it
   guards every future tab too.
8. **Root-purity pin** — `lib/forecastCore.ts`, `lib/netWorthForecast.ts` and `lib/netWorthForecastProtocol.ts`
   contain no `import.meta`, no `?worker`, and no `from 'react'`. They are in the root tsc program; a browser-only
   import would break `bun run typecheck`.

### 17. `CHANGELOG.md`

Add `## [Unreleased]` above `## [v0.9.1]`, with `### Features` and one bullet in the house style:

`feat: Forecast tab — Monte Carlo net-worth fan chart (p10–p90) with live savings-rate, real-return, horizon and one-off-shock sliders, simulated in a Web Worker (5,000 paths while dragging, 20,000 on release) with a first-class assumptions & limitations panel (#42)`

## Deviations from issue #42 text

Each is deliberate, approved, and recorded here so no one "fixes" it later.

1. **PRNG stays `mulberry32`; xoshiro128\*\* is not adopted.** The issue names xoshiro128\*\*.
   `src/__tests__/cashflow-forecast.test.ts:26-49` pins mulberry32's exact float outputs for seeds 42 and 1, and
   the shipped cash forecast's 21 tests / 2539 assertions must keep passing unchanged (locked decision 2). Swapping
   the PRNG would invalidate those goldens for no modelled benefit: mulberry32's quality is ample for 20,000 × 480
   i.i.d. draws, and the measured Box–Muller output on top of it has mean ≤ 0.002, sd within 0.0012 of 1, skew
   ≤ 0.005 and kurtosis 2.99–3.01 over 1M draws per seed (§14 test 4). Normality comes from **Box–Muller layered
   above** the existing uniform source, which leaves the bootstrap draw path and its RNG consumption untouched.
2. **No `/api/forecast/inputs` endpoint.** The two reads already exist: `GET /api/net-worth` (`server.ts:611`) for
   the starting net worth and `GET /api/cashflow/monthly?months=24` (`server.ts:427`) for contributions. A third
   endpoint would add a route, a wire type, a test surface and a second definition of "what a contribution is" for
   zero new information. `/api/net-worth/trend` is deliberately **not** used to fit returns: snapshots conflate
   contributions with market moves, which is founder decision #2 and assumption 3 in the panel.
3. **Offline degrades rather than working.** The mirror (schema v3) does not carry `accounts`;
   `mirror-fallback.test.ts:97` pins `/api/net-worth` as unmirrored. The tab renders the existing
   `<OfflineUnavailable>` — the precedent `CashflowForecast.tsx:135-137` already set. **`MIRROR_SCHEMA_VERSION` is
   not bumped and no mirror module is edited.** Making the Forecast tab work offline is a separate slice with its
   own schema-version cost.
4. **Windows manual QA is an UNMET acceptance criterion.** The issue's "Done when" demands manual drag QA on Mac
   **and** Windows. What is automated: the deterministic simulation gates (§14), the CI-runnable performance
   ceilings and the allocation/frame-budget proxies on **ubuntu-latest and macos-latest** (§15), and the
   architecture pins that the sim can only run off the main thread (§16 tests 5–6). What is **not** automated: real
   pointer-drag frame pacing in a real browser on Windows. There is no Windows runner and no browser-automation rig
   in this repo (no vitest, no jsdom, no Playwright). The checklist below is left for the owner to run; **this
   spec does not claim the criterion is met.**
5. **Two shock controls, not one.** "One-off shock" needs an amount *and* a timing to be simulatable; the year
   slider is the minimum addition (§10).
6. **A draft run is not a prefix of the final run.** Step-major/path-minor is retained because it is what makes the
   *horizon* slider stable; the cost is that changing `paths` resamples, so bands shift ~0.7 % when the 20,000-path
   result replaces the 5,000-path draft. Surfaced in the UI as "refining…" and in the assumptions panel as
   limitation 6 (§7, §12).

## Out of scope

- **No retirement drawdown phase** (founder decision) — the model contributes for the whole horizon. Called out as
  limitation 1 in the panel.
- **Volatility is not user-settable and not fitted** — fixed at 15% (founder decision).
- **No nominal-dollar mode**, no inflation slider — real dollars only, via the real-return slider.
- **No license/tier gate** (founder decision) and no coupling to the paid-tier deterministic forecast surface
  (`src/tools/query/forecast.ts`, `src/orchestration/chains/cash-flow-forecast.yaml`,
  `src/skills/cash-flow-forecast/SKILL.md`) — not touched.
- **No persistence** of slider or manual-input state: no localStorage, no URL hash, no server round-trip.
- **No change to the shipped Cash Forecast card**, to `MIN_HISTORY_MONTHS = 2`, to `runCashflowForecast`'s
  behaviour, or to `src/__tests__/cashflow-forecast.test.ts`.
- **No new endpoint, no schema change, no mirror change, no `MIRROR_SCHEMA_VERSION` bump, no new npm dependency**
  in either package.
- No per-account or per-asset-class modeling, no goal integration, no correlation between returns and contributions,
  no export of the projection.
- No React component tests — the repo has no vitest/jsdom rig, so the deterministic contract lives in the pure
  engine, protocol and source-pin tests.

## Verification

1. `bun test src/__tests__/cashflow-forecast.test.ts` → must still report **21 pass, 0 fail, 2539 expect() calls**,
   with the file **unmodified** (`git diff --stat src/__tests__/cashflow-forecast.test.ts` must be empty). This is
   the refactor's gate; if it fails, fix the refactor, never the test.
2. `bun test src/__tests__/net-worth-forecast.test.ts src/__tests__/net-worth-forecast-perf.test.ts src/__tests__/net-worth-forecast-protocol.test.ts`, then the full `bun test`.
3. `bun run typecheck` — root tsc; pulls `forecastCore.ts`, `netWorthForecast.ts` and `netWorthForecastProtocol.ts`
   into the root program via the test imports. Any accidental browser-only import surfaces here.
4. `cd src/dashboard/ui && bun install && bun run build` (`tsc -b && vite build`). Confirm the output is still a
   single file: `ls dist/` shows only `index.html` (no `.js` chunk, no `.wasm`) — the inline worker must not emit an
   asset.
5. Manual check — scratch profile, following the #80/#81 pattern (delete the file afterwards). Seed an accounts set
   giving a clear net worth (e.g. checking 4,200 + savings 9,800 + brokerage 185,000 assets, mortgage 240,000 and
   a 900 card as liabilities), plus **8 complete months** of income/expense transactions. `bun scratch-forecast.ts`,
   open <http://localhost:3141#forecast>:
   - Tab bar shows **Forecast** after Goals; `#forecast` in the URL deep-links to it; an unknown hash still falls
     back to Overview.
   - Chart renders 81 quarterly points (20-year default) with widening translucent bands around a solid median.
     Readout quotes the median at the final quarter, the p10–p90 range, and **20,000 simulated paths**.
   - Assumptions & limitations panel is visible below the readout without any interaction.
   - **Drag the return slider continuously.** DevTools → Performance: the main thread shows no long task; the
     readout flips to "refining…" during the drag and settles ~immediately on release with the path count back at
     20,000. DevTools → Network: **no requests** during or after the drag.
   - Drag the horizon slider 20 → 40 → 10: the chart extends and contracts, and **the quarters already on screen
     keep their band values** (horizon prefix-stability, §14 test 11).
   - Set the shock to −$100,000 in year 5: the whole fan steps down at that quarter and never recovers the gap.
   - `Reset` returns every control to its default and the chart to the first-load fan exactly.
   - **Manual mode:** reduce the seeded history to 4 months, restart → the manual-inputs panel appears above the
     chart prefilled from the partial history, the sliders still drive the fan live, and clearing the income field
     disables the savings-rate slider with its hint. Nothing throws.
   - **Offline:** stop the server, reload → the tab shows `Unavailable offline — requires the server`
     (`data-testid="unavailable-offline"`), not a broken chart. Restart → it recovers on the next load.
6. `git diff --stat` sanity: changes confined to `src/dashboard/ui/src/lib/`, `src/dashboard/ui/src/hooks/`,
   `src/dashboard/ui/src/components/` (+ `TabBar.tsx`), `src/dashboard/ui/src/tabs/`,
   `src/dashboard/ui/src/App.tsx`, `src/__tests__/` (three new files, **zero modified**), and `CHANGELOG.md`.
   **Nothing under `src/db/`, `src/dashboard/server.ts`, `src/dashboard/api.ts`, `src/dashboard/ui/src/store/`,
   `src/tools/`, or either `package.json`.**

### Windows manual QA checklist (UNMET — for the owner to run)

Run on Windows 10/11, Chrome/Edge latest, against `wilson --dashboard` with the same scratch profile:

1. Forecast tab opens; chart renders inside 2 s on first paint.
2. Drag each of the four sliders continuously for ≥ 5 s. The chart tracks the thumb with no visible stall and the
   thumb never detaches from the cursor.
3. DevTools → Performance during a drag: no main-thread task longer than 50 ms; the simulation appears on a
   **worker** thread track, not the main one.
4. On release, "refining…" clears and the readout reports 20,000 paths.
5. Keyboard-only: focus a slider, hold an arrow key — the 250 ms settle timer still escalates to a 20,000-path run
   (no `pointerup` fires).
6. A high-DPI display and a 150% OS scale factor do not clip the chart, the control labels, or the assumptions
   panel.
7. Report the results on the PR. **Until that report exists, this acceptance criterion is open.**

## Acceptance criteria mapping

| Issue #42 criterion | Where |
|---|---|
| Forecast **tab** with p10/p25/p50/p75/p90 net-worth bands over a chosen horizon | §8 tab, §9 fan chart, §13 registration; §14 tests 7, 9; §16 test 7 |
| Live sliders: savings-rate delta, real annual return, horizon, one-off shock | §10; §14 tests 12–15, 20 |
| Simulation in a **Web Worker**, plain JS | §5 worker, §6 client, §7 hook; §16 tests 5–6 |
| **5,000** paths while dragging, **20,000** on release | §7 policy, §4 `pathsFor`; §16 tests 1, 4; §15 tests 1–2 |
| **Bucketed quarterly** so Recharts stays fast | §3 `bucketMonths`, §9 (161 points at 40 y); §14 test 9; §15 test 4 |
| **Assumptions & limitations panel** as a first-class deliverable | §12 (always visible, in every state) |
| **Manual-inputs mode** when history < 6 months | §11, §3 `NET_WORTH_MIN_HISTORY_MONTHS`; §14 tests 19–20; Verification 5 |
| **No new dependencies**, **no data leaves the machine** | Out of scope; §8 (no new fetches); Verification 4, 5, 6 |
| Real dollars via a real-return slider; nominal not modeled | §3 model, §10, §12 assumption 1 |
| Return volatility **fixed at 15%**, not fitted from history | §3 `FIXED_ANNUAL_VOLATILITY`; §12 assumptions 2–3; §14 test 20 |
| **No** retirement drawdown in slice one | Out of scope; §12 limitation 1 |
| No license gate; slider state not persisted | Out of scope; §8 |
| Existing cash forecast keeps working, one shared engine | §1–2; Verification 1 (21 pass, file unmodified) |
| Manual drag QA on **Mac** | Verification 5 |
| Manual drag QA on **Windows** | **UNMET** — Windows checklist above; Deviation 4 |
