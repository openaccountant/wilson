# open-jev latency harness (issue #155)

Reproducible timing for the Review-tab pre-labeler's open-jev decisions. It does not change product
behaviour: it builds the real worker bundle with the repo's own config and drives the real engine.

Question it answers: is the 66-273 ms per-row latency seen in the B1-a live check (spike: 67-86 ms) a
worker-scope penalty, per-decision overhead, shader compile, or just a busy machine?

## Run it on an idle machine

Quit browsers, Creative Cloud, video calls, and anything else using the GPU; plug in AC power; turn off
Low Power Mode. Then, from the repo root (the worktree or release checkout):

```bash
node scripts/openjev-latency/run.mjs --runs 8 --rows 49 --warmup 3 --label idle-$(hostname -s)
```

First ever run downloads ~350 MB of weights into `scripts/openjev-latency/.build/profile` (a "prime" load
that is not measured). Later runs reuse it. Results land in `scripts/openjev-latency/results/<timestamp>-<label>.json`
and a summary prints to the terminal. Takes about 3-5 minutes after the first download.

Needs: `bun install` at the root, `npm ci` in `src/dashboard/ui`, Playwright's Chromium
(`npx playwright install chromium`). Network is used only for the HF weights at the pinned revision.

## What is compared

| mode | what runs |
|---|---|
| `worker` | the production bundle: `src/prelabel/worker.ts` built by `vite.prelabel.config.ts` into `dist-hybrid/prelabel-worker.js`, driven with the real `init`/`probe`/`load`/`run` messages |
| `main` | `createPrelabelEngine` (`worker-core.ts`, the same engine) on the main thread, wired exactly like `worker.ts` (`page.ts`) |

Both use the production pins read from `src/prelabel/config.ts` (q4f16, webgpu, pinned revision,
temperature 1.05) and the static `CATEGORIES` label set. Rows are the spike's synthetic gold set
(`docs/spikes/2026-10-02-open-jev-webgpu/harness/gold/categorize.json`, fabricated merchants), cycled to `--rows`.
No `~/.openaccountant` data is read (the pin import runs with `HOME` pointed at a temp dir).

Runs alternate order (worker first, then main first, ...) so thermal or background drift does not favour a host.
Each run is a fresh engine in a fresh Chromium process (disk caches persist via the profile; use `--reuse-browser`
to keep one process).

## What the numbers mean

- `cold_load_wall_ms` / `cold_load_engine_ms`: `load` message to `loaded` (session creation plus the engine's warm-up decision).
- `first_decision_ms`: the engine's warm-up decision, i.e. shader compile plus first dispatch.
- `steady_state_per_row_decide_ms`: per-row `decide()` time measured inside the host, after `--warmup` discarded rows. This is the number the issue compares (p50/p90/min/max, pooled over all runs).
- `per_run_p50_ms` and `per_run_p50_spread`: each run's median, then min/max/ratio across runs. This is the run-to-run spread the live check saw (66-273 ms).
- `per_row_wall_ms`: whole run wall / rows, measured on the page: decide plus `countTokens`, yield tick and postMessage. A gap to the decide number is host overhead, not GPU time.
- `first_measured_row_ms`: the first row after warm-up, to see whether compile effects outlast `--warmup`.
- `ms_vs_state_tokens_pearson`: whether time tracks input length (shape-dependent kernels).
- `worker_vs_main_p50_ratio`: near 1.0 means no worker-scope penalty.
- `idle_before` / `idle_after`: `ps` top CPU processes, load average, and a verdict (`idle`, `unsure` when GPU-heavy apps such as WindowServer or Chrome helpers are running even at low CPU, `busy`). `machine.power_source`, `low_power_mode` and `thermal` are recorded too. `verdict_hint` says NOT OF RECORD unless the machine was idle before and not busy after. Idle is judged by CPU only; `ps` cannot see GPU load, so `unsure` is a prompt to check Activity Monitor's GPU history.
- `adapter`: vendor/architecture/`isFallbackAdapter`/`shaderF16`. The run refuses to measure on a fallback or software adapter unless `--allow-fallback-adapter`.

## Flags

```
--runs N              runs per mode (default 5)
--rows N              measured rows per run (default 49, the gold set size)
--warmup K            discarded rows scored before measuring (default 3; 0 shows compile cost in the first rows)
--modes worker,main   which hosts (default both)
--recreate            knob: dispose and reload the session before EVERY measured row (per-decision session re-creation)
--reuse-browser       knob: one Chromium for all runs instead of a fresh one per run
--headed              headed Chromium (headless worked for the smoke run on Apple Metal)
--unsafe-webgpu       pass --enable-unsafe-webgpu (the spike's flag, if headless has no adapter)
--allow-fallback-adapter   measure even on a software adapter (labelled, not comparable)
--no-prime            skip the unmeasured priming load
--skip-build          reuse the previous build
--label NAME / --note TEXT / --out FILE / --port N / --profile DIR
```

Suggested sweeps on an idle machine, same label prefix:

```bash
node scripts/openjev-latency/run.mjs --runs 8 --warmup 3 --label idle-baseline
node scripts/openjev-latency/run.mjs --runs 8 --warmup 0 --label idle-nowarmup   # compile effect
node scripts/openjev-latency/run.mjs --runs 3 --rows 20 --modes worker --recreate --label idle-recreate   # session re-creation
```

## Drift

`page.ts` repeats the 25-line dependency wiring of `src/prelabel/worker.ts` for the main-thread host. If
`worker.ts` changes its wiring, update `page.ts`. The worker mode always uses the real bundle.

## Smoke result (checked in, not of record)

`results/smoke-machine-not-idle.json`: 2 runs per mode, 12 rows, 2 warm-up rows, Apple metal-3 (non-fallback, shader-f16),
headless Chromium, machine NOT idle (idle check: busy; WindowServer, Creative Cloud and Chrome helpers running).
Per-row decide p50 was 55.7 ms in both modes (worker 54.8-57.6, main 54.8-56.9), worker/main ratio 1.00,
first decision 113-150 ms, load 1.2-1.4 s from cache. Proves the harness works; it says nothing about #155.
