/**
 * Hybrid chat capability verdict — what gets persisted per browser session,
 * and which local-model load failures are allowed to stick.
 *
 * Pure (no DOM, no transformers.js), bundled only into the hybrid chunk via
 * client.ts and unit tested under bun (src/__tests__/hybrid-capability.test.ts).
 *
 * Rules:
 * - 'unavailable' (no WebGPU adapter) is a property of the browser, so it
 *   applies regardless of which model the server configures.
 * - 'ready' and 'failed' are properties of THIS model config: the persisted
 *   verdict carries a key (resolver version + repo + catalog dtype) and is
 *   discarded when the key changes, so a tab that failed on an old config (or
 *   on the pre-resolver fp16 bug) retries after the config/fix changes.
 * - Only genuine capability failures persist as 'failed'. Network errors,
 *   missing files, repo-not-found and damaged caches leave the verdict alone
 *   so the next attempt retries.
 */

import type { HybridCapability } from './core.js';
import { isCorruptModelFileError } from '../../../../model/transformers-dtype.js';

/**
 * Bump when dtype resolution or load semantics change in a way that should
 * invalidate 'failed' verdicts persisted by older builds.
 * v1 (implicit, unkeyed): hardcoded fp16. v2: shared resolver + keyed verdicts.
 */
export const HYBRID_RESOLVER_VERSION = 2;

/** The config fields a verdict depends on (subset of /api/config/local-chat). */
export interface CapabilityConfig {
  repo: string;
  dtype?: string | null;
}

export function capabilityKey(cfg: CapabilityConfig): string {
  return `v${HYBRID_RESOLVER_VERSION}|${cfg.repo}|${cfg.dtype ?? 'resolve'}`;
}

/** What sessionStorage holds. Older builds wrote `{ verdict, repo }` with no key. */
export interface PersistedCapability {
  verdict: Exclude<HybridCapability, 'unknown'>;
  key?: string | null;
  repo?: string | null;
  /** Human-readable reason for a 'failed' verdict. */
  detail?: string | null;
}

/** Parse a stored record defensively; anything malformed → null. */
export function parsePersistedCapability(raw: string | null): PersistedCapability | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as Partial<PersistedCapability> | null;
    if (!p || (p.verdict !== 'ready' && p.verdict !== 'unavailable' && p.verdict !== 'failed')) return null;
    return {
      verdict: p.verdict,
      key: typeof p.key === 'string' ? p.key : null,
      repo: typeof p.repo === 'string' ? p.repo : null,
      detail: typeof p.detail === 'string' ? p.detail : null,
    };
  } catch {
    return null;
  }
}

/**
 * The verdict to start from, given what was persisted and the current config
 * key (null = config not known yet). A keyed verdict whose key no longer
 * matches — including every unkeyed record from an older build — is dropped
 * to 'unknown' so the local path is re-probed.
 */
export function restoreCapability(stored: PersistedCapability | null, key: string | null): HybridCapability {
  if (!stored) return 'unknown';
  if (stored.verdict === 'unavailable') return 'unavailable';
  if (!key || !stored.key || stored.key !== key) return 'unknown';
  return stored.verdict;
}

/** Where in loadModel a failure happened. */
export type LoadPhase = 'resolve' | 'load' | 'warmup';

export type LoadFailureKind =
  /** The GPU/model combination cannot work: persist 'failed' for this config. */
  | 'capability'
  /** Worth retrying on the next attempt (network, 404, damaged cache, …). */
  | 'transient';

const DTYPE_CAPABILITY_CODES = new Set(['requires-shader-f16', 'no-usable-dtype', 'no-onnx-weights']);

const TRANSIENT_RE =
  /fetch|network|could not locate file|offline|timed? ?out|timeout|ECONN|ENOTFOUND|EAI_AGAIN|\bHTTP\b|status(?: code)?:? ?\d{3}|\bHTTP\s*(?:404|408|429|5\d\d)\b|quota|cache storage/i;

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === 'string' ? err : '';
}

/**
 * Classify a loadModel failure. Structural on TransformersDtypeError (by
 * name/code) so this never needs the class identity across bundles.
 */
export function classifyLoadFailure(err: unknown, phase: LoadPhase): LoadFailureKind {
  const e = err as { name?: unknown; code?: unknown } | null;
  if (e && e.name === 'TransformersDtypeError') {
    return typeof e.code === 'string' && DTYPE_CAPABILITY_CODES.has(e.code) ? 'capability' : 'transient';
  }
  // A real generation that fails on a session that did build: the GPU cannot
  // run this model.
  if (phase === 'warmup') return 'capability';
  if (isCorruptModelFileError(err)) return 'transient';
  if (TRANSIENT_RE.test(errorMessage(err))) return 'transient';
  // Hub metadata/config failures before any download are never capability.
  if (phase === 'resolve') return 'transient';
  // Session creation failures (no usable backend, unsupported op, OOM, …).
  return 'capability';
}

/** A short, human-readable reason for a load failure, suitable for the chat notice. */
export function describeLoadFailure(err: unknown, repo: string, dtype: string | null): string {
  const e = err as { name?: unknown } | null;
  if (e && e.name === 'TransformersDtypeError') return errorMessage(err);
  if (isCorruptModelFileError(err)) {
    return (
      `the cached files for ${repo} look incomplete or corrupt (likely an interrupted download); ` +
      `clear this site's stored data (Cache Storage → transformers-cache) and retry`
    );
  }
  const first = (errorMessage(err) || String(err)).split('\n')[0].slice(0, 200);
  return `failed to load ${repo}${dtype ? ` (${dtype})` : ''}: ${first}`;
}
