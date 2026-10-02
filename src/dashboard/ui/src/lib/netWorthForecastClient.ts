// ── Browser-only: net-worth forecast client singleton (main thread) ─────────
//
// Owns the inline forecast worker and exposes request/subscribe/dispose to
// the useNetWorthForecast hook. Uses the exact `?worker&inline` form
// mirror-client.ts:11 uses, so viteSingleFile() + worker: { format: 'es' }
// (vite.config.ts) keep producing a single dist/index.html.
//
// This module must never be imported from a root test — it is the only
// module in this slice that needs vite/client (`?worker&inline`) types.

import ForecastWorkerCtor from './netWorthForecast.worker.ts?worker&inline';
import type { NetWorthSimInput } from './netWorthForecast.js';
import type { ForecastQuality, ForecastRequest, ForecastResponse } from './netWorthForecastProtocol.js';

export interface ForecastClient {
  /** Post a run; supersedes anything in flight. Returns the runId issued. */
  request(input: NetWorthSimInput, quality: ForecastQuality): number;
  subscribe(fn: (r: ForecastResponse) => void): () => void;
  dispose(): void;
}

/** Lazily spawns the inline worker on first `request()`. Null if Worker is unavailable. */
export function createForecastClient(): ForecastClient | null {
  if (typeof Worker === 'undefined') return null;

  let worker: Worker | null = null;
  let runId = 0;
  const listeners = new Set<(r: ForecastResponse) => void>();

  function emit(response: ForecastResponse): void {
    for (const fn of listeners) fn(response);
  }

  function ensureWorker(): Worker | null {
    if (worker) return worker;
    let w: Worker;
    try {
      // The constructor itself can throw synchronously — a browser or
      // enterprise policy that blocks Web Workers, a CSP restriction, etc.
      // That must not escape uncaught out of a requestAnimationFrame /
      // setTimeout callback (see hooks/useNetWorthForecast.ts), so it's
      // routed through the same 'error' response the onerror handler below
      // already emits — the hook and ForecastTab need no new contract.
      w = new ForecastWorkerCtor();
    } catch {
      return null;
    }
    w.onmessage = (event: MessageEvent<ForecastResponse>) => emit(event.data);
    w.onerror = () => {
      // A crashed worker fails everything in flight; the UI can fall back
      // (see ForecastTab.tsx) on this error.
      emit({ type: 'error', runId, message: 'forecast worker crashed' });
      w.terminate();
      worker = null;
    };
    worker = w;
    return w;
  }

  return {
    request(input, quality) {
      const id = ++runId;
      const w = ensureWorker();
      if (!w) {
        emit({
          type: 'error',
          runId: id,
          message: 'This browser blocked the Web Worker needed for the forecast.',
        });
        return id;
      }
      const msg: ForecastRequest = { type: 'run', runId: id, input, quality };
      w.postMessage(msg);
      return id;
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    dispose() {
      worker?.terminate();
      worker = null;
      listeners.clear();
    },
  };
}
