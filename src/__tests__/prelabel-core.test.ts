/** S1: pure core of the open-jev pre-labeler (specs/open-jev-labeler.md §6, §7, §14). */
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_MARGIN_CUT,
  buildQuestion,
  cacheKey,
  estimateRunMs,
  formatMargin,
  formatState,
  marginOf,
  orderByLane,
  routeLane,
  topTwo,
  type LaneResult,
} from '../dashboard/ui/src/prelabel/core.js';

const SPIKE = join(import.meta.dir, '..', '..', 'docs', 'spikes', '2026-10-02-open-jev-webgpu');
const gold = JSON.parse(readFileSync(join(SPIKE, 'harness', 'gold', 'categorize.json'), 'utf8')) as Array<{
  description: string;
  amount: number;
  date: string;
  expected: string;
}>;
const spike = JSON.parse(readFileSync(join(SPIKE, 'results', 'open-jev-q4f16-webgpu.json'), 'utf8'));
const spikeRows = spike.workloads['categorize-bare'].results as Array<{
  expected: string;
  pred: string;
  margin: number;
  top3: Array<[string, number]>;
}>;

// The spike's formatter, verbatim (harness/web/main.js `fmtTx`).
const spikeFmtTx = (r: { description: string; amount: number; date: string }) =>
  `description: ${r.description} | amount: ${r.amount.toFixed(2)} | date: ${r.date}`;

describe('formatState', () => {
  test('equals the spike fmtTx byte-for-byte on 3 gold rows (sign and toFixed(2))', () => {
    for (const r of gold.slice(0, 3)) {
      expect(formatState(r)).toBe(spikeFmtTx(r));
    }
    expect(formatState(gold[0])).toBe('description: CLIENT PAYMT - STONEBRIDGE CONSULTING | amount: 2400.00 | date: 2026-06-01');
    expect(formatState(gold[1])).toBe('description: RENT PAYMENT | amount: -1800.00 | date: 2026-06-02');
    expect(formatState(gold[2])).toBe('description: WHOLE FOODS MARKET | amount: -142.33 | date: 2026-06-03');
  });

  test('matches the spike across all 49 gold rows', () => {
    for (const r of gold) expect(formatState(r)).toBe(spikeFmtTx(r));
  });

  test('date is sliced to YYYY-MM-DD', () => {
    expect(formatState({ description: 'X', amount: 1, date: '2026-06-01T12:34:56.000Z' })).toBe(
      'description: X | amount: 1.00 | date: 2026-06-01',
    );
    expect(formatState({ description: 'X', amount: 1, date: '2026-06-01 09:00:00' })).toBe(
      'description: X | amount: 1.00 | date: 2026-06-01',
    );
  });
});

describe('buildQuestion', () => {
  const labels = ['Dining', 'Groceries', 'Other'];

  test('uses the spike question and bare label options in the given order', () => {
    const q = buildQuestion(labels);
    expect(q.question).toBe('Which spending category does this transaction belong to?');
    expect(q.options).toEqual(labels);
  });

  test('returns a copy so callers cannot mutate the label set', () => {
    const q = buildQuestion(labels);
    q.options.push('Hacked');
    expect(labels).toEqual(['Dining', 'Groceries', 'Other']);
  });
});

describe('marginOf / topTwo', () => {
  test('marginOf on the spike top3 rows reproduces the spike margin within rounding', () => {
    expect(spikeRows.length).toBe(49);
    for (const row of spikeRows) {
      expect(Math.abs(marginOf(Object.fromEntries(row.top3)) - row.margin)).toBeLessThan(1e-3);
    }
  });

  test('is p1 - p2 over the two largest probabilities regardless of key order', () => {
    expect(marginOf({ a: 0.1, b: 0.5, c: 0.3 })).toBeCloseTo(0.2, 12);
    expect(marginOf({ c: 0.3, a: 0.1, b: 0.5 })).toBeCloseTo(0.2, 12);
  });

  test('a single option has p2 = 0 (spike definition)', () => {
    expect(marginOf({ only: 0.8 })).toBeCloseTo(0.8, 12);
  });

  test('topTwo returns the two best entries; null with fewer than two', () => {
    const t = topTwo({ a: 0.1, b: 0.5, c: 0.3 });
    expect(t).toEqual({ top2: [['b', 0.5], ['c', 0.3]], p1: 0.5, p2: 0.3, margin: 0.5 - 0.3 });
    expect(topTwo({ only: 1 })).toBeNull();
    expect(topTwo({})).toBeNull();
  });

  test('ties keep insertion order (stable)', () => {
    expect(topTwo({ x: 0.4, y: 0.4, z: 0.2 })!.top2.map((e) => e[0])).toEqual(['x', 'y']);
  });
});

describe('formatMargin', () => {
  test('two decimals, leading zero dropped below 1', () => {
    expect(formatMargin(0.42)).toBe('.42');
    expect(formatMargin(0.08)).toBe('.08');
    expect(formatMargin(0)).toBe('.00');
    expect(formatMargin(1)).toBe('1.00');
  });
});

describe('routeLane (spec §6, B1-a column)', () => {
  const cut = 0.3;
  const ok = (choice: string, margin: number): LaneResult => ({ ok: true, choice, margin });

  test('default cut is 0.3', () => {
    expect(DEFAULT_MARGIN_CUT).toBe(0.3);
  });

  test('no result yet -> ATTENTION, chip "JEV —"', () => {
    expect(routeLane('Dining', undefined, cut)).toEqual({ lane: 'ATTENTION', kind: 'none', chip: 'JEV —' });
  });

  test('ok:false -> ATTENTION, chip "JEV SKIPPED"', () => {
    expect(routeLane('Dining', { ok: false }, cut)).toEqual({ lane: 'ATTENTION', kind: 'skipped', chip: 'JEV SKIPPED' });
  });

  test('margin < cut -> ATTENTION UNSURE, whether or not it matches the suggestion', () => {
    expect(routeLane('Dining', ok('Dining', 0.08), cut)).toEqual({ lane: 'ATTENTION', kind: 'unsure', chip: 'JEV UNSURE · M .08' });
    expect(routeLane('Dining', ok('Travel', 0.29), cut)).toEqual({ lane: 'ATTENTION', kind: 'unsure', chip: 'JEV UNSURE · M .29' });
  });

  test('margin >= cut and choice === suggested -> QUICK AGREES', () => {
    expect(routeLane('Dining', ok('Dining', 0.42), cut)).toEqual({ lane: 'QUICK', kind: 'agrees', chip: 'JEV AGREES · M .42' });
  });

  test('margin exactly at the cut counts as confident', () => {
    expect(routeLane('Dining', ok('Dining', 0.3), cut).lane).toBe('QUICK');
  });

  test('margin >= cut and choice !== suggested -> ATTENTION DISAGREES; the alternative is never in the chip', () => {
    const r = routeLane('Dining', ok('Travel', 0.55), cut);
    expect(r).toEqual({ lane: 'ATTENTION', kind: 'disagrees', chip: 'JEV DISAGREES' });
    expect(r.chip).not.toContain('Travel');
  });

  test('a missing suggestion can never agree', () => {
    expect(routeLane(null, ok('Dining', 0.9), cut).kind).toBe('disagrees');
    expect(routeLane('', ok('Dining', 0.9), cut).kind).toBe('disagrees');
  });

  test('a higher cut moves rows from QUICK back to ATTENTION', () => {
    expect(routeLane('Dining', ok('Dining', 0.42), 0.5).kind).toBe('unsure');
  });
});

describe('orderByLane (spec §6 ordering)', () => {
  type Row = { transaction_id: number; suggested_category: string };
  const rows: Row[] = [
    { transaction_id: 1, suggested_category: 'A' }, // agrees .40
    { transaction_id: 2, suggested_category: 'A' }, // unsure .20
    { transaction_id: 3, suggested_category: 'A' }, // not scored
    { transaction_id: 4, suggested_category: 'A' }, // disagrees .60
    { transaction_id: 5, suggested_category: 'A' }, // agrees .90
    { transaction_id: 6, suggested_category: 'A' }, // unsure .05
    { transaction_id: 7, suggested_category: 'A' }, // skipped
    { transaction_id: 8, suggested_category: 'A' }, // disagrees .35
    { transaction_id: 9, suggested_category: 'A' }, // agrees .40 (tie with 1)
    { transaction_id: 10, suggested_category: 'A' }, // not scored
  ];
  const results = new Map<number, LaneResult>([
    [1, { ok: true, choice: 'A', margin: 0.4 }],
    [2, { ok: true, choice: 'A', margin: 0.2 }],
    [4, { ok: true, choice: 'B', margin: 0.6 }],
    [5, { ok: true, choice: 'A', margin: 0.9 }],
    [6, { ok: true, choice: 'A', margin: 0.05 }],
    [7, { ok: false }],
    [8, { ok: true, choice: 'B', margin: 0.35 }],
    [9, { ok: true, choice: 'A', margin: 0.4 }],
  ]);

  test('ATTENTION first (DISAGREES, UNSURE ascending margin, then unscored/skipped in input order), then QUICK by descending margin', () => {
    const out = orderByLane(rows, results, 0.3);
    expect(out.map((e) => e.item.transaction_id)).toEqual([
      4, 8, // disagrees, input order
      6, 2, // unsure, ascending margin
      3, 7, 10, // not scored + skipped, input order
      5, 1, 9, // quick, descending margin; tie 1 before 9
    ]);
    expect(out.map((e) => e.route.lane)).toEqual([
      'ATTENTION', 'ATTENTION', 'ATTENTION', 'ATTENTION', 'ATTENTION', 'ATTENTION', 'ATTENTION',
      'QUICK', 'QUICK', 'QUICK',
    ]);
  });

  test('with no results it returns the input order unchanged', () => {
    const out = orderByLane(rows, new Map(), 0.3);
    expect(out.map((e) => e.item.transaction_id)).toEqual(rows.map((r) => r.transaction_id));
    expect(out.every((e) => e.route.kind === 'none')).toBe(true);
  });

  test('is stable and does not mutate its input', () => {
    const copy = rows.map((r) => ({ ...r }));
    const a = orderByLane(rows, results, 0.3).map((e) => e.item.transaction_id);
    const b = orderByLane(rows, results, 0.3).map((e) => e.item.transaction_id);
    expect(a).toEqual(b);
    expect(rows).toEqual(copy);
  });

  test('items are passed through by reference', () => {
    const out = orderByLane(rows, results, 0.3);
    expect(out.find((e) => e.item.transaction_id === 4)!.item).toBe(rows[3]);
  });

  test('empty input', () => {
    expect(orderByLane([], new Map(), 0.3)).toEqual([]);
  });
});

describe('cacheKey', () => {
  test('is wilson-prelabel:v1:<profile>:<labelSetVersion>:<modelId>:<revision>:<templateVersion>', () => {
    expect(
      cacheKey({
        profile: 'default',
        labelSetVersion: 'cat-18-0f7b02225108',
        modelId: 'onnx-community/open-jev-deberta-v3-large-ONNX:q4f16',
        revision: '7c79f25b5ac496089f448a969c801872ad59d31c',
        templateVersion: 'prelabel-tmpl-v1',
      }),
    ).toBe(
      'wilson-prelabel:v1:default:cat-18-0f7b02225108:onnx-community/open-jev-deberta-v3-large-ONNX:q4f16:7c79f25b5ac496089f448a969c801872ad59d31c:prelabel-tmpl-v1',
    );
  });

  test('changes when any component changes', () => {
    const base = { profile: 'p', labelSetVersion: 'l', modelId: 'm', revision: 'r', templateVersion: 't' };
    const k = cacheKey(base);
    for (const f of Object.keys(base) as Array<keyof typeof base>) {
      expect(cacheKey({ ...base, [f]: 'other' })).not.toBe(k);
    }
  });
});

describe('estimateRunMs', () => {
  test('2,000 rows falls in [134 s, 216 s] at 67-86 ms/row with +25% noise (spec §7)', () => {
    const e = estimateRunMs(2000);
    expect(e.lowMs).toBeGreaterThanOrEqual(134_000);
    expect(e.highMs).toBeLessThanOrEqual(216_000);
    expect(e.lowMs).toBeLessThanOrEqual(e.expectedMs);
    expect(e.expectedMs).toBeLessThanOrEqual(e.highMs);
  });

  test('matches the §7 table for 49 and 200 rows', () => {
    const a = estimateRunMs(49);
    expect(a.lowMs / 1000).toBeCloseTo(3.283, 2); // 49 * 67 ms
    expect(a.highMs / 1000).toBeLessThanOrEqual(5.3);
    const b = estimateRunMs(200);
    expect(b.lowMs / 1000).toBeCloseTo(13.4, 1);
    expect(b.highMs / 1000).toBeLessThanOrEqual(21.5);
  });

  test('zero, negative and non-finite row counts estimate zero', () => {
    for (const n of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(estimateRunMs(n)).toEqual({ lowMs: 0, expectedMs: 0, highMs: 0 });
    }
  });
});
