/**
 * Build entry for the prebuilt hybrid chunk (dist-hybrid/hybrid-chat.js).
 *
 * Served same-origin by the dashboard server at /assets/hybrid-chat.js. The
 * legacy vanilla dashboard loads it via a module script tag; the React
 * ChatTab loads it via a runtime dynamic import (which the @vite-ignore
 * comment keeps out of the singlefile React bundle). transformers.js is
 * bundled ONLY here — never into the singlefile HTML.
 *
 * The model itself runs in a Web Worker: model.worker.ts is imported with
 * `?worker&inline`, so transformers.js + ORT are inlined into this chunk as a
 * blob module worker and the main-thread part of the chunk imports neither.
 * The import lives here (not in client.ts) so client.ts stays importable under
 * bun test, which cannot resolve `?worker&inline`.
 */

import ModelWorkerCtor from './model.worker.ts?worker&inline';
import { createHybridChat, type HybridOpts, type HybridChat, type TryLocalOpts, type WorkerLike } from './client.js';
import type { HybridResult } from './core.js';
import type { CategorizeSampleResult, CategorizeSampleOpts } from './client.js';

export type { CategorizeSampleResult, CategorizeSampleOpts, TryLocalOpts, SubagentTurnOpts } from './client.js';

export interface WilsonHybridChatGlobal {
  /** Configure (call once with the app's base URL before first use). */
  init(opts: HybridOpts): void;
  probe(): Promise<'ready' | 'unavailable' | 'failed'>;
  loadModel(onProgress?: (label: string) => void): Promise<unknown>;
  tryLocal(
    query: string,
    onProgress?: (label: string) => void,
    sessionId?: string | null,
    opts?: TryLocalOpts,
  ): Promise<HybridResult>;
  /** Speed Showdown browser arm: single-row categorization on the GPU. */
  categorizeSample(opts: CategorizeSampleOpts): Promise<CategorizeSampleResult>;
}

/** The inlined model worker. The constructor can throw (CSP, policy); the backend treats that as unavailable. */
const createModelWorker = (): WorkerLike => new ModelWorkerCtor({ name: 'wilson-model' }) as unknown as WorkerLike;

let chat: HybridChat | null = null;

function get(): HybridChat {
  chat ??= createHybridChat({
    baseUrl: '',
    fetchImpl: (input, init) => fetch(input, init),
    createWorker: createModelWorker,
  });
  return chat;
}

export function init(opts: HybridOpts): void {
  // Replacing the client must not leak its worker (and the model in GPU memory).
  chat?.dispose();
  chat = createHybridChat({ createWorker: createModelWorker, ...opts });
}

export function probe(): Promise<'ready' | 'unavailable' | 'failed'> {
  return get().probe();
}

export function loadModel(onProgress?: (label: string) => void): Promise<unknown> {
  return get().loadModel(onProgress);
}

export function tryLocal(
  query: string,
  onProgress?: (label: string) => void,
  sessionId?: string | null,
  opts?: TryLocalOpts,
): Promise<HybridResult> {
  return get().tryLocal(query, onProgress, sessionId, opts);
}

export function categorizeSample(opts: CategorizeSampleOpts): Promise<CategorizeSampleResult> {
  return get().categorizeSample(opts);
}

declare global {
  interface Window {
    WilsonHybridChat?: WilsonHybridChatGlobal;
  }
}

if (typeof window !== 'undefined') {
  window.WilsonHybridChat = { init, probe, loadModel, tryLocal, categorizeSample };
}