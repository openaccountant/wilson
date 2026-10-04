import { describe, expect, test } from 'bun:test';
import { CATEGORIES } from '../tools/categorize/categories.js';
import { keywordRoute, runSubagent, type GenerateRequest, type SubagentDeps, type SubagentInput } from '../dashboard/ui/src/hybrid/subagent-core.js';
import { OPEN_JEV_ROUTE_CUT } from '../dashboard/ui/src/hybrid/openjev-route.js';
import { DEFAULT_SUBAGENT_LIMITS, type RouteHint, type StepEvent, type SubagentOutcome } from '../dashboard/ui/src/hybrid/worker-protocol.js';
import type { ToolReadResult } from '../dashboard/ui/src/store/mirror-tools.js';

/**
 * Round 4, slice R4-2 (specs/browser-subagent-round4-openjev-router.md §4.3): the core
 * accepts an open-jev route hint from the main thread, but RE-CHECKS it. A hint is
 * honoured only when the keyword router gives != 1 hit, the tool is a read tool, the
 * margin is finite and >= the cut, the cut equals the frozen OPEN_JEV_ROUTE_CUT, and on
 * a multi-hit the tool is one of the hits. Anything else is router-none. Template mode
 * never calls the model.
 */

const CUT = 0.35;

const PNL: ToolReadResult = {
  servable: true,
  profile: 'default',
  data: { period: 'June 2026', totalIncome: 5000, totalExpenses: 2000, netProfit: 3000, formatted: 'P&L June 2026\nNet: $3,000.00' },
  summary: 'P&L June 2026\nIncome: $5,000.00\nExpenses: $2,000.00\nNet: $3,000.00',
};

/** routeCut is the core's test seam for the frozen cut; omitted = the real frozen constant. */
function rig(routeCut?: number | null) {
  const gens: GenerateRequest[] = [];
  const reads: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const events: StepEvent[] = [];
  const deps: SubagentDeps = {
    generate: async (req) => {
      gens.push(req);
      return 'Net profit was $3,000.00.';
    },
    toolRead: async (req) => {
      reads.push({ tool: req.tool, args: req.args });
      return PNL;
    },
    status: async () => ({ profile: 'default', seeded: true, lastSyncedAt: '2026-07-15T11:59:00.000Z', schemaVersion: 3, servable: ['profit_loss'], categories: CATEGORIES }),
    now: () => Date.now(),
    emit: (e) => events.push(e),
    ...(routeCut !== undefined ? { routeCut } : {}),
  };
  const run = (query: string, routeHint?: RouteHint): Promise<SubagentOutcome> => {
    const input: SubagentInput = { query, nowIso: '2026-07-15T12:00:00.000Z', expectedProfile: 'default', priorLocalTurns: [], limits: { ...DEFAULT_SUBAGENT_LIMITS } };
    if (routeHint) input.routeHint = routeHint;
    return runSubagent(deps, input);
  };
  return { run, gens, reads, events };
}

const ZERO = 'What was my income last month?';
const MULTI = 'P&L by category for this month';
const SINGLE = 'Give me a P&L for June';

function hint(tool: string, margin: number, query: string, cut = CUT): RouteHint {
  return { tool, margin, cut, hits: keywordRoute(query) };
}

const routeEvents = (events: StepEvent[]) => events.filter((e) => e.kind === 'route');

describe('core: open-jev route hint', () => {
  test('fixtures have the hit counts the tests assume', () => {
    expect(keywordRoute(ZERO)).toEqual([]);
    expect(keywordRoute(MULTI).length).toBe(2);
    expect(keywordRoute(MULTI)).toContain('profit_loss');
    expect(keywordRoute(SINGLE)).toEqual(['profit_loss']);
  });

  test('a hint with exactly 1 keyword hit is ignored: the keyword tool runs, via keyword', async () => {
    const r = rig(CUT);
    const out = await r.run(SINGLE, hint('net_worth', 0.9, SINGLE));
    expect(out.kind).toBe('answer');
    expect(r.reads.map((x) => x.tool)).toEqual(['profit_loss']);
    expect(routeEvents(r.events)).toEqual([{ kind: 'route', tool: 'profit_loss', via: 'keyword' }]);
  });

  test('a valid 0-hit hint executes exactly one tool, emits via openjev with margin and cut, and never calls the model', async () => {
    const r = rig(CUT);
    const out = await r.run(ZERO, hint('profit_loss', 0.6, ZERO));
    expect(out.kind).toBe('answer');
    expect(r.reads.map((x) => x.tool)).toEqual(['profit_loss']);
    expect(routeEvents(r.events)).toEqual([{ kind: 'route', tool: 'profit_loss', via: 'openjev', margin: 0.6, cut: CUT }]);
    expect(r.gens).toEqual([]);
  });

  test('a valid multi-hit hint (top1 is one of the hits) runs that tool', async () => {
    const r = rig(CUT);
    const out = await r.run(MULTI, hint('profit_loss', 0.5, MULTI));
    expect(out.kind).toBe('answer');
    expect(r.reads.map((x) => x.tool)).toEqual(['profit_loss']);
    expect(r.gens).toEqual([]);
  });

  const forged: Array<[string, string, RouteHint]> = [
    ['cut differs from the frozen cut', ZERO, hint('profit_loss', 0.9, ZERO, 0.05)],
    ['margin below the cut', ZERO, hint('profit_loss', CUT - 0.01, ZERO)],
    ['NaN margin', ZERO, { ...hint('profit_loss', 0.9, ZERO), margin: Number.NaN }],
    ['tool outside the hits on a multi-hit', MULTI, hint('net_worth', 0.9, MULTI)],
    ['tool is none', ZERO, hint('none', 0.9, ZERO)],
    ['tool is a mutation tool', ZERO, hint('edit_transaction', 0.9, ZERO)],
    ['hint hits disagree with the core', ZERO, { ...hint('profit_loss', 0.9, ZERO), hits: ['profit_loss'] }],
  ];
  for (const [name, q, h] of forged) {
    test(`forged hint (${name}) hands off as router-none with no tool read and no model call`, async () => {
      const r = rig(CUT);
      const out = await r.run(q, h);
      expect(out.kind).toBe('handoff');
      if (out.kind !== 'handoff') return;
      expect(out.reason).toBe('router-none');
      expect(out.handoff.steps).toEqual([]);
      expect(r.reads).toEqual([]);
      expect(r.gens).toEqual([]);
      const ev = routeEvents(r.events);
      expect(ev.length).toBe(1);
      expect(ev[0]).toMatchObject({ kind: 'route', tool: 'none' });
    });
  }

  test('with the real frozen cut: a hint is honoured only if its cut equals OPEN_JEV_ROUTE_CUT (null = arm O off)', async () => {
    const r = rig();
    const cut = OPEN_JEV_ROUTE_CUT ?? 0.5;
    const out = await r.run(ZERO, hint('profit_loss', 0.99, ZERO, cut));
    if (OPEN_JEV_ROUTE_CUT === null) {
      expect(out.kind).toBe('handoff');
      expect(r.reads).toEqual([]);
    } else {
      expect(out.kind).toBe('answer');
      expect(r.reads.map((x) => x.tool)).toEqual(['profit_loss']);
    }
  });

  test('a route cut seam of null (arm O disabled) rejects every hint', async () => {
    const r = rig(null);
    const out = await r.run(ZERO, hint('profit_loss', 0.99, ZERO, 0.5));
    expect(out.kind).toBe('handoff');
    expect(r.reads).toEqual([]);
  });

  test('a hint never bypasses the gate or the what-if / comparison rule', async () => {
    const mutation = rig(CUT);
    const m = await mutation.run('Recategorize the Netflix charge as Entertainment', { tool: 'transaction_search', margin: 0.9, cut: CUT, hits: [] });
    expect(m.kind === 'handoff' && m.reason).toBe('mutation-intent');
    expect(mutation.reads).toEqual([]);

    const cmp = rig(CUT);
    const q = 'compare my spending to last month';
    const c = await cmp.run(q, hint('spending_summary', 0.9, q));
    expect(c.kind === 'handoff' && c.reason).toBe('router-none');
    expect(cmp.reads).toEqual([]);
  });

  test('no hint on a 0-hit question is round 3, byte for byte (router-none, via keyword)', async () => {
    const r = rig(CUT);
    const out = await r.run(ZERO);
    expect(out.kind === 'handoff' && out.reason).toBe('router-none');
    expect(routeEvents(r.events)).toEqual([{ kind: 'route', tool: 'none', via: 'keyword' }]);
  });

  test('a junk hint object never throws and hands off', async () => {
    for (const junk of [{}, { tool: 5 }, { tool: 'profit_loss', margin: 0.9, cut: CUT, hits: 'x' }, null]) {
      const r = rig(CUT);
      const out = await r.run(ZERO, junk as unknown as RouteHint);
      expect(out.kind).toBe('handoff');
      expect(r.reads).toEqual([]);
    }
  });
});
