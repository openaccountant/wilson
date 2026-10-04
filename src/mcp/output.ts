/**
 * Output and input hygiene for the WebMCP tool surface (threat model T09,
 * T10, T11, T20, T32).
 *
 * Everything an agent reads from Wilson is attacker-influenced text (bank
 * descriptions, memos, custom category names), and everything an agent writes
 * must render on a confirmation card exactly as it is stored. So:
 *  - input: string arguments containing control, bidi or zero-width
 *    characters are rejected (`hasHiddenChars`);
 *  - output: untrusted text is stripped of those characters, PII-masked and
 *    truncated (`sanitizeUntrustedText`), and every read result is bounded
 *    and paged (`capOutput`).
 */
import { createHash } from 'node:crypto';

// Hidden characters, PII masking and `sanitizeUntrustedText` live in ./text-hygiene.ts (import-free, so the
// dashboard's browser bundles can use the same rules). They are re-exported here: callers keep importing from output.ts.
import { hasHiddenChars, stripHiddenChars, maskPii, sanitizeUntrustedText, safeCategoryLabel, isSafeCategoryName, UNTRUSTED_NOTE } from './text-hygiene.js';
export { hasHiddenChars, stripHiddenChars, maskPii, sanitizeUntrustedText, safeCategoryLabel, isSafeCategoryName, UNTRUSTED_NOTE };

// ── Cursors ──────────────────────────────────────────────────────────────────

export class CursorError extends Error {
  constructor(message = 'cursor does not match these arguments — restart without cursor') {
    super(message);
  }
}

export interface DecodedCursor {
  o: number;
  h: string;
}

export function encodeCursor(offset: number, hash: string): string {
  return Buffer.from(JSON.stringify({ o: offset, h: hash }), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): DecodedCursor {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Partial<DecodedCursor>;
    if (typeof parsed.o !== 'number' || !Number.isInteger(parsed.o) || parsed.o < 0 || typeof parsed.h !== 'string') {
      throw new Error('shape');
    }
    return { o: parsed.o, h: parsed.h };
  } catch {
    throw new CursorError('cursor is not valid — restart without cursor');
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** Short hash of the call's arguments, minus `cursor` and `limit`. A cursor is only valid for the arguments that produced it. */
export function argsHash(args: Record<string, unknown>): string {
  const { cursor: _cursor, limit: _limit, ...rest } = args;
  return createHash('sha256').update(canonicalJson(rest)).digest('hex').slice(0, 12);
}

/** Stable JSON used for audit previews and idempotent comparisons. */
export function canonicalArgs(args: unknown): string {
  return canonicalJson(args);
}

/** Zero-based page number a cursor points at, or 0. Does not verify the hash (executeRead already did). */
export function pageIndexOf(args: Record<string, unknown>, defaultLimit: number): number {
  if (typeof args.cursor !== 'string') return 0;
  try {
    const limit = typeof args.limit === 'number' && args.limit > 0 ? args.limit : defaultLimit;
    return Math.floor(decodeCursor(args.cursor).o / limit);
  } catch {
    return 0;
  }
}

// ── Output cap ───────────────────────────────────────────────────────────────

export const DEFAULT_OUTPUT_CAP = 1500;

export interface CapOptions<T> {
  /** Max serialized characters of the envelope. Default 1500. */
  cap?: number;
  /** Rows requested per page (already validated 1..25). */
  limit: number;
  cursor?: string;
  /** `argsHash(args)` of the call; a cursor from a different call is rejected. */
  argsHash: string;
  /** Row projection (compact fields, sanitized text). */
  project?: (item: T) => unknown;
  /** Extra top-level fields (kept in every page). */
  extra?: Record<string, unknown>;
  note?: string;
}

export interface CappedOutput {
  body: {
    items: unknown[];
    total: number;
    nextCursor?: string;
    truncated: boolean;
    note: string;
    [key: string]: unknown;
  };
  /** Rows actually returned, for the daily read budget. */
  rows: number;
}

/**
 * Page `items` from the cursor, project each row, and shrink the page until
 * the serialized envelope fits the cap. `nextCursor` always points at the first
 * row NOT returned, so a client that follows it never skips or repeats a row.
 */
export function capOutput<T>(items: T[], opts: CapOptions<T>): CappedOutput {
  const cap = opts.cap ?? DEFAULT_OUTPUT_CAP;
  const total = items.length;
  let offset = 0;
  if (opts.cursor !== undefined) {
    const decoded = decodeCursor(opts.cursor);
    if (decoded.h !== opts.argsHash) throw new CursorError();
    offset = decoded.o;
  }

  const project = opts.project ?? ((item: T) => item as unknown);
  const window = items.slice(offset, offset + opts.limit).map(project);

  const build = (count: number) => {
    const next = offset + count;
    const hasMore = next < total;
    return {
      items: window.slice(0, count),
      total,
      ...(hasMore ? { nextCursor: encodeCursor(next, opts.argsHash) } : {}),
      truncated: hasMore,
      note: opts.note ?? UNTRUSTED_NOTE,
      ...(opts.extra ?? {}),
    };
  };

  let count = window.length;
  let body = build(count);
  while (count > 0 && JSON.stringify(body).length > cap) {
    count -= 1;
    body = build(count);
  }
  return { body, rows: count };
}
