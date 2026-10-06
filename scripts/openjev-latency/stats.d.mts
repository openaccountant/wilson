export function percentile(values: number[], p: number): number | null;
export function summarize(values: number[]): { n: number; p50: number | null; p90: number | null; min: number | null; max: number | null; mean: number | null };
export function spread(perRun: number[]): { runs: number; min: number | null; max: number | null; ratio: number | null };
export const GPU_SUSPECTS: RegExp;
export function classifyIdle(
  procs: { pid: number; pcpu: number; command: string }[],
  loadavg1: number,
  cores: number,
  opts?: { perProcCpu?: number; totalCpu?: number },
): { verdict: 'idle' | 'busy' | 'unsure'; reasons: string[]; gpuSuspects: string[]; sumCpu: number };
export function parsePs(text: string): { pid: number; pcpu: number; command: string }[];
