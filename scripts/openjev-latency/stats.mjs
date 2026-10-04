// Pure helpers for the open-jev latency harness (bun-tested: src/__tests__/openjev-latency-stats.test.ts).

/** Nearest-rank percentile of an unsorted list; null when empty. */
export function percentile(values, p) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))];
}

/** p50/p90/min/max/mean/n of a list; nulls when empty. */
export function summarize(values) {
  const v = values.filter((x) => Number.isFinite(x));
  if (!v.length) return { n: 0, p50: null, p90: null, min: null, max: null, mean: null };
  return {
    n: v.length,
    p50: percentile(v, 0.5),
    p90: percentile(v, 0.9),
    min: Math.min(...v),
    max: Math.max(...v),
    mean: v.reduce((a, b) => a + b, 0) / v.length,
  };
}

/** Spread across runs of a per-run statistic (e.g. each run's p50): min, max, max/min ratio. */
export function spread(perRun) {
  const v = perRun.filter((x) => Number.isFinite(x));
  if (!v.length) return { runs: 0, min: null, max: null, ratio: null };
  const min = Math.min(...v), max = Math.max(...v);
  return { runs: v.length, min, max, ratio: min > 0 ? max / min : null };
}

/**
 * Classify "is the machine idle" from a process snapshot.
 * procs: [{ pid, pcpu, command }]; loadavg1: 1-min load average; cores: logical CPUs.
 * Busy when any process exceeds perProcCpu %, the sum exceeds totalCpu %, or load1 > cores * 0.25.
 * GPU load is not visible to ps: processes that commonly hold the GPU are flagged by name, even when
 * their CPU is low, as a reason to treat the label as "unsure".
 */
export const GPU_SUSPECTS = /WindowServer|Creative Cloud|Adobe|Electron|Slack|Zoom|Teams|Discord|Spotify|Final Cut|Premiere|Photoshop|Blender|Unity|Steam|OBS|Google Chrome|Safari|Firefox|chrome-headless|Chromium/i;

export function classifyIdle(procs, loadavg1, cores, opts = {}) {
  const perProcCpu = opts.perProcCpu ?? 10;
  const totalCpu = opts.totalCpu ?? 25;
  const reasons = [];
  const hot = procs.filter((p) => p.pcpu > perProcCpu);
  for (const p of hot) reasons.push(`${p.command} at ${p.pcpu.toFixed(1)}% CPU`);
  const sum = procs.reduce((a, p) => a + p.pcpu, 0);
  if (sum > totalCpu) reasons.push(`sum of CPU ${sum.toFixed(0)}% > ${totalCpu}%`);
  if (loadavg1 > cores * 0.25) reasons.push(`load avg ${loadavg1.toFixed(2)} > ${(cores * 0.25).toFixed(1)}`);
  const suspects = [...new Set(procs.filter((p) => GPU_SUSPECTS.test(p.command) && p.pcpu > 1).map((p) => p.command))];
  const verdict = reasons.length ? 'busy' : suspects.length ? 'unsure' : 'idle';
  return { verdict, reasons, gpuSuspects: suspects, sumCpu: sum };
}

/** Parse `ps -Ao pid=,pcpu=,comm=` output. */
export function parsePs(text) {
  return text.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
    const m = /^(\d+)\s+([\d.]+)\s+(.*)$/.exec(l);
    return m ? { pid: Number(m[1]), pcpu: Number(m[2]), command: m[3].split('/').pop() ?? m[3] } : null;
  }).filter(Boolean);
}
