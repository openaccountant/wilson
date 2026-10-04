/**
 * Provenance for open-jev proposals (specs/open-jev-labeler.md §8.1, §12).
 *
 * Import-free on purpose: the dashboard UI imports it the way hybrid/client.ts
 * imports src/model/. B1-a keeps this only browser-side (worker results and the
 * sessionStorage cache); B1-b persists it. B2 (trace judge) reuses it verbatim.
 */

export const PROVENANCE_SCHEMA = 'prelabel-prov/1' as const;

/**
 * Same pattern as the P4a `judgeModel` field (judge spec :883), so `modelId`
 * can be passed through to B2 unchanged. The UI protocol validates against a
 * copy of this regex (ui/src/prelabel/protocol.ts is import-free).
 */
export const MODEL_ID_PATTERN = /^[\w.:\/-]{1,64}$/;

export interface PrelabelProvenanceV1 {
  schema: typeof PROVENANCE_SCHEMA;
  /** `<repo>:<dtype>`, matches MODEL_ID_PATTERN. */
  modelId: string;
  repo: string;
  dtype: string;
  device: string;
  temperature: number;
  templateVersion: string;
  labelSetVersion: string;
  /** p1 - p2 over the calibrated probabilities. */
  margin: number;
  p1: number;
  p2: number;
  top2: [[string, number], [string, number]];
  /** sha256 of the fetched config.json; cross-check against the pin. */
  configSha: string;
  runtime: { transformers: string; ort: string; openJev: string; device: string; dtype: string };
  runId: string;
}

/** Longest category name that goes into a rationale; keeps the sentence far below 600 chars. */
const MAX_NAME_CHARS = 80;

// Control characters, line/paragraph separators, bidi and zero-width marks.
// Category names are user- and agent-reachable text; none of it may smuggle
// line breaks or invisible characters into a field an agent-facing tool reads.
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]+/g;

function cleanName(name: string, max: number = MAX_NAME_CHARS): string {
  const s = String(name).replace(UNSAFE_CHARS, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return '(unnamed)';
  return s.length > max ? `${s.slice(0, max).trimEnd()}…` : s;
}

function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}

/**
 * The honest, templated rationale B2 must use (P4a requires 20..600 chars of
 * rationale and open-jev cannot produce free text, spike §7.3). Example:
 *   open-jev (DeBERTa q4f16, T=1.05) chose Dining over Groceries at margin 0.31;
 *   discriminative score, no free-text reasoning.
 */
export function templateRationale(p: PrelabelProvenanceV1): string {
  const chosen = cleanName(p.top2[0][0]);
  const other = cleanName(p.top2[1][0]);
  const dtype = cleanName(p.dtype, 16);
  const temperature = Number.isFinite(p.temperature) ? p.temperature.toFixed(2) : '?';
  return (
    `open-jev (DeBERTa ${dtype}, T=${temperature}) chose ${chosen} over ${other} ` +
    `at margin ${clamp01(p.margin).toFixed(2)}; discriminative score, no free-text reasoning.`
  );
}
