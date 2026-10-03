import { useCallback, useEffect, useRef, useState } from 'react';
import { authedFetch, getBaseUrl } from '@/api';
import type { HybridResult } from '@/hybrid/core';
import type { PriorLocalTurn } from '@/hybrid/worker-protocol';
import type {
  WilsonHybridChatGlobal,
  CategorizeSampleResult,
  CategorizeSampleOpts,
} from '@/hybrid/standalone';
import {
  fetchActiveMirrorProfile,
  getMirrorState,
  openToolPort,
  syncMirror,
} from '@/store/mirror-client';
import { mirrorStatusViaPort, prepareMirrorForRun } from '@/store/mirror-subagent';
import { chooseToolWithHost } from '@/openjev/choose-tool';
import { getOpenJevHost } from '@/openjev/instance';

/**
 * React binding for the prebuilt hybrid chat chunk (/assets/hybrid-chat.js).
 *
 * The chunk (and transformers.js inside it) is loaded at runtime via a
 * dynamic import of a variable URL — the inline @vite-ignore comment keeps it
 * OUT of the singlefile React bundle. A missing chunk (hybrid build not
 * present) resolves to null → "unavailable", never a throw: the caller falls
 * back to the server path silently.
 */

type ChunkStatus = 'unknown' | 'available' | 'unavailable';

let chunkPromise: Promise<WilsonHybridChatGlobal | null> | null = null;

/** Per-turn options ChatTab passes to tryLocal (the browser subagent). */
export interface TryLocalExtras {
  /** Turns answered on-device earlier in this session, most recent last. */
  priorLocalTurns?: PriorLocalTurn[];
}

/**
 * Dev-only: `localStorage['wilson-subagent-debug']==='1'` exposes
 * `window.__wilsonDebug.mirrorStatus()`, which opens a tool port and sends
 * `status` (live-Chrome verification, specs/browser-subagent.md section 14).
 */
function installDebugHelper(): void {
  try {
    if (localStorage.getItem('wilson-subagent-debug') !== '1') return;
    const w = window as unknown as { __wilsonDebug?: Record<string, unknown> };
    w.__wilsonDebug = {
      ...(w.__wilsonDebug ?? {}),
      mirrorStatus: () => mirrorStatusViaPort(() => openToolPort()),
    };
  } catch {
    // storage unavailable: no debug helper, nothing else changes
  }
}

function loadHybridChunk(baseUrl: string): Promise<WilsonHybridChatGlobal | null> {
  chunkPromise ??= (async () => {
    try {
      const mod = (await import(/* @vite-ignore */ `${baseUrl}/assets/hybrid-chat.js`)) as {
        WilsonHybridChat?: WilsonHybridChatGlobal;
      };
      return mod?.WilsonHybridChat ?? window.WilsonHybridChat ?? null;
    } catch {
      // 404 (hybrid not built) or a load error → capability-unavailable.
      return null;
    }
  })();
  return chunkPromise;
}

export interface UseHybridChatResult {
  /** Local-first attempt; resolves {ok:false} on any hybrid failure. */
  tryLocal(
    query: string,
    onProgress?: (label: string) => void,
    sessionId?: string | null,
    extras?: TryLocalExtras,
  ): Promise<HybridResult>;
  /** Speed Showdown browser arm; resolves {ok:false, reason:'unavailable'} without a chunk. */
  categorizeSample(opts: CategorizeSampleOpts): Promise<CategorizeSampleResult>;
  /** Whether the hybrid chunk itself is loadable (not GPU capability). */
  status: ChunkStatus;
  /**
   * Always-current `status`, readable inside send closures where the React
   * `status` state can be stale. Updated the moment the chunk load resolves.
   */
  getStatus(): ChunkStatus;
}

export function useHybridChat(): UseHybridChatResult {
  const [status, setStatus] = useState<ChunkStatus>('unknown');
  // Ref mirror of `status`: React state is stale inside handleSend closures,
  // so provenance derivation must read the ref via getStatus() instead.
  const statusRef = useRef<ChunkStatus>('unknown');
  // The chunk is configured exactly once per loaded instance — init() replaces
  // the internal client, which would drop an already-loaded model.
  const initedRef = useRef<WilsonHybridChatGlobal | null>(null);

  const ensure = useCallback(async (): Promise<WilsonHybridChatGlobal | null> => {
    const base = getBaseUrl();
    const hybrid = await loadHybridChunk(base);
    if (hybrid && initedRef.current !== hybrid) {
      hybrid.init({ baseUrl: base, fetchImpl: authedFetch });
      initedRef.current = hybrid;
    }
    // Keep the ref accurate the moment any tryLocal resolves, independent of
    // re-renders.
    statusRef.current = hybrid ? 'available' : 'unavailable';
    return hybrid;
  }, []);

  useEffect(() => {
    installDebugHelper();
    let alive = true;
    void ensure().then((hybrid) => {
      if (alive) setStatus(hybrid ? 'available' : 'unavailable');
    });
    return () => {
      alive = false;
    };
  }, [ensure]);

  const tryLocal = useCallback(
    async (
      query: string,
      onProgress?: (label: string) => void,
      sessionId?: string | null,
      extras?: TryLocalExtras,
    ): Promise<HybridResult> => {
      const hybrid = await ensure();
      if (!hybrid) return { ok: false };
      // The mirror half of the browser subagent. Only invoked by the hybrid
      // chunk after the gate passed and only when the server enabled the flag,
      // so with the flag off nothing here ever runs.
      return hybrid.tryLocal(query, onProgress, sessionId, {
        subagent: {
          priorLocalTurns: extras?.priorLocalTurns ?? [],
          prepareMirror: () =>
            prepareMirrorForRun({
              getState: getMirrorState,
              syncMirror,
              fetchActiveProfile: fetchActiveMirrorProfile,
              openToolPort,
              now: () => Date.now(),
            }),
          // Round 4: the open-jev tiebreak. The hybrid chunk calls this only for a 0 / 2+ keyword-hit
          // question, with the server flag on and the cut frozen. It never prompts, downloads or waits.
          chooseTool: (req) => chooseToolWithHost(getOpenJevHost(), req),
        },
      });
    },
    [ensure],
  );

  const categorizeSample = useCallback(
    async (opts: CategorizeSampleOpts): Promise<CategorizeSampleResult> => {
      const hybrid = await ensure();
      if (!hybrid) {
        return {
          ok: false,
          model: '',
          raw: '',
          decision: null,
          decisionMs: 0,
          loadMs: 0,
          loadFresh: false,
          reason: 'unavailable',
        };
      }
      return hybrid.categorizeSample(opts);
    },
    [ensure],
  );

  const getStatus = useCallback((): ChunkStatus => statusRef.current, []);

  return { tryLocal, categorizeSample, status, getStatus };
}