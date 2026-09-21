// ── Offline mirror: sync engine ──────────────────────────────────────────────
//
// Pulls one full snapshot from the dashboard server and applies it to the
// mirror. Pure module: the fetcher is injected, so bun:test drives it with
// fakes while the browser client (mirror-client.ts) implements it with authed
// fetches and worker RPC.

import { applySync, type ApplySyncResult } from './mirror-schema.js';
import type {
  MirrorEntityRow,
  MirrorTransactionRow,
  SqliteBinding,
  SyncPayload,
} from './types.js';

/**
 * The "unbounded" transactions pull: apiTransactions does `txns.slice(0, limit)`
 * with no server-side cap, so a huge limit returns the full set — no server
 * change needed.
 */
export const SYNC_PULL_LIMIT = 10_000_000;

export interface SyncFetcher {
  fetchActiveProfile(): Promise<string>;
  fetchAllTransactions(): Promise<MirrorTransactionRow[]>;
  fetchAllEntities(): Promise<MirrorEntityRow[]>;
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

/**
 * Fetch profile + full transactions + entities, then apply them to the mirror
 * in one transaction. On any fetch rejection the mirror is NOT mutated — it
 * keeps serving its last good set while offline — and `{ ok: false }` is
 * returned (the client flips its online flag).
 *
 * A profile change is handled by applySync's meta gate: the client rekeys the
 * pool first when it knows the profile changed, and the gate drops + re-seeds
 * if a mismatch ever reaches the store anyway.
 */
export async function runSync(target: SyncTarget, fetcher: SyncFetcher): Promise<SyncResult> {
  try {
    const profile = await fetcher.fetchActiveProfile();
    const [transactions, entities] = await Promise.all([
      fetcher.fetchAllTransactions(),
      fetcher.fetchAllEntities(),
    ]);
    const payload: SyncPayload = { profile, transactions, entities };
    const result = isSqliteBinding(target)
      ? await applySync(target, payload)
      : await target(payload);
    return { ok: true, profile, ...result };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}