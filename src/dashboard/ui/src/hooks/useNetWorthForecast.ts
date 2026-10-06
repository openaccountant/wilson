import { useCallback, useEffect, useRef, useState } from 'react';
import { createForecastClient, type ForecastClient } from '@/lib/netWorthForecastClient';
import type { NetWorthForecast, NetWorthSimInput } from '@/lib/netWorthForecast';
import type { ForecastQuality, ForecastResponse } from '@/lib/netWorthForecastProtocol';

// Keyboard/assistive-tech users arrow an <input type="range"> and never fire
// pointerup, so onInputChange alone must eventually escalate to a 'final'
// (20,000-path) run on its own.
const SETTLE_MS = 250;

export interface UseNetWorthForecast {
  forecast: NetWorthForecast | null; // last completed result of EITHER quality
  /** The input the run behind `forecast` was posted with, so a caller can tell a result for the current input from a stale one. */
  forecastInput: NetWorthSimInput | null;
  quality: ForecastQuality | null; // quality of `forecast`
  refining: boolean; // a 'final' run is in flight over a shown 'draft'
  progress: number; // 0..1 of the in-flight run
  error: string | null;
  /** Call on every slider onChange. */
  onInputChange(input: NetWorthSimInput): void;
  /** Call on pointerup / keyup / blur — escalates to 20,000 paths. */
  onInputSettled(input: NetWorthSimInput): void;
}

const REMEMBERED_RUNS = 8;

function rememberRun(map: Map<number, NetWorthSimInput>, runId: number, input: NetWorthSimInput): void {
  map.set(runId, input);
  while (map.size > REMEMBERED_RUNS) map.delete(map.keys().next().value as number);
}

/**
 * Drives the net-worth forecast worker with a two-tier quality policy: a
 * coalesced 5,000-path 'draft' run per animation frame while dragging, and a
 * 20,000-path 'final' run on release (pointerup/keyup/blur) OR after 250ms of
 * no further input (the keyboard/assistive-tech path).
 *
 * Honesty note: a draft and a final are DIFFERENT samples, not a prefix of
 * one another — step-major/path-minor sampling means path `p` at step `t`
 * consumes a different slice of the RNG stream when `paths` changes. Bands
 * therefore shift slightly (measured: ~0.7% on the p50 at 20 years) when the
 * final lands. That's sampling error, and the readout quotes the final
 * numbers; the tradeoff is deliberate (see netWorthForecast.ts's docs on
 * step-major ordering for why).
 */
export function useNetWorthForecast(): UseNetWorthForecast {
  const clientRef = useRef<ForecastClient | null>(null);
  if (clientRef.current === null) {
    clientRef.current = createForecastClient();
  }

  const rafRef = useRef<number | null>(null);
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestInputRef = useRef<NetWorthSimInput | null>(null);
  const newestRunIdRef = useRef(0);
  const finalRunIdRef = useRef<number | null>(null);
  // runId -> the input it was posted with (a few recent runs), so each result can be matched to its input.
  const inputsByRunRef = useRef(new Map<number, NetWorthSimInput>());

  const [forecast, setForecast] = useState<NetWorthForecast | null>(null);
  const [forecastInput, setForecastInput] = useState<NetWorthSimInput | null>(null);
  const [quality, setQuality] = useState<ForecastQuality | null>(null);
  const [refining, setRefining] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const client = clientRef.current;
    if (!client) {
      setError('Forecast worker unavailable in this browser.');
      return;
    }
    return client.subscribe((response: ForecastResponse) => {
      // Belt and braces: a result/progress/cancelled/error for a runId older
      // than the newest one issued is stale (out-of-order worker delivery)
      // and is ignored on the main thread too.
      if (response.runId < newestRunIdRef.current) return;
      switch (response.type) {
        case 'progress':
          setProgress(response.fraction);
          break;
        case 'result':
          setForecast(response.forecast);
          setForecastInput(inputsByRunRef.current.get(response.runId) ?? null);
          setQuality(response.quality);
          setProgress(1);
          setError(null);
          if (finalRunIdRef.current === response.runId) setRefining(false);
          break;
        case 'cancelled':
          break;
        case 'error':
          setError(response.message);
          setRefining(false);
          break;
      }
    });
  }, []);

  useEffect(() => {
    return () => {
      // Null the refs, not just cancel: postDraft is the ONLY other place
      // that clears rafRef, and cancelling it is precisely what stops
      // postDraft from ever running. Leaving the dead handle behind makes
      // the `rafRef.current == null` guard in onInputChange permanently
      // false for this component instance, which kills the whole draft tier
      // after <StrictMode>'s dev-only mount/unmount/remount (main.tsx).
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      if (settleTimerRef.current != null) clearTimeout(settleTimerRef.current);
      settleTimerRef.current = null;
      clientRef.current?.dispose();
    };
  }, []);

  const postDraft = useCallback(() => {
    rafRef.current = null;
    const client = clientRef.current;
    const input = latestInputRef.current;
    if (!client || !input) return;
    // A newer draft supersedes any 'final' still refining over the previous
    // draft: what's about to render is neither the old draft nor its final.
    setRefining(false);
    setProgress(0);
    newestRunIdRef.current = client.request(input, 'draft');
    rememberRun(inputsByRunRef.current, newestRunIdRef.current, input);
  }, []);

  const onInputSettled = useCallback((input: NetWorthSimInput) => {
    latestInputRef.current = input;
    // Drop any draft still armed for the next vsync FIRST. A release that
    // lands inside the same frame as the last `input` event (releasing
    // mid-motion) would otherwise let that stale postDraft run *after* this
    // final is posted: it would issue a newer runId, the worker would
    // supersede the 20,000-path final with a 5,000-path draft, and — because
    // postDraft arms no settle timer and the tab's effect sees an unchanged
    // input — nothing would ever escalate again.
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    if (settleTimerRef.current != null) {
      clearTimeout(settleTimerRef.current);
      settleTimerRef.current = null;
    }
    const client = clientRef.current;
    if (!client) return;
    const id = client.request(input, 'final');
    rememberRun(inputsByRunRef.current, id, input);
    newestRunIdRef.current = id;
    finalRunIdRef.current = id;
    setProgress(0);
    setRefining(true);
  }, []);

  const onInputChange = useCallback(
    (input: NetWorthSimInput) => {
      latestInputRef.current = input;
      // Coalesce to one 'draft' post per frame: a fast drag fires onChange far
      // more often than the worker (or the eye) can use; superseding in the
      // worker handles whatever still slips through.
      if (rafRef.current == null) {
        rafRef.current = requestAnimationFrame(postDraft);
      }
      // Re-arm the settle timer on every change; it only fires once input
      // stops for SETTLE_MS, which is exactly the keyboard/AT release signal.
      if (settleTimerRef.current != null) clearTimeout(settleTimerRef.current);
      settleTimerRef.current = setTimeout(() => {
        settleTimerRef.current = null;
        const latest = latestInputRef.current;
        if (latest) onInputSettled(latest);
      }, SETTLE_MS);
    },
    [postDraft, onInputSettled],
  );

  return { forecast, forecastInput, quality, refining, progress, error, onInputChange, onInputSettled };
}
