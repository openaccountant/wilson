import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { api, getBaseUrl } from '@/api';
import type { PrelabelConfig, ReviewQueueItem } from '@/types';
import type { PrelabelItem, PrelabelResult } from './protocol';
import { createPrelabelController, type MeasureOutcome, type WorkerLike } from './controller';
import type { KeyValueStorage, LockManagerLike, PanelState } from './session';

export type { MeasureOutcome } from './controller';

function safeStorage(kind: 'session' | 'local'): KeyValueStorage | null {
  try {
    return kind === 'session' ? window.sessionStorage : window.localStorage;
  } catch {
    return null;
  }
}

export interface UsePrelabelResult {
  state: PanelState;
  config: PrelabelConfig | null;
  /** Scores by transaction id (this tab, this profile, this label set). */
  results: Map<number, PrelabelResult>;
  /** Pending rows with no score yet. */
  unscoredCount: number;
  marginCut: number;
  /** Median decision time of the last finished run, ms. */
  p50Ms: number | null;
  /** Click handler of the consent panel: download once, then load. */
  consent(): void;
  cancel(): void;
  /** Score the pending rows that have no score (re-spawns the worker if it idled out). */
  scoreUnscored(): void;
  retry(): void;
  /** Admin: flip `prelabelEnabled` on, then reload. Never rejects: a failure sets `turnOnError`. */
  turnOn(): Promise<void>;
  /** Why the last `turnOn()` failed (plain language), or null. */
  turnOnError: string | null;
  /** True while a `turnOn()` request is in flight. */
  turnOnBusy: boolean;
  /**
   * Score arbitrary items without touching the pending-row scores (measurement
   * panel). Null when the model is not ready or another run is active.
   */
  measure(items: PrelabelItem[]): Promise<MeasureOutcome | null>;
}

/**
 * Thin React binding. The worker / Web Lock / idle / profile wiring lives in
 * controller.ts and the rules in session.ts (both bun-tested): this only creates
 * the controller for the tab, feeds it the review rows and re-renders on change.
 */
export function usePrelabel(reviews: readonly ReviewQueueItem[]): UsePrelabelResult {
  const [controller] = useState(() =>
    createPrelabelController({
      api,
      baseUrl: getBaseUrl,
      createWorker: (url) => new Worker(url, { type: 'module' }) as unknown as WorkerLike,
      locks: (navigator as unknown as { locks?: LockManagerLike }).locks,
      storage: safeStorage,
      now: () => Date.now(),
      timers: { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) },
      reload: () => window.location.reload(),
      visibility: {
        isVisible: () => document.visibilityState === 'visible',
        subscribe: (fn) => {
          document.addEventListener('visibilitychange', fn);
          return () => document.removeEventListener('visibilitychange', fn);
        },
      },
    }),
  );

  // Mount: config -> probe worker. No Web Lock until the user consents.
  useEffect(() => {
    controller.start();
    return () => controller.stop();
  }, [controller]);

  useEffect(() => {
    controller.setReviews(reviews);
  }, [controller, reviews]);

  const snap = useSyncExternalStore(controller.subscribe, controller.getSnapshot);

  return useMemo(
    () => ({
      state: snap.state,
      config: snap.config,
      results: snap.results,
      unscoredCount: snap.unscoredCount,
      marginCut: snap.marginCut,
      p50Ms: snap.p50Ms,
      consent: controller.consent,
      cancel: controller.cancel,
      scoreUnscored: controller.scoreUnscored,
      retry: controller.retry,
      turnOn: controller.turnOn,
      turnOnError: snap.turnOnError,
      turnOnBusy: snap.turnOnBusy,
      measure: controller.measure,
    }),
    [controller, snap],
  );
}
