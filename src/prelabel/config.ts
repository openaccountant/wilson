/**
 * Server-side pins for the open-jev pre-labeler (specs/open-jev-labeler.md §4.1).
 *
 * Import-free on purpose: the browser receives these via /api/prelabel/config
 * (S3) and echoes them in provenance. Everything the model's output depends on
 * is pinned here, never `auto`/`main`.
 *
 * `revision` and `configSha` were recorded on 2026-10-02 by a network lookup:
 *   GET https://huggingface.co/api/models/<repo>            -> sha
 *   GET https://huggingface.co/<repo>/resolve/<sha>/config.json -> sha256
 * The worker pins every remote file to `revision` through
 * `env.remotePathTemplate = '{model}/resolve/<revision>/'` (DECISIONS OQ7) and
 * fails closed with `model_mismatch` if the fetched config.json hashes to
 * anything other than `configSha`. To move the pin, repeat the lookup, update
 * both fields together, and re-run live step L10.
 */

import { getSetting } from '../utils/config.js';
import { DEFAULT_MARGIN_CUT } from '../dashboard/ui/src/prelabel/core.js';

export interface PrelabelModelPins {
  readonly repo: string;
  readonly dtype: 'q4f16';
  readonly device: 'webgpu';
  /** Passed explicitly to every decide(); equals the library default. */
  readonly temperature: number;
  readonly templateVersion: 'prelabel-tmpl-v1';
  /** Provenance string; fits the judge `judgeModel` pattern /^[\w.:\/-]{1,64}$/. */
  readonly modelId: string;
  /** 40-hex HF commit sha of `repo`. */
  readonly revision: string;
  /** sha256 (64-hex) of config.json at `revision`. */
  readonly configSha: string;
  /** Bytes moved from HF for a cold q4f16 load (spike §3); consent copy only. */
  readonly approxDownloadBytes: number;
}

export const PRELABEL_MODEL: PrelabelModelPins = {
  repo: 'onnx-community/open-jev-deberta-v3-large-ONNX',
  dtype: 'q4f16',
  device: 'webgpu',
  temperature: 1.05,
  templateVersion: 'prelabel-tmpl-v1',
  modelId: 'onnx-community/open-jev-deberta-v3-large-ONNX:q4f16',
  revision: '7c79f25b5ac496089f448a969c801872ad59d31c',
  configSha: '2ec35432332ee6b5880509eefe44e6279fd9d3543f6ba96098119ffe0b0c2d5e',
  approxDownloadBytes: 350_631_305,
};

// ── Per-profile settings (settings.json via getSetting) ─────────────────────
//
// Only the two settings the PUT /api/prelabel/settings route can write exist in
// B1-a. `prelabelAllowWasmFp32` (DECISIONS OQ6), `prelabelBacklogExperiment`
// (OQ3) and `prelabelDailyLimit` (B1-b, parked) are deliberately not built.

export const PRELABEL_ENABLED_KEY = 'prelabelEnabled';
export const PRELABEL_MARGIN_CUT_KEY = 'prelabelMarginCut';

export const MARGIN_CUT_MIN = 0.05;
export const MARGIN_CUT_MAX = 0.95;

/** Rows scored per run; mirrors MAX_RUN_ITEMS in the UI protocol. */
export const PRELABEL_MAX_ROWS_PER_RUN = 2000;

export function isValidMarginCut(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= MARGIN_CUT_MIN && v <= MARGIN_CUT_MAX;
}

/** Default off (OQ5). Anything but a literal `true` in settings.json is off. */
export function prelabelEnabled(): boolean {
  return getSetting<unknown>(PRELABEL_ENABLED_KEY, false) === true;
}

/** Default 0.3 (spike-measured; re-checked by S6). An invalid stored value falls back to the default. */
export function prelabelMarginCut(): number {
  const v = getSetting<unknown>(PRELABEL_MARGIN_CUT_KEY, DEFAULT_MARGIN_CUT);
  return isValidMarginCut(v) ? v : DEFAULT_MARGIN_CUT;
}
