import { describe, expect, test } from 'bun:test';
import {
  CUT_GRID,
  armOGuard,
  consistent,
  coverageGain,
  cutCurve,
  dedupeDevRows,
  normalizeQuestion,
  selectCut,
  wilsonLower,
} from '../../scripts/subagent-openjev-cut.mjs';

/**
 * Round 4, slice R4-3 (specs/browser-subagent-round4-openjev-router.md §5): the pure,
 * pre-registered margin-cut selection over the arm-O population A of the DEV sets
 * (v1-burned, v2, v3 and the spike route set; DECISIONS Round 4), and the harness guard
 * that refuses an arm-O run on the current held-out set without the frozen hash.
 */

type Rec = { q: string; label: string; hits: string[]; top1: string; margin: number; source?: string };

const read = (i: number, margin: number, ok = true, extra: Partial<Rec> = {}): Rec => ({
  q: `r${i}`,
  label: 'net_worth',
  hits: [],
  top1: ok ? 'net_worth' : 'forecast',
  margin,
  ...extra,
});
const none = (i: number, margin: number, label = 'none'): Rec => ({ q: `n${i}`, label, hits: [], top1: 'transaction_search', margin });

/** n correct read rows at the given margins. */
const goods = (margins: number[]) => margins.map((m, i) => read(i, m));

describe('grid and helpers', () => {
  test('the grid is 0.05..0.95 in 0.05 steps, exact two-decimal values', () => {
    expect(CUT_GRID.length).toBe(19);
    expect(CUT_GRID[0]).toBe(0.05);
    expect(CUT_GRID[18]).toBe(0.95);
    expect(CUT_GRID).toContain(0.3);
    expect(CUT_GRID).toContain(0.15);
  });

  test('consistency: multi-hit rows need top1 among the hits; 0-hit rows always pass', () => {
    expect(consistent({ hits: [], top1: 'forecast' })).toBe(true);
    expect(consistent({ hits: ['profit_loss', 'spending_summary'], top1: 'profit_loss' })).toBe(true);
    expect(consistent({ hits: ['profit_loss', 'spending_summary'], top1: 'net_worth' })).toBe(false);
  });

  test('normalizeQuestion lowercases and collapses whitespace', () => {
    expect(normalizeQuestion('  What  is my\tNET worth? ')).toBe('what is my net worth?');
  });

  test('wilsonLower is a sane lower bound', () => {
    expect(wilsonLower(20, 20)).toBeGreaterThan(0.8);
    expect(wilsonLower(20, 20)).toBeLessThan(1);
    expect(wilsonLower(0, 0)).toBe(0);
  });
});

describe('dedupeDevRows', () => {
  test('dedupe keeps the first label in set order and records the source', () => {
    const rows = dedupeDevRows([
      { name: 'v1-burned', rows: [{ q: 'What is my Net Worth?', expect: 'net_worth' }] },
      { name: 'v2', rows: [{ q: 'what is my  net worth?', expect: 'none' }, { q: 'other', expect: 'forecast' }] },
      { name: 'spike-route', rows: [{ q: 'OTHER', expect: 'profit_loss' }] },
    ]);
    expect(rows.map((r) => [r.q, r.expect, r.source])).toEqual([
      ['What is my Net Worth?', 'net_worth', 'v1-burned'],
      ['other', 'forecast', 'v2'],
    ]);
  });
});

describe('selectCut', () => {
  test('picks the smallest stable cut', () => {
    // 25 correct rows spread over margins; 1 wrong row at margin 0.12 -> cuts <= 0.10 include an error.
    const recs = [...goods(Array.from({ length: 25 }, (_, i) => 0.2 + i * 0.01)), read(99, 0.12, false)];
    const out = selectCut(recs);
    // At c = 0.15 the wrong row is excluded and all 25 correct rows remain.
    expect(out.cut).toBe(0.15);
    expect(out.chosen.n).toBe(25);
    expect(out.chosen.precision).toBe(1);
    expect(out.chosen.leak).toBe(0);
  });

  test('rejects a cut with a leak (any none/mutation row in S(c)), even at 97%+ precision', () => {
    // 40 correct at high margin, one none row at 0.5 -> every c <= 0.5 leaks.
    const recs = [...goods(Array.from({ length: 40 }, () => 0.9)), none(1, 0.5)];
    const out = selectCut(recs);
    expect(out.cut).toBe(0.55);
    const at05 = out.curve.find((p: { cut: number }) => p.cut === 0.5);
    expect(at05.leak).toBe(1);
  });

  test('a mutation-labelled row counts as a leak too', () => {
    const recs = [...goods(Array.from({ length: 30 }, () => 0.9)), none(2, 0.4, 'mutation')];
    expect(selectCut(recs).cut).toBe(0.45);
  });

  test('rejects a cut with |S| < 20', () => {
    const recs = goods(Array.from({ length: 19 }, () => 0.9));
    const out = selectCut(recs);
    expect(out.cut).toBeNull();
    expect(out.reason).toMatch(/no viable cut/);
  });

  test('the stability rule skips a lucky dip', () => {
    // At c = 0.2 the set is clean (the wrong row sits at 0.1), but at c = 0.6 a second wrong row
    // (margin 0.65) brings precision under 97% among the few rows that remain above it.
    const highGood = Array.from({ length: 10 }, (_, i) => read(100 + i, 0.7 + i * 0.01));
    const recs = [...goods(Array.from({ length: 30 }, () => 0.3)), read(98, 0.1, false), read(97, 0.65, false), ...highGood];
    const out = selectCut(recs);
    // c in 0.15..0.65 includes the 0.65 wrong row; 0.15..0.30 has 40/41 = 97.6% (passes alone) but
    // 0.35..0.65 has 10/11 = 90.9%, so the stability rule rejects every c <= 0.65.
    const at02 = out.curve.find((p: { cut: number }) => p.cut === 0.2);
    expect(at02.precision).toBeGreaterThanOrEqual(0.97);
    expect(out.cut).toBe(null); // above 0.65 only 10 rows remain (< 20)
  });

  test('stability treats an empty S(c) as error-free (nothing is answered there)', () => {
    const recs = goods(Array.from({ length: 25 }, () => 0.5));
    const out = selectCut(recs);
    expect(out.cut).toBe(0.05);
    const top = out.curve.find((p: { cut: number }) => p.cut === 0.95);
    expect(top.n).toBe(0);
  });

  test('inconsistent multi-hit rows are excluded from S(c), not counted as errors', () => {
    const bad = { q: 'x', label: 'none', hits: ['profit_loss', 'spending_summary'], top1: 'net_worth', margin: 0.9 };
    const recs = [...goods(Array.from({ length: 25 }, () => 0.9)), bad];
    expect(selectCut(recs).cut).toBe(0.05);
  });

  test('returns null when nothing qualifies', () => {
    const recs = [...goods(Array.from({ length: 25 }, () => 0.9)), none(1, 0.95)];
    const out = selectCut(recs);
    expect(out.cut).toBeNull();
    expect(out.chosen).toBeNull();
  });
});

describe('coverageGain', () => {
  test('counts read rows newly routed correctly at the cut, per tool and per source, over all dev read rows', () => {
    const recs: Rec[] = [
      read(1, 0.9, true, { source: 'v2' }),
      read(2, 0.9, false, { source: 'v2' }),
      { ...read(3, 0.2, true, { source: 'v3' }) },
      { q: 'p', label: 'profit_loss', hits: [], top1: 'profit_loss', margin: 0.8, source: 'v3' },
    ];
    const g = coverageGain(recs, 0.5, { total: 10, byTool: { net_worth: 6, profit_loss: 4 }, bySource: { v2: 5, v3: 5 } });
    expect(g.rows).toBe(2);
    expect(g.share).toBeCloseTo(0.2);
    expect(g.byTool.net_worth).toEqual({ gained: 1, of: 6 });
    expect(g.byTool.profit_loss).toEqual({ gained: 1, of: 4 });
    expect(g.bySource.v2).toEqual({ gained: 1, of: 5 });
    expect(g.bySource.v3).toEqual({ gained: 1, of: 5 });
    expect(coverageGain(recs, null, { total: 10, byTool: {}, bySource: {} }).rows).toBe(0);
  });
});

describe('armOGuard: the harness refuses arm O on the current held-out set without the frozen hash', () => {
  const frozen = { sha: 'a'.repeat(64), cut: 0.4 };
  test('dev sets (v1-burned, v2, v3) need no hash', () => {
    for (const p of ['specs/eval/heldout-router.v1-burned.jsonl', 'specs/eval/heldout-router.v2.jsonl', '/x/specs/eval/heldout-router.v3.jsonl']) {
      expect(armOGuard({ heldoutPath: p, frozenShaArg: null, frozen: null })).toBeNull();
    }
  });

  test('heldout-router.v4* is refused without --frozen-sha, with a wrong one, or when the frozen file is missing', () => {
    const p = 'specs/eval/heldout-router.v4.jsonl';
    expect(armOGuard({ heldoutPath: p, frozenShaArg: null, frozen })).toMatch(/frozen-sha/);
    expect(armOGuard({ heldoutPath: p, frozenShaArg: 'b'.repeat(64), frozen })).toMatch(/does not match/);
    expect(armOGuard({ heldoutPath: p, frozenShaArg: frozen.sha, frozen: null })).toMatch(/missing/);
    expect(armOGuard({ heldoutPath: 'specs/eval/heldout-router.v4-extra.jsonl', frozenShaArg: null, frozen })).toMatch(/frozen-sha/);
    expect(armOGuard({ heldoutPath: 'specs/eval/heldout-router.v5.jsonl', frozenShaArg: null, frozen })).toMatch(/frozen-sha/);
  });

  test('heldout-router.v4 is refused when the frozen cut is null (arm O disabled: skip the run)', () => {
    expect(armOGuard({ heldoutPath: 'specs/eval/heldout-router.v4.jsonl', frozenShaArg: frozen.sha, frozen: { sha: frozen.sha, cut: null } })).toMatch(/disabled/);
  });

  test('heldout-router.v4 with the matching hash is allowed', () => {
    expect(armOGuard({ heldoutPath: 'specs/eval/heldout-router.v4.jsonl', frozenShaArg: frozen.sha, frozen })).toBeNull();
  });
});

describe('the eval harness applies the guard before it opens the held-out file', () => {
  test('--arm O on a heldout-router.v4 path without --frozen-sha exits 8 and never reads the file', () => {
    const { mkdtempSync, rmSync } = require('node:fs') as typeof import('node:fs');
    const { join } = require('node:path') as typeof import('node:path');
    const { tmpdir } = require('node:os') as typeof import('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'armo-guard-'));
    try {
      // The path does not exist: if the harness read it first, it would crash with ENOENT (exit 1), not 8.
      const missing = join(dir, 'heldout-router.v4.jsonl');
      const script = new URL('../../scripts/subagent-route-eval.mjs', import.meta.url).pathname;
      const r = Bun.spawnSync(['node', script, '--arm', 'O', '--sets', 'heldout', '--heldout', missing, '--out', join(dir, 'out')]);
      expect(r.exitCode).toBe(8);
      expect(new TextDecoder().decode(r.stderr)).toContain('--frozen-sha');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
