import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  gateQuestion,
  keywordRoute,
  proposeMutation,
  PROPOSAL_TOOLS,
  runSubagent,
  type Proposal,
  type SubagentDeps,
} from '../dashboard/ui/src/hybrid/subagent-core.js';
import { DEFAULT_SUBAGENT_LIMITS } from '../dashboard/ui/src/hybrid/worker-protocol.js';
import gold from './fixtures/subagent-route-gold.json';

/**
 * The deterministic front of the subagent: a TWO-SIDED gate (spec D3 step 1,
 * [C4]) and the keyword router. The gold set (42 rows, copied from the
 * open-jev spike) is optimistic because its regexes were written with the set
 * visible; the 11 critic phrasings below were NOT visible when the gate was
 * first written and are the real test of the allowlist side.
 */

const rows = gold.rows as Array<{ question: string; expected: string }>;
const readRows = rows.filter((r) => r.expected !== 'none');
const noneRows = rows.filter((r) => r.expected === 'none');

describe('gold set shape', () => {
  test('42 rows: 34 read, 8 none', () => {
    expect(rows.length).toBe(42);
    expect(readRows.length).toBe(34);
    expect(noneRows.length).toBe(8);
  });
});

describe('gate', () => {
  test('all 8 none rows are diverted away from the read tools', () => {
    for (const r of noneRows) {
      const g = gateQuestion(r.question);
      expect(g.kind, r.question).not.toBe('route');
    }
  });

  test('0 of 34 read rows are gated', () => {
    const gated = readRows.filter((r) => gateQuestion(r.question).kind !== 'route').map((r) => r.question);
    expect(gated).toEqual([]);
  });

  test('mutation requests carry a proposal; non-data does not', () => {
    const g = gateQuestion('Recategorize that Starbucks charge as Dining');
    expect(g.kind).toBe('mutation-intent');
    if (g.kind === 'mutation-intent') {
      expect(g.proposal.tool).toBe('edit_transaction');
      expect(g.proposal.userWords).toBe('Recategorize that Starbucks charge as Dining');
    }
    expect(gateQuestion('Explain what a Roth IRA is').kind).toBe('non-data');
    expect(gateQuestion('Hi, what can you do?').kind).toBe('non-data');
  });

  // [C4] The critic's 11 mutation phrasings that avoid the spike's denylist verbs.
  const CRITIC_UNSEEN_MUTATIONS = [
    'Get rid of the duplicate Adobe charge',
    'Move the Starbucks charge to Dining',
    'Put Netflix under Entertainment',
    'Cancel my Netflix subscription',
    'Fix the category on the Uber ride',
    'Assign the Costco run to Groceries',
    'Make the Adobe charge a business expense',
    'Reclassify my rent as housing',
    'Exclude transfers from my budget',
    'Hide the Venmo payments',
    'Approve all pending categorizations',
  ];

  test('[C4] the critic\'s 11 unseen mutation phrasings are all diverted', () => {
    expect(CRITIC_UNSEEN_MUTATIONS.length).toBe(11);
    const routed = CRITIC_UNSEEN_MUTATIONS.filter((q) => gateQuestion(q).kind === 'route');
    expect(routed).toEqual([]);
  });

  test('read questions the critic probed still route', () => {
    for (const q of [
      'How did my spending change since last month?',
      'Show me every Whole Foods charge in June',
    ]) {
      // "change" is a mutation verb: that one is a safe false gate. The other must route.
      const g = gateQuestion(q);
      if (q.startsWith('Show me')) expect(g.kind).toBe('route');
      else expect(['route', 'mutation-intent']).toContain(g.kind);
    }
  });

  test('a mutation verb inside an otherwise read-shaped question still diverts', () => {
    expect(gateQuestion('Show me my Adobe charges and delete the duplicate').kind).toBe('mutation-intent');
    expect(gateQuestion('Do me a favor and move the Netflix charge to Entertainment').kind).not.toBe('route');
  });

  test('empty / junk input is non-data, never a throw', () => {
    expect(gateQuestion('').kind).toBe('non-data');
    expect(gateQuestion('   ').kind).toBe('non-data');
    expect(gateQuestion('???').kind).toBe('non-data');
  });

  test('[C4] the gate is a pure function of the question text', () => {
    expect(gateQuestion.length).toBe(1);
  });

  test('[C4] a gated run through runSubagent never calls generate, toolRead or status', async () => {
    const calls: string[] = [];
    const deps: SubagentDeps = {
      generate: async () => { calls.push('generate'); return ''; },
      toolRead: async () => { calls.push('toolRead'); return { servable: false, why: 'not-seeded' }; },
      status: async () => { calls.push('status'); throw new Error('must not be called'); },
      now: () => { calls.push('now'); return 0; },
    };
    for (const q of [...CRITIC_UNSEEN_MUTATIONS, ...noneRows.map((r) => r.question)]) {
      const out = await runSubagent(deps, {
        query: q,
        nowIso: '2026-07-15T12:00:00.000Z',
        expectedProfile: 'default',
        priorLocalTurns: [],
        limits: DEFAULT_SUBAGENT_LIMITS,
      });
      expect(out.kind, q).toBe('handoff');
    }
    // `now` may be read to start the deadline clock, but nothing that touches the model or mirror.
    expect(calls.filter((c) => c !== 'now')).toEqual([]);
  });
});

describe('keyword router', () => {
  test('hits 29+ of 34 read rows as a single hit, with zero wrong single hits', () => {
    let single = 0;
    const wrong: string[] = [];
    for (const r of readRows) {
      const hits = keywordRoute(r.question);
      if (hits.length === 1) {
        single++;
        if (hits[0] !== r.expected) wrong.push(`${hits[0]} != ${r.expected}: ${r.question}`);
      }
    }
    expect(wrong).toEqual([]);
    expect(single).toBeGreaterThanOrEqual(29);
  });

  test('multi-hit returns every tool that matched (handed off, never tie-broken by the LLM); zero-hit returns none', () => {
    expect(keywordRoute('P&L by category for this month').sort()).toEqual(['profit_loss', 'spending_summary']);
    expect(keywordRoute('How much did I spend on dining compared to last month?')).toEqual([]);
  });
});

describe('proposal mapping [C1]', () => {
  const cases: Array<[string, Proposal['tool']]> = [
    ['Recategorize the Netflix charge as Entertainment', 'edit_transaction'],
    ['Move the Starbucks charge to Dining', 'edit_transaction'],
    ['Categorize my uncategorized transactions', 'categorize'],
    ['Auto-categorize everything', 'categorize'],
    ['Flag this charge as tax deductible', 'tax_flag'],
    ['Unflag the Adobe charge', 'tax_flag'],
    ['Change the amount on the Adobe charge to 50', 'edit_transaction'],
    ['Delete the duplicate Adobe transaction', 'delete_transaction'],
    ['Get rid of the duplicate Adobe charge', 'delete_transaction'],
    ['Import my new bank statement', 'other'],
    ['Change my budget goal to $500 a month', 'other'],
  ];
  for (const [q, tool] of cases) {
    test(`${q} -> ${tool}`, () => {
      expect(proposeMutation(q).tool).toBe(tool);
    });
  }

  test('userWords is the user\'s own words, capped at 300 chars', () => {
    const long = 'Delete ' + 'x'.repeat(500);
    expect(proposeMutation(long).userWords.length).toBe(300);
  });

  test('[C1] every non-other proposal tool is an agent-registered name (read from registry.ts)', () => {
    const src = readFileSync(join(import.meta.dir, '..', 'tools', 'registry.ts'), 'utf8');
    const registered = new Set([...src.matchAll(/name:\s*'([a-z_]+)'/g)].map((m) => m[1]));
    expect(registered.has('transaction_search')).toBe(true); // sanity: the regex works
    expect(PROPOSAL_TOOLS.length).toBeGreaterThan(0);
    for (const t of PROPOSAL_TOOLS) expect(registered.has(t), t).toBe(true);
    // The MCP-only name must never be proposed.
    expect(registered.has('categorize_transaction')).toBe(false);
    expect((PROPOSAL_TOOLS as readonly string[]).includes('categorize_transaction')).toBe(false);
    for (const [q] of cases) {
      const t = proposeMutation(q).tool;
      if (t !== 'other') expect(registered.has(t), q).toBe(true);
    }
  });
});
