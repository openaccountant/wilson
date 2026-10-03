// ── Model worker <-> mirror worker: the scoped tool port (pure) ──────────────
//
// The model worker (transformers.js) never touches the mirror directly and
// never holds the auth token. Each subagent run gets a fresh MessageChannel;
// one end is transferred to the mirror worker (`attachPort`) and the other goes
// to the model worker. This module is the CAPABILITY BOUNDARY on the mirror
// side of that port, kept pure (no browser glue, no bun:sqlite) so it is
// testable under bun:test:
//
//   * only `status` and `toolRead` are accepted; applySync / setProfile /
//     serve (and anything else) are rejected;
//   * `tool` and `args` are re-validated here against the frozen schema
//     snapshot, so the mirror does not trust the model worker's validation;
//   * the port is bound to the profile it was opened for. If the worker's
//     current profile differs (mirror-client re-keys on sync), a read resolves
//     `servable:false, why:'not-seeded'` instead of reading another profile;
//   * every servable result carries the profile it ran against.
//
// Port traffic runs through the SAME serialisation chain as applySync (the
// PortHost.enqueue the worker supplies), so a tool read never observes a
// half-applied sync.

import { validateReadToolArgs } from '../hybrid/read-tool-schemas.js';
import { MIRROR_SCHEMA_VERSION } from './mirror-schema.js';
import {
  mirrorCategoryNames,
  mirrorExecuteRead,
  READ_TOOL_NAMES,
  SERVABLE_READ_TOOLS,
  type ReadToolName,
  type ToolReadResult,
} from './mirror-tools.js';
import type { SqliteBinding } from './types.js';

export type { ReadToolName, ToolReadResult };

export type MirrorPortRequest =
  | { id: number; t: 'status' }
  | { id: number; t: 'toolRead'; tool: ReadToolName; args: Record<string, unknown>; nowIso: string };

export type MirrorPortResponse =
  | { id: number; ok: true; result: MirrorPortStatus | ToolReadResult }
  | { id: number; ok: false; error: string };

export interface MirrorPortStatus {
  /** The profile the mirror worker currently has open (not necessarily the bound one). */
  profile: string | null;
  seeded: boolean;
  lastSyncedAt: string | null;
  schemaVersion: number;
  servable: ReadToolName[];
  categories: string[];
}

/** Live worker state a port message is evaluated against. */
export interface PortContext {
  /** The profile currently open in the mirror worker. */
  profile: string | null;
  /** The profile this port was bound to when it was attached. */
  boundProfile: string;
  seeded: boolean;
  lastSyncedAt: string | null;
}

const NOT_SEEDED: ToolReadResult = { servable: false, why: 'not-seeded' };

function fail(id: number, error: string): MirrorPortResponse {
  return { id, ok: false, error };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Handle one message from a tool port. Never throws: malformed input,
 * rejected message types and executor errors all become `{ok:false}`.
 */
export async function handlePortMessage(
  binding: SqliteBinding | null,
  ctx: PortContext,
  msg: unknown
): Promise<MirrorPortResponse> {
  if (!isRecord(msg) || typeof msg.id !== 'number' || !Number.isFinite(msg.id)) {
    return fail(-1, 'malformed port message');
  }
  const id = msg.id;
  try {
    switch (msg.t) {
      case 'status': {
        const usable = binding !== null && ctx.seeded;
        const status: MirrorPortStatus = {
          profile: ctx.profile,
          seeded: ctx.seeded,
          lastSyncedAt: ctx.lastSyncedAt,
          schemaVersion: MIRROR_SCHEMA_VERSION,
          servable: usable ? [...SERVABLE_READ_TOOLS] : [],
          categories: usable ? await mirrorCategoryNames(binding) : [],
        };
        return { id, ok: true, result: status };
      }
      case 'toolRead': {
        if (typeof msg.tool !== 'string' || !(READ_TOOL_NAMES as readonly string[]).includes(msg.tool)) {
          return fail(id, 'unknown tool');
        }
        const verdict = validateReadToolArgs(msg.tool, msg.args);
        if (!verdict.ok) return fail(id, `invalid args: ${verdict.error}`);
        if (typeof msg.nowIso !== 'string') return fail(id, 'nowIso required');
        const now = new Date(msg.nowIso);
        if (Number.isNaN(now.getTime())) return fail(id, 'nowIso is not a date');
        // Profile binding: never read a profile this port was not opened for.
        if (!binding || !ctx.seeded || ctx.profile === null || ctx.profile !== ctx.boundProfile) {
          return { id, ok: true, result: NOT_SEEDED };
        }
        const result = await mirrorExecuteRead(binding, msg.tool as ReadToolName, msg.args as Record<string, unknown>, now, ctx.boundProfile);
        return { id, ok: true, result };
      }
      default:
        return fail(id, `port rejects message type: ${String(msg.t ?? msg.type)}`);
    }
  } catch (err) {
    return fail(id, err instanceof Error ? err.message : String(err));
  }
}

// ── Port wiring (pure; the worker supplies the host) ─────────────────────────

/** Structural subset of MessagePort used by the wiring. */
export interface PortLike {
  onmessage: ((ev: { data: unknown }) => void) | null;
  postMessage(message: unknown): void;
  close(): void;
}

/** What the mirror worker provides to serve a port. */
export interface PortHost {
  getBinding(): SqliteBinding | null;
  /** Live worker state (profile, seeded, lastSyncedAt); evaluated inside the chain. */
  getContext(): Promise<{ profile: string | null; seeded: boolean; lastSyncedAt: string | null }>;
  /** Run `fn` on the worker's serialisation chain (shared with applySync). */
  enqueue<T>(fn: () => Promise<T>): Promise<T>;
}

/**
 * Start serving `port`, bound to `boundProfile`. Each message is handled on
 * the host chain with the context read at that moment, and always answered on
 * the same port (an unexpected failure answers `{ok:false}`).
 */
export function servePort(port: PortLike, boundProfile: string, host: PortHost): void {
  port.onmessage = (ev) => {
    const data = ev.data;
    const id = isRecord(data) && typeof data.id === 'number' ? data.id : -1;
    host
      .enqueue(async () => {
        const live = await host.getContext();
        return handlePortMessage(host.getBinding(), { ...live, boundProfile }, data);
      })
      .catch((err): MirrorPortResponse => fail(id, err instanceof Error ? err.message : String(err)))
      .then((response) => {
        try {
          port.postMessage(response);
        } catch {
          // Port already closed by the caller; nothing to answer.
        }
      });
  };
}
