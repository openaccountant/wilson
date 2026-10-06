/**
 * Round-3 measurement tooling (no product code). Pure; pinned by src/__tests__/subagent-route-round3.test.ts.
 *  - buildBlind: one opaque, shuffled line per locally answered (row, arm) for a grader who must not know the arm,
 *    plus the id -> arm key kept in a separate file.
 *  - armBars: bars 1, 4 and 5 (DECISIONS Round 2, unchanged by Round 3) for one arm's records.
 */
import { percentile, scoreSet } from './subagent-route-score.mjs';

const pct = (n, d) => (d === 0 ? null : (100 * n) / d);
const diverted = (r) => r.gate !== 'route' || r.route === 'none' || r.route === null;
const stat = (xs) => ({ n: xs.length, p50: percentile(xs, 50), p95: percentile(xs, 95), max: xs.length ? Math.max(...xs) : null });

/** arms: { [armName]: records[] } over the same rows in the same order. rand: () => [0,1). */
export function buildBlind(arms, rand = Math.random) {
  const names = Object.keys(arms);
  const n = arms[names[0]].length;
  for (const a of names) {
    if (arms[a].length !== n) throw new Error(`arm ${a} has ${arms[a].length} rows, expected ${n}: rows must line up`);
    arms[a].forEach((r, i) => {
      const ref = arms[names[0]][i];
      if (r.q !== ref.q || (r.persona ?? null) !== (ref.persona ?? null)) throw new Error(`row ${i} differs between arms ${names[0]} and ${a}`);
    });
  }
  const used = new Set();
  const newId = () => {
    for (;;) {
      let id = '';
      while (id.length < 10) id += Math.floor(rand() * 16).toString(16);
      if (!used.has(id)) { used.add(id); return id; }
    }
  };
  const items = [];
  for (const arm of names) {
    arms[arm].forEach((r, row) => {
      if (r.outcome !== 'answer') return;
      const t = (r.tools ?? [])[0];
      items.push({
        arm, row, q: r.q,
        line: { q: r.q, expect: r.expect, answerNotes: r.answerNotes ?? null, tool: t?.tool ?? r.route, args: t?.args ?? null, toolResult: t?.result ?? null, answer: r.text },
      });
    });
  }
  // Fisher-Yates
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  const blind = [];
  const key = {};
  for (const it of items) {
    const id = newId();
    blind.push({ id, ...it.line });
    key[id] = { arm: it.arm, row: it.row, q: it.q, persona: arms[it.arm][it.row].persona ?? null };
  }
  return { blind, key };
}

export const blindLines = (blind) => blind.map((b) => JSON.stringify(b)).join('\n') + '\n';

/** Bars 1, 4 and 5 for one arm's records. Bar 1 uses the row's own `mutation` field (set by the v3 writer). */
export function armBars(records) {
  const base = scoreSet(records);
  const none = records.filter((r) => r.expect === 'none');
  const mutation = none.filter((r) => r.mutation);
  const verbless = mutation.filter((r) => r.denylist === false);
  const read = records.filter((r) => r.expect !== 'none');
  const answeredRead = read.filter((r) => r.outcome === 'answer').length;
  const handoffs = records.filter((r) => r.outcome === 'handoff' && typeof r.ms === 'number');
  return {
    bar1: {
      noneRows: none.length,
      diverted: none.filter(diverted).length,
      divertedPct: pct(none.filter(diverted).length, none.length),
      notAnsweredLocally: none.filter((r) => r.outcome !== 'answer').length,
      reachedReadTool: none.filter((r) => !diverted(r)).map((r) => r.q),
      answeredLocally: none.filter((r) => r.outcome === 'answer').map((r) => r.q),
      mutationRows: mutation.length,
      mutationDiverted: mutation.filter(diverted).length,
      verblessMutationRows: verbless.length,
      verblessDiverted: verbless.filter(diverted).length,
      undivertedMutation: mutation.filter((r) => !diverted(r)).map((r) => r.q),
    },
    bar4: { readRows: read.length, answered: answeredRead, pct: pct(answeredRead, read.length) },
    bar5: { barPaths: base.c15, allHandoffs: stat(handoffs.map((r) => r.ms)) },
    base,
  };
}
