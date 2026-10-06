export const LABELS: string[];
export const BARS: { divertedMinPct: number; routedMinPct: number; falselyGatedMaxPct: number; c4MinRows: number; p95MaxMs: number };
export function percentile(values: number[], p: number): number | null;
export function parseJsonl(text: string): Array<{ q: string; expect: string; [k: string]: unknown }>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function scoreSet(records: any[]): any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function verdict(score: any): { bars: Record<string, boolean>; allPass: boolean };
export const ROUND2_BARS: {
  divertedMinPct: number;
  c4MinRows: number;
  precisionMinPct: number;
  wrongOrUselessMaxPct: number;
  coverageTargetPct: number;
  p95MaxMs: number;
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function scoreRound2(records: any[]): any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function verdictRound2(score: any): { bars: Record<string, boolean>; allPass: boolean; coverageMetTarget: boolean };
