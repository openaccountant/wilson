// ── Offline mirror: sync engine ──────────────────────────────────────────────
//
// Pulls one full snapshot from the dashboard server and applies it to the
// mirror. Pure module: the fetcher is injected, so bun:test drives it with
// fakes while the browser client (mirror-client.ts) implements it with authed
// fetches and worker RPC.

import { applySync, type ApplySyncResult } from './mirror-schema.js';
import type {
  MirrorAccountRow,
  MirrorBalanceSnapshotRow,
  MirrorLoanRow,
  MirrorBudgetRow,
  MirrorCategoryRow,
  MirrorEntityRow,
  MirrorTransactionRow,
  SqliteBinding,
  SyncPayload,
} from './types.js';

/**
 * The "unbounded" transactions pull: apiTransactions applies `LIMIT @limit`
 * in SQL with no server-side cap, so a huge limit returns the full set — no
 * server change needed.
 */
export const SYNC_PULL_LIMIT = 10_000_000;

export interface SyncFetcher {
  fetchActiveProfile(): Promise<string>;
  fetchAllTransactions(): Promise<MirrorTransactionRow[]>;
  fetchAllEntities(): Promise<MirrorEntityRow[]>;
  fetchAllBudgets(): Promise<MirrorBudgetRow[]>;
  fetchAllCategories(): Promise<MirrorCategoryRow[]>;
  /** Mirror v4 net-worth tables. Optional so a fetcher that predates v4 still syncs (empty tables). */
  fetchAllAccounts?(): Promise<MirrorAccountRow[]>;
  fetchAllBalanceSnapshots?(): Promise<MirrorBalanceSnapshotRow[]>;
  fetchAllLoans?(): Promise<MirrorLoanRow[]>;
}

export type SyncResult =
  | ({ ok: true; profile: string } & ApplySyncResult)
  | { ok: false; error: string };

/** Applies a payload to the mirror: a live SqliteBinding or a remote applier (worker RPC). */
export type SyncApplier = (payload: SyncPayload) => Promise<ApplySyncResult>;

/** Either form is accepted by runSync. */
export type SyncTarget = SqliteBinding | SyncApplier;

function isSqliteBinding(target: SyncTarget): target is SqliteBinding {
  return typeof (target as SqliteBinding).prepare === 'function';
}

/** What a sync pulls beyond the core four tables. */
export interface SyncOptions {
  /**
   * Pull the v4 net-worth tables (accounts, balance snapshots, loans). Off unless
   * the server's browser subagent is enabled: balances are the most sensitive rows
   * in the mirror and only the subagent's net_worth / forecast tools read them.
   * Off also empties any v4 rows an earlier sync left behind. Default false.
   */
  netWorth?: boolean;
}

/**
 * True only when `/api/config/local-chat` says `subagent.enabled === true`.
 * Anything else (older server, missing field, bad shape, a truthy non-boolean)
 * is off.
 */
export function subagentEnabledFrom(config: unknown): boolean {
  if (typeof config !== 'object' || config === null) return false;
  const sub = (config as { subagent?: unknown }).subagent;
  if (typeof sub !== 'object' || sub === null) return false;
  return (sub as { enabled?: unknown }).enabled === true;
}

/**
 * One full pull as a SyncPayload. The core tables fail the whole pull (nothing is
 * applied); the v4 tables are isolated: if any one of the three fails the payload
 * carries `keepNetWorth` so applySync leaves the mirror's last good v4 set alone
 * instead of wiping it or failing the sync.
 */
export async function collectSyncPayload(fetcher: SyncFetcher, opts: SyncOptions = {}): Promise<SyncPayload> {
  const profile = await fetcher.fetchActiveProfile();
  // Started with the core fetches but never left unhandled: its own catch turns a
  // rejection into null, so a core failure cannot orphan it.
  const netWorth: Promise<[MirrorAccountRow[], MirrorBalanceSnapshotRow[], MirrorLoanRow[]] | null> = opts.netWorth
    ? (async () =>
        Promise.all([
          fetcher.fetchAllAccounts?.() ?? Promise.resolve([] as MirrorAccountRow[]),
          fetcher.fetchAllBalanceSnapshots?.() ?? Promise.resolve([] as MirrorBalanceSnapshotRow[]),
          fetcher.fetchAllLoans?.() ?? Promise.resolve([] as MirrorLoanRow[]),
        ]))().catch(() => null)
    : Promise.resolve(null);
  const [transactions, entities, budgets, categories] = await Promise.all([
    fetcher.fetchAllTransactions(),
    fetcher.fetchAllEntities(),
    fetcher.fetchAllBudgets(),
    fetcher.fetchAllCategories(),
  ]);
  const payload: SyncPayload = { profile, transactions, entities, budgets, categories };
  if (opts.netWorth) {
    const v4 = await netWorth;
    if (v4) {
      [payload.accounts, payload.balanceSnapshots, payload.loans] = v4;
    } else {
      payload.keepNetWorth = true;
    }
  }
  return payload;
}

/**
 * Fetch profile + full transactions + entities + budgets + categories (+ the
 * net-worth tables when `opts.netWorth`), then apply them to the mirror in one
 * transaction. On any core fetch rejection the mirror is NOT mutated — it keeps serving its last good set while offline —
 * and `{ ok: false }` is returned (the client flips its online flag). A failing
 * net-worth fetch is isolated instead: the sync succeeds and those tables keep
 * their last good set (see collectSyncPayload).
 *
 * A profile change is handled by applySync's meta gate: the client rekeys the
 * pool first when it knows the profile changed, and the gate drops + re-seeds
 * if a mismatch ever reaches the store anyway.
 */
export async function runSync(target: SyncTarget, fetcher: SyncFetcher, opts: SyncOptions = {}): Promise<SyncResult> {
  try {
    const payload = await collectSyncPayload(fetcher, opts);
    const profile = payload.profile;
    const result = isSqliteBinding(target)
      ? await applySync(target, payload)
      : await target(payload);
    return { ok: true, profile, ...result };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}