/**
 * Build entry for the prebuilt hybrid chunk (dist-hybrid/hybrid-chat.js).
 *
 * Served same-origin by the dashboard server at /assets/hybrid-chat.js. The
 * legacy vanilla dashboard loads it via a module script tag; the React
 * ChatTab loads it via a runtime dynamic import (which the @vite-ignore
 * comment keeps out of the singlefile React bundle). transformers.js is
 * bundled ONLY here — never into the singlefile HTML.
 */

import { createHybridChat, type HybridOpts, type HybridChat } from './client.js';
import type { HybridResult } from './core.js';

export interface WilsonHybridChatGlobal {
  /** Configure (call once with the app's base URL before first use). */
  init(opts: HybridOpts): void;
  probe(): Promise<'ready' | 'unavailable' | 'failed'>;
  loadModel(onProgress?: (label: string) => void): Promise<unknown>;
  tryLocal(
    query: string,
    onProgress?: (label: string) => void,
    sessionId?: string | null,
  ): Promise<HybridResult>;
}

let chat: HybridChat | null = null;

function get(): HybridChat {
  chat ??= createHybridChat({ baseUrl: '', fetchImpl: (input, init) => fetch(input, init) });
  return chat;
}

export function init(opts: HybridOpts): void {
  chat = createHybridChat(opts);
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
): Promise<HybridResult> {
  return get().tryLocal(query, onProgress, sessionId);
}

declare global {
  interface Window {
    WilsonHybridChat?: WilsonHybridChatGlobal;
  }
}

if (typeof window !== 'undefined') {
  window.WilsonHybridChat = { init, probe, loadModel, tryLocal };
}