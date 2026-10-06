/**
 * Pure helpers for the live /categorize progress line. While POST /api/chat
 * runs a /categorize command, GET /api/chat/progress reports how far the run
 * is (src/dashboard/chat.ts); these turn that into the typing-indicator text.
 */

/** Mirrors the server's ToolProgress (src/model/types.ts). */
export interface CategorizeProgressLike {
  done: number;
  total: number;
  batch: number;
  batches: number;
}

export const CATEGORIZE_PROGRESS_POLL_MS = 1500;

/** True for a "/categorize [n]" command (the only chat request that reports progress). */
export function isCategorizeQuery(query: string): boolean {
  return /^\/categorize(\s|$)/i.test(query.trim());
}

/** "Categorizing… 20 of 50 (2 of 5 batches)"; plain "Categorizing…" until a usable report arrives. */
export function categorizeProgressLabel(progress: CategorizeProgressLike | null | undefined): string {
  if (!progress || !(progress.total > 0) || !(progress.batches > 0)) return 'Categorizing…';
  return `Categorizing… ${progress.done} of ${progress.total} (${progress.batch} of ${progress.batches} batch${progress.batches === 1 ? '' : 'es'})`;
}
