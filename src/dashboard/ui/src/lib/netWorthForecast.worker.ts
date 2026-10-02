// ── Browser-only: the net-worth forecast worker ──────────────────────────────
//
// Dedicated worker that drives simulateNetWorth() in chunks, off the main
// thread, so a 20,000-path final run never freezes the UI. Bundled with
// `?worker&inline` (see netWorthForecastClient.ts) so it lives inside the
// single-file build, same as store/mirror-worker.ts.
//
// Message protocol: see netWorthForecastProtocol.ts (ForecastRequest /
// ForecastResponse). Unlike the mirror worker there is NO promise chain
// serializing dispatch: superseding an in-flight run is the whole point, so
// 'run' / 'cancel' messages are processed as they arrive, never queued behind
// whatever is currently running.

import { simulateNetWorth } from './netWorthForecast.js';
import type { NetWorthSimInput } from './netWorthForecast.js';
import { pathsFor, shouldAbort, shouldStart } from './netWorthForecastProtocol.js';
import type { ForecastQuality, ForecastRequest, ForecastResponse } from './netWorthForecastProtocol.js';

let activeRunId = 0;

async function run(runId: number, input: NetWorthSimInput, quality: ForecastQuality): Promise<void> {
  const t0 = performance.now();
  try {
    const gen = simulateNetWorth({ ...input, paths: pathsFor(quality) });
    let next = gen.next();
    while (!next.done) {
      if (shouldAbort(runId, activeRunId)) {
        gen.return(null); // release the Float64Array immediately
        ctx.postMessage({ type: 'cancelled', runId } satisfies ForecastResponse);
        return;
      }
      ctx.postMessage({ type: 'progress', runId, fraction: next.value } satisfies ForecastResponse);
      // A macrotask, NOT a microtask: only a task boundary lets the worker's
      // message queue deliver a newer 'run' while this one is mid-flight —
      // an await on a resolved promise alone would never yield to postMessage.
      await new Promise((resolve) => setTimeout(resolve, 0));
      next = gen.next();
    }
    if (shouldAbort(runId, activeRunId)) {
      ctx.postMessage({ type: 'cancelled', runId } satisfies ForecastResponse);
      return;
    }
    ctx.postMessage({
      type: 'result',
      runId,
      quality,
      forecast: next.value,
      elapsedMs: performance.now() - t0,
    } satisfies ForecastResponse);
  } catch (err) {
    // The worker never dies on a bad input; the caller sees an 'error' reply.
    ctx.postMessage({
      type: 'error',
      runId,
      message: err instanceof Error ? err.message : String(err),
    } satisfies ForecastResponse);
  }
}

// Minimal worker-scope shape: DedicatedWorkerGlobalScope lives in
// lib.webworker.d.ts, which the UI tsconfig does not include (mirrors
// store/mirror-worker.ts's WorkerScope shim).
interface WorkerScope {
  postMessage(message: unknown): void;
  onmessage: ((event: MessageEvent<ForecastRequest>) => void) | null;
}

const ctx = self as unknown as WorkerScope;

ctx.onmessage = (event) => {
  const msg = event.data;
  if (msg.type === 'cancel') {
    // Bump past the cancelled id so its in-flight loop aborts at the next
    // chunk boundary, and a same-id replay can never restart it.
    activeRunId = msg.runId + 1;
    return;
  }
  if (!shouldStart(msg.runId, activeRunId)) return; // stale/duplicate 'run': drop it
  activeRunId = msg.runId;
  // Deliberately not awaited: the handler must return immediately so the
  // message queue keeps draining and can deliver a newer 'run' while this one
  // is mid-flight (that delivery is what lets shouldAbort ever observe it).
  void run(msg.runId, msg.input, msg.quality);
};
