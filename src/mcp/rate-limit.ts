/**
 * In-memory rate limits and the daily read budget for agent tool calls
 * (threat model T11, T15). Token buckets with an injectable clock so tests
 * never sleep.
 *
 * Every limit that matters is also keyed per USER (`user_id ?? 'anon'`), not
 * just per principal: the client chooses its `sessionGeneration`, so a script
 * could otherwise rotate it to get a fresh per-principal bucket for every
 * call. State lives in memory and resets on restart, which is acceptable for
 * a local dashboard. One limiter per profile database (see `limiterFor`).
 */
import type { Database } from '../db/compat-sqlite.js';

export type RateDecision = { ok: true } | { ok: false; retryAfterSec: number };

/** `limit` tokens refill per `windowMs`. `burst` (default `limit`) caps how many can be spent back to back. */
export interface LimitSpec {
  limit: number;
  windowMs: number;
  burst?: number;
}

/** Principal x tool, read calls: 20 per 60 s, at most 5 back to back. */
export const LIMIT_PRINCIPAL_TOOL: LimitSpec = { limit: 20, windowMs: 60_000, burst: 5 };
/** Principal, every call: 60 per 60 s. */
export const LIMIT_PRINCIPAL_ALL = { limit: 60, windowMs: 60_000 };
/** Principal, prepares: 10 per 60 s. */
export const LIMIT_PRINCIPAL_PREPARES = { limit: 10, windowMs: 60_000 };
/** User, reads across all principals: 120 per 60 s. */
export const LIMIT_USER_READS = { limit: 120, windowMs: 60_000 };
/** User, prepares across all principals: 20 per 60 s. */
export const LIMIT_USER_PREPARES = { limit: 20, windowMs: 60_000 };
/**
 * `propose_judgements` and `judge_interaction` together, per user (so rotating a session id gains nothing):
 * 6 calls per 60 s. Each call carries at most 20 items; the daily item cap is `judgeDailyLimit` (Settings).
 */
export const LIMIT_USER_JUDGE_CALLS = { limit: 6, windowMs: 60_000 };
/** `POST /api/mcp/grants` per user: 20 per 60 s. */
export const LIMIT_GRANTS_POST = { limit: 20, windowMs: 60_000 };
/** Client-token mint and rotate, per user: 5 per hour. */
export const LIMIT_CLIENT_TOKEN_MINT = { limit: 5, windowMs: 3_600_000 };
/** `/mcp` requests with a missing or invalid bearer, per remote address: 10 per 60 s. Only failures spend from it. */
export const LIMIT_MCP_FAILED_BEARER = { limit: 10, windowMs: 60_000 };
/**
 * `/mcp` calls refused before any handler ran (bad arguments, a tool the token does not hold), per token
 * (keyed on its hash): 20 per 60 s, 10 back to back. Only refusals spend from it, so a valid token's own
 * flood is bounded without touching any other client; once it is empty that token gets a 429.
 */
export const LIMIT_MCP_REFUSED_CALLS: LimitSpec = { limit: 20, windowMs: 60_000, burst: 10 };
/** `GET /api/mcp/audit` per user: 30 per 60 s. */
export const LIMIT_AUDIT_GET = { limit: 30, windowMs: 60_000 };

/** Concurrent pending approvals: per principal, and per user across principals. */
export const MAX_PENDING_PER_PRINCIPAL = 3;
export const MAX_PENDING_PER_USER = 5;
/** New session generations that may receive grants per user per hour. */
export const MAX_NEW_SESSIONS_PER_HOUR = 10;

/** Daily read budget per user, per UTC day, across every read tool. */
export const DAILY_READ_ROWS = 2_000;
export const DAILY_READ_CHARS = 300_000;

/** One principal following more than this many distinct cursors of one query is flagged (`deep_paging` sentinel). */
export const DEEP_PAGING_PAGES = 20;
const MAX_PAGING_KEYS_PER_PRINCIPAL = 50;
const MAX_TRACKED_CURSORS = 1_000;

interface Bucket {
  tokens: number;
  updatedAt: number;
}

interface Budget {
  rows: number;
  chars: number;
}

export class RateLimiter {
  private readonly now: () => number;
  private readonly buckets = new Map<string, Bucket>();
  private readonly budgets = new Map<string, Budget>();
  /** Reads in flight (see `reserveRead`), by the same user-and-day key as `budgets`. */
  private readonly reserved = new Map<string, Budget>();
  private readonly pages = new Map<string, Set<string>>();
  private readonly flaggedPaging = new Set<string>();

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? Date.now;
  }

  /**
   * Take one token from the bucket `key`. A bucket holds `limit` tokens and
   * refills continuously at `limit` per `windowMs`, so `limit` calls can go
   * through back to back and the next one waits for a token.
   */
  take(key: string, { limit, windowMs, burst }: LimitSpec): RateDecision {
    const now = this.now();
    this.prune(now);
    const capacity = Math.min(limit, burst ?? limit);
    const bucket = this.buckets.get(key) ?? { tokens: capacity, updatedAt: now };
    const refill = ((now - bucket.updatedAt) / windowMs) * limit;
    bucket.tokens = Math.min(capacity, bucket.tokens + Math.max(0, refill));
    bucket.updatedAt = now;
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      this.buckets.set(key, bucket);
      return { ok: true };
    }
    this.buckets.set(key, bucket);
    const msPerToken = windowMs / limit;
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil(((1 - bucket.tokens) * msPerToken) / 1000)) };
  }

  /** Whether `take(key, spec)` would be refused right now, without spending a token. */
  blocked(key: string, { limit, windowMs, burst }: LimitSpec): boolean {
    const bucket = this.buckets.get(key);
    if (!bucket) return false;
    const capacity = Math.min(limit, burst ?? limit);
    const refill = ((this.now() - bucket.updatedAt) / windowMs) * limit;
    return Math.min(capacity, bucket.tokens + Math.max(0, refill)) < 1;
  }

  /** Drop buckets idle for over an hour so a flood of random principals cannot grow the map without bound. */
  private prune(now: number): void {
    if (this.buckets.size < 2_000) return;
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.updatedAt > 3_600_000) this.buckets.delete(key);
    }
  }

  // ── Daily read budget ──────────────────────────────────────────────────────

  private budgetKey(userKey: string): string {
    return `${userKey}|${new Date(this.now()).toISOString().slice(0, 10)}`;
  }

  /** Whether the user may still read today. Not consumed here: see `consumeRead`. */
  checkReadBudget(userKey: string): RateDecision {
    const used = this.budgets.get(this.budgetKey(userKey));
    if (!used || (used.rows < DAILY_READ_ROWS && used.chars < DAILY_READ_CHARS)) return { ok: true };
    const now = new Date(this.now());
    const nextMidnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil((nextMidnight - now.getTime()) / 1000)) };
  }

  consumeRead(userKey: string, rows: number, chars: number, dayKey?: string): void {
    const key = dayKey ?? this.budgetKey(userKey);
    const used = this.budgets.get(key) ?? { rows: 0, chars: 0 };
    used.rows += rows;
    used.chars += chars;
    this.budgets.set(key, used);
    // Yesterday's counters are dead weight.
    if (this.budgets.size > 500) {
      const today = new Date(this.now()).toISOString().slice(0, 10);
      for (const k of this.budgets.keys()) if (!k.endsWith(`|${today}`)) this.budgets.delete(k);
    }
  }

  /**
   * Reserve `est` against today's budget BEFORE the read runs. `checkReadBudget`
   * followed by `consumeRead` after an `await` lets N concurrent calls all pass
   * the check against the same stale total. A reservation counts in-flight
   * reads, so the budget cannot be overshot by running calls in parallel.
   * Refused when `used + reserved + est` would pass either limit. The caller
   * must `settle` the returned reservation exactly once (the real size on
   * success, nothing on failure); settling again is a no-op.
   */
  reserveRead(userKey: string, est: Budget): { ok: true; settle: (actual?: Budget) => void } | { ok: false; retryAfterSec: number } {
    const key = this.budgetKey(userKey);
    const used = this.budgets.get(key) ?? { rows: 0, chars: 0 };
    const held = this.reserved.get(key) ?? { rows: 0, chars: 0 };
    if (used.rows + held.rows + est.rows > DAILY_READ_ROWS || used.chars + held.chars + est.chars > DAILY_READ_CHARS) {
      const now = new Date(this.now());
      const nextMidnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
      return { ok: false, retryAfterSec: Math.max(1, Math.ceil((nextMidnight - now.getTime()) / 1000)) };
    }
    held.rows += est.rows;
    held.chars += est.chars;
    this.reserved.set(key, held);
    let settled = false;
    return {
      ok: true,
      settle: (actual) => {
        if (settled) return;
        settled = true;
        const current = this.reserved.get(key);
        if (current) {
          current.rows = Math.max(0, current.rows - est.rows);
          current.chars = Math.max(0, current.chars - est.chars);
          if (current.rows === 0 && current.chars === 0) this.reserved.delete(key);
        }
        if (actual) this.consumeRead(userKey, actual.rows, actual.chars, key);
      },
    };
  }

  readBudgetUsed(userKey: string): Budget {
    return { ...(this.budgets.get(this.budgetKey(userKey)) ?? { rows: 0, chars: 0 }) };
  }

  // ── Deep paging ────────────────────────────────────────────────────────────

  /**
   * Record that `principal` followed `cursor` for the query `queryHash` (the
   * hash ignores `cursor` and `limit`). Pages are counted as distinct cursors,
   * not as offset / limit: a cursor encodes where the previous page really
   * ended, so short pages (the output cap) and a changed `limit` cannot make a
   * walk look shorter, and re-reading one page is not a walk. Returns the
   * number of distinct pages seen, and `flagged: true` exactly once, the first
   * time that number exceeds DEEP_PAGING_PAGES.
   *
   * Each principal keeps at most MAX_PAGING_KEYS_PER_PRINCIPAL queries, so a
   * flood of distinct queries evicts only that principal's own older trail,
   * never another principal's.
   */
  trackPage(principal: string, queryHash: string, cursor: string): { calls: number; flagged: boolean } {
    const key = `${principal}|${queryHash}`;
    const seen = this.pages.get(key) ?? new Set<string>();
    if (seen.size < MAX_TRACKED_CURSORS) seen.add(cursor);
    this.pages.delete(key);
    this.pages.set(key, seen); // re-insert: Map order is least-recently-updated first

    let mine = 0;
    for (const k of this.pages.keys()) if (k.startsWith(`${principal}|`)) mine++;
    if (mine > MAX_PAGING_KEYS_PER_PRINCIPAL) {
      for (const k of this.pages.keys()) {
        if (k.startsWith(`${principal}|`) && k !== key) {
          this.pages.delete(k);
          this.flaggedPaging.delete(k);
          break;
        }
      }
    }
    if (this.pages.size > 5_000) {
      const oldest = this.pages.keys().next().value as string;
      this.pages.delete(oldest);
      this.flaggedPaging.delete(oldest);
    }

    if (seen.size > DEEP_PAGING_PAGES && !this.flaggedPaging.has(key)) {
      this.flaggedPaging.add(key);
      return { calls: seen.size, flagged: true };
    }
    return { calls: seen.size, flagged: false };
  }
}

// ── One limiter per profile database ─────────────────────────────────────────

const limiters = new WeakMap<Database, RateLimiter>();

/** The limiter for this database, created on first use. Keyed by the connection, so profiles and tests never share state. */
export function limiterFor(db: Database): RateLimiter {
  let limiter = limiters.get(db);
  if (!limiter) {
    limiter = new RateLimiter();
    limiters.set(db, limiter);
  }
  return limiter;
}

/** Replace a database's limiter (tests inject a fake clock this way). */
export function setLimiterFor(db: Database, limiter: RateLimiter): void {
  limiters.set(db, limiter);
}

/** `'anon'` while dashboard auth is off. */
export function userKeyOf(userId: number | null): string {
  return userId === null ? 'anon' : `user:${userId}`;
}
