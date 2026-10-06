import { describe, expect, test } from 'bun:test';
import { classifyIdle, parsePs, percentile, spread, summarize } from '../../scripts/openjev-latency/stats.mjs';

describe('openjev latency harness stats', () => {
  test('percentile is nearest-rank and null when empty', () => {
    expect(percentile([], 0.5)).toBeNull();
    expect(percentile([5, 1, 3, 2, 4], 0.5)).toBe(3);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBe(9);
  });

  test('summarize reports p50/p90/min/max/mean and ignores non-finite values', () => {
    const s = summarize([10, 20, 30, 40, Number.NaN]);
    expect(s).toMatchObject({ n: 4, p50: 20, min: 10, max: 40, mean: 25 });
    expect(summarize([]).p50).toBeNull();
  });

  test('spread gives min, max and ratio across runs', () => {
    expect(spread([66, 273, 100])).toEqual({ runs: 3, min: 66, max: 273, ratio: 273 / 66 });
    expect(spread([]).ratio).toBeNull();
  });

  test('parsePs reads pid, cpu and the basename of the command', () => {
    const rows = parsePs('  12  3.5 /usr/sbin/WindowServer\n 99 0.0 /Applications/Foo Bar.app/Contents/MacOS/Foo Bar\n');
    expect(rows).toEqual([
      { pid: 12, pcpu: 3.5, command: 'WindowServer' },
      { pid: 99, pcpu: 0, command: 'Foo Bar' },
    ]);
  });

  test('classifyIdle: idle, busy by process, busy by load, unsure by GPU suspect', () => {
    expect(classifyIdle([{ pid: 1, pcpu: 0.5, command: 'launchd' }], 0.2, 8).verdict).toBe('idle');
    const busy = classifyIdle([{ pid: 2, pcpu: 40, command: 'bun' }], 0.2, 8);
    expect(busy.verdict).toBe('busy');
    expect(busy.reasons[0]).toContain('bun');
    expect(classifyIdle([], 5, 8).verdict).toBe('busy');
    const unsure = classifyIdle([{ pid: 3, pcpu: 3, command: 'WindowServer' }], 0.2, 8);
    expect(unsure.verdict).toBe('unsure');
    expect(unsure.gpuSuspects).toEqual(['WindowServer']);
  });
});
