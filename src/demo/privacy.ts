/**
 * Privacy Validator (issue #95) — the Demo tab's proof instrument.
 *
 * Two pieces, one rule: say exactly where every request went.
 *
 * 1. The live provider ledger. Every model/agent request funnels through
 *    callLlm (which records one trace row per call) plus the two showdown
 *    arms' non-network recorders, so the trace store already holds the full
 *    picture — this module renders it, it instruments nothing new. A run is
 *    a server-issued id-exclusion watermark over that store: arming a run
 *    snapshots the ids of every trace present at that moment, and the ledger
 *    returns only rows NOT in that set. Ids (the DB's monotone autoincrement
 *    and the store's unique trace ids) are used instead of timestamps
 *    because the two sources carry different timestamp formats (in-memory
 *    rows are ISO strings; `created_at` is `YYYY-MM-DD HH:MM:SS` UTC at
 *    second granularity) — a string-compare watermark across them is lossy.
 *
 *    Classification comes from the provider registry's `isLocal` (the single
 *    place local-vs-server classification comes from) plus the Speed
 *    Showdown's two markers: a `simulated` row is never a cloud call, and an
 *    unrecognized provider is never silently counted as local. The verdict
 *    must be able to fail — a real cloud call during the run renders red and
 *    the verdict says the all-local claim does not hold.
 *
 * 2. The would-be cloud payload exhibit. The exact request a cloud-based
 *    agent (the jev-ultrafast contrast case) would have sent for the same
 *    decision step — built exclusively from the in-repo synthetic sample
 *    fixtures. The guard is structural: `getPrivacyExhibit` takes no db
 *    parameter and reads nothing, so an attendee-imported row is physically
 *    incapable of entering the payload.
 *
 * Server-side only. Pure functions (`classifyProvider`, `buildProviderLedger`,
 * `getPrivacyExhibit`) are unit-tested; only the run helpers touch state, and
 * nothing here imports the db, api.ts, or interactionStore.
 */

import type { Database } from '../db/compat-sqlite.js';
import { getProviderById } from '../providers.js';
import { buildCategorizationPrompt } from '../tools/categorize/prompt.js';
import { traceStore, type LlmTrace } from '../utils/trace-store.js';
import { getSampleBySlug, SAMPLE_TRANSACTIONS } from './samples.js';
import {
  BROWSER_LOCAL_PROVIDER,
  buildShowdownUserPrompt,
  SHOWDOWN_SYSTEM_PROMPT,
  SIMULATED_PROVIDER,
} from './showdown.js';

// ── Classification ──────────────────────────────────────────────────────────

export type LedgerBucket = 'local' | 'simulated' | 'cloud' | 'unknown';

/** Chip copy per bucket — the UI renders these verbatim. */
export const BUCKET_LABELS: Record<LedgerBucket, string> = {
  local: 'localhost',
  simulated: 'simulated — no network',
  cloud: 'CLOUD',
  unknown: 'unrecognized',
};

/**
 * The one classification rule. 'simulated' can never be 'cloud' (the Speed
 * Showdown marker exists precisely to prevent that misattribution) and an
 * unrecognized provider is never silently 'local' — it lands in its own
 * honest bucket.
 */
export function classifyProvider(provider: string): LedgerBucket {
  if (provider === SIMULATED_PROVIDER) return 'simulated';
  if (provider === BROWSER_LOCAL_PROVIDER) return 'local';
  const def = getProviderById(provider);
  if (!def) return 'unknown';
  return def.isLocal ? 'local' : 'cloud';
}

// ── The ledger ──────────────────────────────────────────────────────────────

export interface LedgerEntry {
  traceId: string;
  /** Normalized ISO — parses with `new Date(...)` from either source. */
  timestamp: string;
  /** Verbatim from the trace row (e.g. 'simulated', 'transformers-browser', 'openrouter'). */
  provider: string;
  model: string;
  bucket: LedgerBucket;
  durationMs: number;
  status: 'ok' | 'error';
  error?: string;
}

export interface PrivacyLedger {
  runId: string;
  /** ISO, display only. */
  startedAt: string;
  /** Chronological, oldest → newest. */
  entries: LedgerEntry[];
  counts: { local: number; simulated: number; cloud: number; unknown: number; total: number };
  /** cloud === 0 && unknown === 0 — the only condition an all-clear needs. */
  allLocal: boolean;
  verdict: string;
}

/** The trace fields the ledger reads — LlmTrace and the llm_traces read both satisfy it. */
type TraceRow = Pick<LlmTrace, 'id' | 'timestamp' | 'model' | 'provider' | 'durationMs' | 'status'> & {
  error?: string;
};

/**
 * Pure: render rows (already chronological) into the ledger. The caller owns
 * run scoping; this owns classification, counting, and the verdict copy.
 */
export function buildProviderLedger(input: {
  runId: string;
  startedAt: string;
  rows: TraceRow[];
}): PrivacyLedger {
  const entries: LedgerEntry[] = input.rows.map((row) => ({
    traceId: row.id,
    timestamp: normalizeTimestamp(row.timestamp),
    provider: row.provider,
    model: row.model,
    bucket: classifyProvider(row.provider),
    durationMs: row.durationMs,
    status: row.status,
    ...(row.error !== undefined ? { error: row.error } : {}),
  }));

  const counts = {
    local: 0,
    simulated: 0,
    cloud: 0,
    unknown: 0,
    total: entries.length,
  };
  for (const e of entries) counts[e.bucket]++;

  const allLocal = counts.cloud === 0 && counts.unknown === 0;

  let verdict: string;
  if (counts.total === 0) {
    verdict = 'No model or agent requests since you started watching — nothing has left this machine.';
  } else if (counts.cloud > 0) {
    verdict =
      `${counts.cloud} request${counts.cloud === 1 ? '' : 's'} went to a cloud provider during this run — ` +
      'the all-local claim does not hold. See the red rows.';
  } else if (counts.unknown > 0) {
    verdict =
      `${counts.unknown} request${counts.unknown === 1 ? '' : 's'} came from an unrecognized provider — ` +
      'not counted as local. Review before trusting the all-local claim.';
  } else {
    verdict =
      `All ${counts.total} request${counts.total === 1 ? '' : 's'} stayed on localhost — ` +
      `${counts.local} local, ${counts.simulated} clearly-marked simulated timers, 0 cloud calls.`;
  }

  return { runId: input.runId, startedAt: input.startedAt, entries, counts, allLocal, verdict };
}

// ── Run state (module-level; the server process owns the watermark) ─────────

const MAX_RUNS = 5;
const READ_LIMIT = 200;

interface PrivacyRun {
  startedAt: string;
  /** Trace ids present when the run armed — the ledger excludes exactly these. */
  knownIds: Set<string>;
}

const runs = new Map<string, PrivacyRun>();

/**
 * Arm a run: snapshot the ids of every trace currently visible (DB latest-200
 * ∪ in-memory buffer — either source may hold rows the other lost) and return
 * the run token. The server, not the browser clock, issues the watermark, so
 * a QR/phone client with clock skew cannot misplace it.
 */
export function startPrivacyRun(db: Database | null): { id: string; startedAt: string } {
  const knownIds = new Set<string>();
  for (const row of readRecentTraces(db)) knownIds.add(row.id);
  for (const row of traceStore.getTraces()) knownIds.add(row.id);

  const id = `${Date.now()}-privacy-${Math.random().toString(36).slice(2, 9)}`;
  const startedAt = new Date().toISOString();
  runs.set(id, { startedAt, knownIds });
  while (runs.size > MAX_RUNS) {
    const oldest = runs.keys().next().value;
    if (oldest === undefined) break;
    runs.delete(oldest);
  }
  return { id, startedAt };
}

/**
 * The ledger for one run: every trace recorded since the run armed.
 * Throws on an unknown/null run id (the endpoint turns that into a 400 —
 * e.g. the server restarted and wiped run state; the panel re-arms).
 */
export function getPrivacyLedger(db: Database | null, runId: string | null): PrivacyLedger {
  const run = runId ? runs.get(runId) : undefined;
  if (!run || !runId) {
    throw new Error('unknown privacy run — start a new one');
  }
  const rows = readRecentTraces(db).filter((r) => !run.knownIds.has(r.id));
  return buildProviderLedger({ runId, startedAt: run.startedAt, rows });
}

/**
 * The latest traces, DB-first — mirroring apiTraces' semantics exactly:
 * DB rows when present, the memory ring buffer only when the DB yields none.
 * Ordering is the DB's monotone autoincrement id (the ONLY ordering axis —
 * `created_at` and ISO timestamps are different formats; never sort across
 * sources), fetched DESC and reversed to oldest → newest.
 */
function readRecentTraces(db: Database | null): TraceRow[] {
  if (db) {
    try {
      const rows = db
        .prepare(
          `SELECT trace_id AS id, model, provider, duration_ms AS durationMs,
             status, error, created_at AS timestamp
           FROM llm_traces ORDER BY id DESC LIMIT @limit`
        )
        .all({ limit: READ_LIMIT }) as Array<{
        id: string;
        model: string;
        provider: string;
        durationMs: number;
        status: string;
        error: string | null;
        timestamp: string;
      }>;
      if (rows.length > 0) {
        return rows.reverse().map((r) => ({
          id: r.id,
          model: r.model,
          provider: r.provider,
          durationMs: r.durationMs,
          status: r.status as LlmTrace['status'],
          ...(r.error != null ? { error: r.error } : {}),
          timestamp: normalizeTimestamp(r.timestamp),
        }));
      }
    } catch {
      /* fall through to the memory buffer */
    }
  }
  return traceStore.getTraces().slice(-READ_LIMIT);
}

/**
 * `created_at` is `YYYY-MM-DD HH:MM:SS` UTC (no tz marker, space separator);
 * in-memory rows are ISO. Normalize so the UI can `new Date(ts)` either way.
 */
function normalizeTimestamp(ts: string): string {
  if (ts.includes('T')) return ts;
  return `${ts.replace(' ', 'T')}Z`;
}

// ── The would-be cloud payload exhibit ──────────────────────────────────────

export interface PrivacyExhibit {
  /** What a cloud agent would call — the openrouter fastModel, verbatim. */
  cloudModel: string;
  payload: { system: string; user: string };
  rowCount: number;
  rows: Array<{ id: number; slug: string; description: string; amount: number; date: string }>;
  note: string;
}

export const EXHIBIT_NOTE =
  'Built exclusively from the in-repo synthetic sample fixtures — attendee-imported data can ' +
  'never appear here: no code path feeds anything but these fixtures to the prompt builder.';

/**
 * The exact request a cloud-based agent would have sent for the same decision
 * step. With a slug this is byte-identical to what the Speed Showdown arms
 * send for that sample; without, it covers all 8 fixture rows. Fixture-only
 * by construction: the function takes no db and reads nothing, so an
 * attendee-imported row cannot enter the payload.
 */
export function getPrivacyExhibit(slug?: string): PrivacyExhibit {
  const cloudModel = getProviderById('openrouter')?.fastModel ?? '';
  if (slug !== undefined) {
    const sample = getSampleBySlug(slug); // throws on unknown → endpoint 400
    return {
      cloudModel,
      payload: { system: SHOWDOWN_SYSTEM_PROMPT, user: buildShowdownUserPrompt(sample) },
      rowCount: 1,
      rows: [
        {
          id: sample.id,
          slug: sample.slug,
          description: sample.description,
          amount: sample.amount,
          date: sample.date,
        },
      ],
      note: EXHIBIT_NOTE,
    };
  }
  const rows = SAMPLE_TRANSACTIONS.map((s) => ({
    id: s.id,
    slug: s.slug,
    description: s.description,
    amount: s.amount,
    date: s.date,
  }));
  return {
    cloudModel,
    payload: {
      system: SHOWDOWN_SYSTEM_PROMPT,
      user: buildCategorizationPrompt(
        rows.map((r) => ({ id: r.id, description: r.description, amount: r.amount, date: r.date })),
      ),
    },
    rowCount: rows.length,
    rows,
    note: EXHIBIT_NOTE,
  };
}