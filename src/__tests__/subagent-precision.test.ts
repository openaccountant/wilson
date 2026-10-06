import { describe, expect, test } from 'bun:test';
import { CATEGORIES } from '../tools/categorize/categories.js';
import * as core from '../dashboard/ui/src/hybrid/subagent-core.js';
import {
  keywordRoute,
  runSubagent,
  type GenerateRequest,
  type SubagentDeps,
} from '../dashboard/ui/src/hybrid/subagent-core.js';
import { DEFAULT_SUBAGENT_LIMITS, type StepEvent, type SubagentOutcome } from '../dashboard/ui/src/hybrid/worker-protocol.js';
import type { ToolReadResult } from '../dashboard/ui/src/store/mirror-tools.js';

/**
 * Round 2, PRECISION-FIRST mode (specs/DECISIONS.md "Round 2"): answer locally only
 * when the keyword router has EXACTLY ONE match. Zero or several matches hand off to
 * the server, and the 0.6B model never chooses a tool: it only composes from results.
 */

const PNL: ToolReadResult = {
  servable: true,
  profile: 'default',
  data: { period: 'June 2026', totalIncome: 5000, totalExpenses: 2000, netProfit: 3000, formatted: 'P&L June 2026\nNet: $3,000.00' },
  summary: 'P&L June 2026\nIncome: $5,000.00\nExpenses: $2,000.00\nNet: $3,000.00',
};

function rig(opts: { llm?: (req: GenerateRequest) => string } = {}) {
  const gens: GenerateRequest[] = [];
  const reads: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const events: StepEvent[] = [];
  let statusCalls = 0;
  const deps: SubagentDeps = {
    // A hostile/eager model: if asked to route or pick a next tool it would happily answer.
    generate: async (req) => {
      gens.push(req);
      if (opts.llm) return opts.llm(req);
      if (req.kind === 'router') return 'profit_loss';
      if (req.kind === 'next') return 'TOOL net_worth';
      return 'Your net profit for June 2026 was $3,000.00.';
    },
    toolRead: async (req) => {
      reads.push({ tool: req.tool, args: req.args });
      return PNL;
    },
    status: async () => {
      statusCalls++;
      return { profile: 'default', seeded: true, lastSyncedAt: '2026-07-15T11:59:00.000Z', schemaVersion: 3, servable: ['profit_loss'], categories: CATEGORIES };
    },
    now: () => Date.now(),
    emit: (e) => events.push(e),
  };
  const run = (query: string): Promise<SubagentOutcome> =>
    runSubagent(deps, { query, nowIso: '2026-07-15T12:00:00.000Z', expectedProfile: 'default', priorLocalTurns: [], limits: { ...DEFAULT_SUBAGENT_LIMITS, compose: 'model' } });
  return { run, gens, reads, events, statusCalls: () => statusCalls };
}

// Multi-match: the OLD behaviour was an LLM tiebreak over the hit set.
const MULTI = ['P&L by category for this month', 'Show me spending by category'];
// Zero-match reads: the OLD behaviour was an LLM choice over all five tools plus "none".
const ZERO = ['How much did I spend on dining compared to last month?', 'How much is left in my budget?'];

describe('precision-first routing', () => {
  test('fixtures really are multi / zero keyword matches (guards the fixtures, not the rules)', () => {
    for (const q of MULTI) expect(keywordRoute(q).length, q).toBeGreaterThan(1);
    for (const q of ZERO) expect(keywordRoute(q).length, q).toBe(0);
  });

  for (const q of [...MULTI, ...ZERO]) {
    test(`not exactly one match -> handoff without any model call or tool read: ${q}`, async () => {
      const r = rig();
      const out = await r.run(q);
      expect(out.kind).toBe('handoff');
      if (out.kind !== 'handoff') return;
      expect(out.reason).toBe('router-none');
      expect(out.handoff.steps).toEqual([]);
      expect(r.gens).toEqual([]);
      expect(r.reads).toEqual([]);
      expect(r.events.some((e) => e.kind === 'route' && e.via === 'llm')).toBe(false);
      expect(r.events.some((e) => e.kind === 'compose')).toBe(false);
    });
  }

  test('a model that would pick a tool is never asked: single-hit makes exactly one generation, the compose', async () => {
    const r = rig();
    const out = await r.run('Give me a P&L for June');
    expect(out.kind).toBe('answer');
    expect(r.gens.map((g) => g.kind)).toEqual(['compose']);
    expect(r.reads.map((x) => x.tool)).toEqual(['profit_loss']);
    expect(r.events.find((e) => e.kind === 'route')).toEqual({ kind: 'route', tool: 'profit_loss', via: 'keyword' });
  });

  test('the model cannot add a second tool: a compose reply that asks for another tool never triggers a read', async () => {
    const r = rig({ llm: () => 'TOOL net_worth' });
    const out = await r.run('Give me a P&L for June');
    expect(r.reads.length).toBe(1);
    expect(out.kind).toBe('handoff'); // not a grounded answer
  });

  test('across every fixture, no generation request is ever a router or next-action request', async () => {
    const r = rig();
    for (const q of ['Give me a P&L for June', 'What is my net worth?', ...MULTI, ...ZERO, 'Show me my transactions']) await r.run(q);
    expect(r.gens.filter((g) => g.kind !== 'compose')).toEqual([]);
  });

  test('the tiebreak/next-action machinery is gone from the module surface', () => {
    const surface = core as Record<string, unknown>;
    for (const name of ['buildRouterPrompt', 'parseRouterReply', 'buildNextActionPrompt', 'parseNextAction']) {
      expect(surface[name], name).toBeUndefined();
    }
  });

  test('the none/mutation gate still runs first and never touches the model, port or mirror', async () => {
    const r = rig();
    const m = await r.run('Recategorize the Netflix charge as Entertainment');
    expect(m.kind === 'handoff' && m.reason).toBe('mutation-intent');
    const n = await r.run('Explain what a Roth IRA is');
    expect(n.kind === 'handoff' && n.reason).toBe('non-data');
    expect(r.gens.length + r.reads.length + r.statusCalls()).toBe(0);
  });

  test('a gate-passing single hit whose args cannot be filled still hands off, with no read', async () => {
    const r = rig();
    const out = await r.run('Show me my transactions');
    expect(out.kind === 'handoff' && out.reason).toBe('args-unfillable');
    expect(r.reads.length).toBe(0);
  });
});
