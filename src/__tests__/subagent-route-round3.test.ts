import { describe, expect, test } from 'bun:test';
import { armBars, blindLines, buildBlind } from '../../scripts/subagent-route-round3.mjs';

/** Round-3 measurement tooling (no product code): blinded grading file + per-arm bars 1, 4, 5. */
const rec = (o: { q: string; expect: string } & Record<string, unknown>) => ({
  persona: 'p', answerNotes: 'notes', hits: [], route: null, via: null, outcome: 'handoff', reason: null, gate: 'route', mutation: false, ...o,
});
const tool = (result: unknown) => [{ tool: 'spending_summary', args: { period: 'last month' }, result }];

const mk = (arm: string): any[] => [
  rec({ q: 'dup', persona: 'a', expect: 'net_worth', route: 'net_worth', outcome: 'answer', text: `${arm} answer 1`, tools: tool({ summary: 'S1' }), ms: 300 }),
  rec({ q: 'dup', persona: 'b', expect: 'net_worth', route: 'net_worth', outcome: 'answer', text: `${arm} answer 2`, tools: tool({ summary: 'S2' }), ms: 300 }),
  rec({ q: 'h', expect: 'forecast', route: 'forecast', reason: 'empty-result', ms: 3 }),
  rec({ q: 'g', expect: 'forecast', gate: 'non-data', ms: 0 }),
  rec({ q: 'm1', expect: 'none', gate: 'mutation-intent', mutation: true, denylist: true, ms: 0 }),
  rec({ q: 'm2', expect: 'none', gate: 'non-data', mutation: true, denylist: false, ms: 0 }),
  rec({ q: 'n1', expect: 'none', gate: 'route', route: 'none', reason: 'router-none', ms: 1 }),
];
const arms = { T: mk('T'), M6: mk('M6'), M17: mk('M17') };

describe('buildBlind', () => {
  let seed = 12345; // deterministic LCG
  const rand = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
  const { blind, key } = buildBlind(arms, rand);

  test('one line per locally answered (row, arm), no arm information in the blinded lines', () => {
    expect(blind).toHaveLength(6);
    for (const b of blind) {
      expect(Object.keys(b).sort()).toEqual(['answer', 'answerNotes', 'args', 'expect', 'id', 'q', 'tool', 'toolResult']);
      expect(JSON.stringify(b)).not.toMatch(/"(arm|M6|M17)"/);
    }
    expect(new Set(blind.map((b: any) => b.id)).size).toBe(6);
    for (const b of blind) expect(b.id).toMatch(/^[0-9a-f]{10}$/);
  });

  test('key maps every id to its arm and row index (same q in two personas stays distinct)', () => {
    expect(Object.keys(key).sort()).toEqual(blind.map((b: any) => b.id).sort());
    for (const b of blind) {
      const k = key[b.id];
      expect(b.answer).toBe(`${k.arm} answer ${k.row + 1}`);
      expect(k.q).toBe('dup');
      expect(['T', 'M6', 'M17']).toContain(k.arm);
    }
    expect(blind[0].toolResult).toEqual({ summary: expect.stringMatching(/^S[12]$/) });
  });

  test('order is shuffled, not grouped by arm', () => {
    const order = blind.map((b: any) => key[b.id].arm).join(',');
    expect(order).not.toBe('T,T,M6,M6,M17,M17');
  });

  test('blindLines serialises one JSON object per line', () => {
    const txt = blindLines(blind);
    expect(txt.trim().split('\n')).toHaveLength(6);
    expect(JSON.parse(txt.split('\n')[0]).id).toBe(blind[0].id);
  });

  test('rejects arms whose rows do not line up', () => {
    expect(() => buildBlind({ T: mk('T'), M6: mk('M6').slice(1) }, Math.random)).toThrow(/row/i);
  });
});

describe('armBars', () => {
  const b = armBars(mk('T'));
  test('bar 1: diverted share of none rows and verb-less mutation rows', () => {
    expect(b.bar1).toMatchObject({ noneRows: 3, diverted: 3, divertedPct: 100, mutationRows: 2, verblessMutationRows: 1, verblessDiverted: 1 });
  });
  test('bar 4: coverage of read rows answered locally', () => {
    expect(b.bar4).toMatchObject({ readRows: 4, answered: 2, pct: 50 });
  });
  test('bar 5: p95 time to handoff on gated, router-none and args-unfillable paths', () => {
    expect(b.bar5.barPaths.n).toBe(4);
    expect(b.bar5.allHandoffs.n).toBe(5);
  });
});
