/* eslint-disable @typescript-eslint/no-explicit-any */
export const READ_LABELS: string[];
export const CUT_GRID: number[];
export const MIN_PRECISION: number;
export const MIN_SELECTED: number;
export const FIRST_LOCKED_VERSION: number;

export interface CutRecord {
  q?: string;
  label: string;
  hits: string[];
  top1: string;
  margin: number;
  source?: string;
  [k: string]: unknown;
}
export interface CurvePoint {
  cut: number;
  n: number;
  correct: number;
  wrong: number;
  leak: number;
  precision: number | null;
}

export function normalizeQuestion(q: unknown): string;
export function dedupeDevRows(sets: Array<{ name: string; rows: Array<{ q: string; [k: string]: unknown }> }>): Array<{ q: string; source: string; [k: string]: any }>;
export function isReadLabel(label: unknown): boolean;
export function consistent(rec: { hits?: string[]; top1: string }): boolean;
export function cutCurve(records: CutRecord[], grid?: number[]): CurvePoint[];
export function selectCut(
  records: CutRecord[],
  opts?: { minPrecision?: number; minN?: number; grid?: number[] },
): { cut: number | null; chosen: any; curve: any[]; reason: string };
export function wilsonLower(k: number, n: number, z?: number): number;
export function coverageGain(
  records: CutRecord[],
  cut: number | null,
  denominators: { total: number; byTool?: Record<string, number>; bySource?: Record<string, number> },
): { rows: number; share: number; byTool: Record<string, { gained: number; of: number }>; bySource: Record<string, { gained: number; of: number }> };
export function pct(xs: number[], p: number): number | null;
export function marginHistogram(records: Array<{ margin: number }>): Record<string, number>;
export function sha256Hex(data: string | Uint8Array): string;
export function isLockedHeldout(path: unknown): boolean;
export function armOGuard(opts: { heldoutPath: string; frozenShaArg: string | null; frozen: { sha: string; cut: number | null } | null }): string | null;
