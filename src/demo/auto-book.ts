import type { Database } from '../db/compat-sqlite.js';

/**
 * Auto-book candidate resolution for the Demo tab's agent trace (issue #94).
 *
 * When the attendee taps "Auto-book this" on a predicted transaction, the UI
 * needs to know WHICH imported row the prediction is about — descriptions and
 * ids are never joined client-side. This module answers that server-side with
 * exact-description matches constrained to the freshly imported rows, so the
 * confirmation card can name the exact transaction it would change.
 *
 * Strictly read-only: the only write in the auto-book flow happens later,
 * inside the WebMCP substrate's commitMutation, after the human approves the
 * confirmation card. This module performs no writes of any kind.
 */

/** One candidate row, as server truth — exactly what the confirmation will name. */
export interface AutoBookCandidate {
  id: number;
  date: string;
  description: string;
  amount: number;
  category: string | null;
}

export type AutoBookCandidatesResult =
  | { ok: true; candidates: AutoBookCandidate[] }
  | { ok: false; error: string };

/** Same bound as the trace chain's row inputs (src/dashboard/api.ts MAX_TRACE_ROWS). */
const MAX_IMPORTED_IDS = 2000;
const CHUNK = 500; // SQLite parameter limit headroom (mirrors statement-trace importStep)

/**
 * Exact-description matches among the given imported rows, sorted by date then
 * id. No fuzzy matching, no global DB search — the semantic is "book THIS
 * statement's row".
 */
export function resolveAutoBookCandidates(
  db: Database,
  params: { description: string; importedIds: number[] }
): AutoBookCandidate[] {
  const wanted = params.description;
  const candidates = new Map<number, AutoBookCandidate>();
  for (let i = 0; i < params.importedIds.length; i += CHUNK) {
    const chunk = params.importedIds.slice(i, i + CHUNK);
    const queryParams: Record<string, unknown> = { description: wanted };
    const placeholders = chunk
      .map((id, j) => {
        queryParams[`id${j}`] = id;
        return `@id${j}`;
      })
      .join(',');
    const rows = db
      .prepare(
        `SELECT id, date, description, amount, category FROM transactions
         WHERE description = @description AND id IN (${placeholders})`
      )
      .all(queryParams) as Array<{ id: number; date: string; description: string; amount: number; category: string | null }>;
    for (const r of rows) candidates.set(r.id, r);
  }
  return [...candidates.values()].sort((a, b) => (a.date === b.date ? a.id - b.id : a.date < b.date ? -1 : 1));
}

/**
 * Validating dispatcher for POST /api/demo/autobook/candidates — mirrors
 * apiDemoTraceStep's validation style: body object, non-empty description,
 * importedIds a non-empty array of integers within bounds. Read-only; the
 * route maps `ok:false` to 400.
 */
export function apiDemoAutoBookCandidates(
  db: Database,
  body: unknown
): AutoBookCandidatesResult {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, error: 'request body must be an object' };
  }
  const b = body as Record<string, unknown>;

  if (typeof b.description !== 'string' || b.description.trim() === '') {
    return { ok: false, error: 'description must be a non-empty string' };
  }
  if (!Array.isArray(b.importedIds) || b.importedIds.length === 0) {
    return { ok: false, error: 'importedIds must be a non-empty array of transaction ids' };
  }
  for (const id of b.importedIds) {
    if (typeof id !== 'number' || !Number.isInteger(id)) {
      return { ok: false, error: 'importedIds must be a non-empty array of transaction ids' };
    }
  }
  if (b.importedIds.length > MAX_IMPORTED_IDS) {
    return { ok: false, error: `importedIds must not exceed ${MAX_IMPORTED_IDS} ids` };
  }

  return {
    ok: true,
    candidates: resolveAutoBookCandidates(db, {
      description: b.description,
      importedIds: b.importedIds as number[],
    }),
  };
}