/** S6: measurement helpers (specs/open-jev-labeler.md §10.2 MeasurePanel, §14 S6). */
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  MEASURE_CUTS,
  SMALL_N_WARNING_BELOW,
  buildMeasureReport,
  percentileOf,
  routingTable,
  type MeasureRow,
} from '../dashboard/ui/src/prelabel/core.js';

const SPIKE = join(import.meta.dir, '..', '..', 'docs', 'spikes', '2026-10-02-open-jev-webgpu');
const spike = JSON.parse(readFileSync(join(SPIKE, 'results', 'open-jev-q4f16-webgpu.json'), 'utf8'));
const spikeRows = spike.workloads['categorize-bare'].results as Array<{ expected: string; pred: string; margin: number; ms: number }>;
const rows: MeasureRow[] = spikeRows.map((r) => ({ label: r.expected, pred: r.pred, margin: r.margin }));

describe('routingTable', () => {
  test('cuts are 0.10 / 0.20 / 0.30 / 0.50 / 0.70', () => {
    expect([...MEASURE_CUTS]).toEqual([0.1, 0.2, 0.3, 0.5, 0.7]);
  });

  test('overall accuracy on the spike categorize-bare results is 30/49', () => {
    const t = routingTable(rows);
    expect(t.n).toBe(49);
    expect(t.correct).toBe(30);
    expect(t.accuracy).toBeCloseTo(30 / 49, 10);
  });

  test('cut 0.30 reproduces the spike: 18 of 19 confident rows correct (95%, 39% coverage)', () => {
    const r = routingTable(rows).rows.find((x) => x.cut === 0.3)!;
    expect(r.auto).toBe(19);
    expect(r.autoCorrect).toBe(18);
    expect(r.autoAccuracy).toBeCloseTo(18 / 19, 10);
    expect(r.autoShare).toBeCloseTo(19 / 49, 10);
    expect(r.reviewShare).toBeCloseTo(30 / 49, 10);
  });

  test('every cut matches an independent filter over the spike rows', () => {
    for (const row of routingTable(rows).rows) {
      const kept = spikeRows.filter((x) => x.margin >= row.cut);
      expect(row.auto).toBe(kept.length);
      expect(row.autoCorrect).toBe(kept.filter((x) => x.pred === x.expected).length);
      expect(row.autoShare + row.reviewShare).toBeCloseTo(1, 10);
    }
  });

  test('a margin exactly at the cut counts as confident', () => {
    const r = routingTable([{ label: 'A', pred: 'A', margin: 0.3 }], [0.3]).rows[0];
    expect(r.auto).toBe(1);
  });

  test('a cut that keeps nothing has null accuracy, not NaN', () => {
    const r = routingTable([{ label: 'A', pred: 'B', margin: 0.05 }], [0.7]).rows[0];
    expect(r.auto).toBe(0);
    expect(r.autoAccuracy).toBeNull();
    expect(r.autoShare).toBe(0);
    expect(r.reviewShare).toBe(1);
  });

  test('no rows: zeros, never NaN', () => {
    const t = routingTable([]);
    expect(t.n).toBe(0);
    expect(t.accuracy).toBe(0);
    for (const r of t.rows) {
      expect(r.autoShare).toBe(0);
      expect(r.reviewShare).toBe(0);
      expect(r.autoAccuracy).toBeNull();
    }
  });

  test('custom cuts', () => {
    expect(routingTable(rows, [0.9]).rows.map((r) => r.cut)).toEqual([0.9]);
  });
});

describe('percentileOf', () => {
  test('nearest rank, order independent', () => {
    expect(percentileOf([90, 10, 50, 30, 70], 0.5)).toBe(50);
    expect(percentileOf([90, 10, 50, 30, 70], 0.95)).toBe(90);
    expect(percentileOf([5], 0.95)).toBe(5);
    expect(percentileOf([], 0.5)).toBe(0);
  });
});

describe('buildMeasureReport', () => {
  const results = spikeRows.slice(0, 5).map((r, i) => ({
    txnId: 100 + i,
    label: r.expected,
    pred: r.pred,
    p1: 0.6,
    p2: 0.6 - r.margin,
    margin: r.margin,
    ms: r.ms,
  }));

  test('per-row {txnId,label,pred,p1,p2,margin,ms} plus the routing table and latency', () => {
    const rep = buildMeasureReport(results, { p50Ms: 80, p95Ms: 90 });
    expect(rep.rows).toHaveLength(5);
    expect(Object.keys(rep.rows[0]).sort()).toEqual(['label', 'margin', 'ms', 'p1', 'p2', 'pred', 'txnId']);
    expect(rep.n).toBe(5);
    expect(rep.table.rows).toHaveLength(5);
    expect(rep.p50Ms).toBe(80);
    expect(rep.p95Ms).toBe(90);
  });

  test('holds no descriptions, merchants or amounts (not a ledger extract)', () => {
    const rep = buildMeasureReport(
      results.map((r) => ({ ...r, description: 'WHOLE FOODS 1234', amount: -42.5, merchant_name: 'Whole Foods' })) as never,
      { p50Ms: 1, p95Ms: 2 },
    );
    const json = JSON.stringify(rep);
    expect(json).not.toContain('WHOLE FOODS');
    expect(json).not.toContain('42.5');
    expect(json).not.toContain('description');
    expect(json).not.toContain('merchant');
    expect(json).not.toContain('amount');
  });

  test('warns about a small n below 200', () => {
    expect(SMALL_N_WARNING_BELOW).toBe(200);
    expect(buildMeasureReport(results, { p50Ms: 1, p95Ms: 1 }).smallN).toBe(true);
    const big = Array.from({ length: 200 }, (_, i) => ({ ...results[0], txnId: i }));
    expect(buildMeasureReport(big, { p50Ms: 1, p95Ms: 1 }).smallN).toBe(false);
  });

  test('records the template and cut context so a saved file is interpretable', () => {
    const rep = buildMeasureReport(results, { p50Ms: 1, p95Ms: 1, context: { modelId: 'm', labelSetVersion: 'cat-18-x', revision: 'r', templateVersion: 'prelabel-tmpl-v1' } });
    expect(rep.context).toEqual({ modelId: 'm', labelSetVersion: 'cat-18-x', revision: 'r', templateVersion: 'prelabel-tmpl-v1' });
  });
});
