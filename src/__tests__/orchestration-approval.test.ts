import { describe, expect, test, beforeEach, afterEach, spyOn } from 'bun:test';
import * as llmModule from '../model/llm.js';
import type { LlmResult } from '../model/llm.js';
import * as registryModule from '../tools/registry.js';
import type { LlmResponse, ToolDef } from '../model/types.js';
import type { ApprovalDecision, ToolApprovalRequest } from '../agent/types.js';
import { AgentToolExecutor } from '../agent/tool-executor.js';
import { createRunContext } from '../agent/run-context.js';
import { runChain } from '../orchestration/chain.js';
import { runTeam } from '../orchestration/team.js';
import { chainToTool, teamToTool } from '../orchestration/registry.js';
import { deleteTransactionTool, initDeleteTransactionTool } from '../tools/query/delete-transaction.js';
import { collectEvents, createTestDb, mockTool, seedTestData } from './helpers.js';
import type { Database } from '../db/compat-sqlite.js';
import type { ChainDef, TeamDef } from '../orchestration/types.js';

/**
 * Chains and teams: every tool call a step or member makes goes through the
 * same approval gate as the main agent. Approving the chain/team call does
 * not approve the writes its model chooses — each mutating call gets its own
 * card with the real tool and args, and with no way to ask (headless, or no
 * handler) the call is denied and the step continues with the denial.
 */

function result(content: string, toolCalls: LlmResponse['toolCalls'] = [], structured?: unknown): LlmResult {
  return { response: { content, toolCalls, ...(structured ? { structured } : {}) }, traceId: 't', durationMs: 1 };
}

let llmSpy: ReturnType<typeof spyOn>;
let toolsSpy: ReturnType<typeof spyOn>;
let prompts: string[];
let db: Database;

function countRows(): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM transactions').get() as { n: number }).n;
}

function txnIds(): number[] {
  return (db.prepare('SELECT id FROM transactions ORDER BY id').all() as Array<{ id: number }>).map((r) => r.id);
}

/** Script the LLM: the step/member asks for these responses in order. */
function scriptLlm(responses: LlmResult[]) {
  let call = 0;
  llmSpy.mockImplementation(async (prompt: string) => {
    prompts.push(prompt);
    const res = responses[Math.min(call, responses.length - 1)];
    call++;
    return res;
  });
}

const deleteChain: ChainDef = {
  name: 'cleanup',
  description: 'Deletes transactions the model picks',
  steps: [{ id: 'purge', tools: ['delete_transaction', 'spending_summary'] }],
};

const readTool = mockTool('spending_summary', async () => '{"total": 1}');

beforeEach(() => {
  db = createTestDb();
  seedTestData(db);
  initDeleteTransactionTool(db);
  prompts = [];
  llmSpy = spyOn(llmModule, 'callLlm');
  toolsSpy = spyOn(registryModule, 'getToolsByNames').mockImplementation(async (names: string[]) =>
    [deleteTransactionTool, readTool].filter((t) => names.includes(t.name)) as ToolDef[],
  );
});

afterEach(() => {
  llmSpy.mockRestore();
  toolsSpy.mockRestore();
});

describe('chain step tool calls go through the approval gate', () => {
  test('each delete_transaction a step makes prompts on its own, with the real tool and args; deny writes nothing', async () => {
    const [a, b] = txnIds();
    scriptLlm([
      result('', [
        { id: 'c1', name: 'delete_transaction', args: { id: a } },
        { id: 'c2', name: 'delete_transaction', args: { id: b } },
      ]),
      result('Step done.'),
    ]);
    const before = countRows();
    const asked: ToolApprovalRequest[] = [];
    const out = await runChain(deleteChain, 'clean up', {
      requestToolApproval: async (req) => {
        asked.push(req);
        return 'deny';
      },
    });

    expect(out).toBe('Step done.');
    expect(asked.map((r) => [r.tool, r.args])).toEqual([
      ['delete_transaction', { id: a }],
      ['delete_transaction', { id: b }],
    ]);
    expect(countRows()).toBe(before);
    // The step continues: the denial is fed back as the tool result.
    expect(prompts[1]).toContain('[delete_transaction]');
    expect(prompts[1].toLowerCase()).toContain('denied');
  });

  test('approving one call does not approve the next — every write is asked separately', async () => {
    const [a, b] = txnIds();
    scriptLlm([
      result('', [{ id: 'c1', name: 'delete_transaction', args: { id: a } }]),
      result('', [{ id: 'c2', name: 'delete_transaction', args: { id: b } }]),
      result('Step done.'),
    ]);
    const before = countRows();
    const decisions: ApprovalDecision[] = ['allow-once', 'deny'];
    const asked: ToolApprovalRequest[] = [];
    await runChain(deleteChain, 'clean up', {
      requestToolApproval: async (req) => {
        asked.push(req);
        return decisions[asked.length - 1];
      },
    });
    expect(asked.map((r) => r.args)).toEqual([{ id: a }, { id: b }]);
    expect(countRows()).toBe(before - 1);
    expect(txnIds()).not.toContain(a);
    expect(txnIds()).toContain(b);
  });

  test('read-only calls run without a card', async () => {
    scriptLlm([result('', [{ id: 'r1', name: 'spending_summary', args: {} }]), result('Read done.')]);
    const asked: ToolApprovalRequest[] = [];
    const out = await runChain(deleteChain, 'read', {
      requestToolApproval: async (req) => {
        asked.push(req);
        return 'deny';
      },
    });
    expect(out).toBe('Read done.');
    expect(asked).toEqual([]);
    expect(prompts[1]).toContain('{"total": 1}');
  });

  test('headless (no approval handler): mutating calls are denied, nothing is written, the step continues', async () => {
    const [a] = txnIds();
    scriptLlm([result('', [{ id: 'c1', name: 'delete_transaction', args: { id: a } }]), result('Could not delete.')]);
    const before = countRows();
    const out = await runChain(deleteChain, 'clean up');
    expect(out).toBe('Could not delete.');
    expect(countRows()).toBe(before);
    expect(prompts[1].toLowerCase()).toContain('denied');
  });

  test('a cancelled run denies without asking', async () => {
    const [a] = txnIds();
    scriptLlm([result('', [{ id: 'c1', name: 'delete_transaction', args: { id: a } }]), result('x')]);
    const controller = new AbortController();
    controller.abort();
    const asked: ToolApprovalRequest[] = [];
    const before = countRows();
    await runChain(deleteChain, 'clean up', {
      signal: controller.signal,
      requestToolApproval: async (req) => {
        asked.push(req);
        return 'allow-once';
      },
    }).catch(() => {});
    expect(asked).toEqual([]);
    expect(countRows()).toBe(before);
  });

  test('called by the agent: the executor hands its gate to the chain, so the chain card and each inner write are asked', async () => {
    const [a, b] = txnIds();
    scriptLlm([
      result('', [
        { id: 'c1', name: 'delete_transaction', args: { id: a } },
        { id: 'c2', name: 'delete_transaction', args: { id: b } },
      ]),
      result('Step done.'),
    ]);
    const chainTool = { ...chainToTool(deleteChain), mutates: true };
    const asked: ToolApprovalRequest[] = [];
    const executor = new AgentToolExecutor(
      new Map<string, ToolDef>([[chainTool.name, chainTool]]),
      undefined,
      async (req) => {
        asked.push(req);
        // The chain itself is approved; its inner writes are not.
        return req.tool === chainTool.name ? 'allow-once' : 'deny';
      },
    );
    const before = countRows();
    const events = await collectEvents(
      executor.executeAll({ content: '', toolCalls: [{ id: 'x', name: chainTool.name, args: { input: 'clean' } }] }, createRunContext('q')),
    );
    expect(asked.map((r) => [r.tool, r.args])).toEqual([
      ['chain_cleanup', { input: 'clean' }],
      ['delete_transaction', { id: a }],
      ['delete_transaction', { id: b }],
    ]);
    expect(countRows()).toBe(before);
    expect(events.find((e) => e.type === 'tool_end')).toBeDefined();
  });

  test('an inner allow-session is remembered in the agent session like any other approval', async () => {
    const [a, b] = txnIds();
    scriptLlm([
      result('', [{ id: 'c1', name: 'delete_transaction', args: { id: a } }]),
      result('', [{ id: 'c2', name: 'delete_transaction', args: { id: b } }]),
      result('Step done.'),
    ]);
    const session = new Set<string>();
    const asked: ToolApprovalRequest[] = [];
    await runChain(deleteChain, 'clean up', {
      sessionApprovedTools: session,
      requestToolApproval: async (req) => {
        asked.push(req);
        return 'allow-session';
      },
    });
    expect(asked).toHaveLength(1);
    expect(session.has('delete_transaction')).toBe(true);
  });
});

describe('team member tool calls go through the approval gate', () => {
  const team: TeamDef = {
    name: 'cleaners',
    description: 'Two members who each delete',
    dispatcher: {},
    members: [
      { id: 'one', tools: ['delete_transaction'] },
      { id: 'two', tools: ['delete_transaction'] },
    ],
  };

  function scriptTeam(a: number, b: number) {
    llmSpy.mockImplementation(async (prompt: string, opts?: { outputSchema?: unknown; systemPrompt?: string }) => {
      prompts.push(prompt);
      if (opts?.outputSchema) {
        return result('dispatch', [], {
          assignments: [
            { memberId: 'one', subtask: 'delete a' },
            { memberId: 'two', subtask: 'delete b' },
          ],
        });
      }
      if (prompt.includes('Tool results:') || prompt.includes('Synthesize')) return result('done');
      if (prompt.includes('delete a')) return result('', [{ id: 'm1', name: 'delete_transaction', args: { id: a } }]);
      if (prompt.includes('delete b')) return result('', [{ id: 'm2', name: 'delete_transaction', args: { id: b } }]);
      return result('done');
    });
  }

  test('parallel members ask one at a time (never two cards at once); deny writes nothing', async () => {
    const [a, b] = txnIds();
    scriptTeam(a, b);
    const before = countRows();
    let inFlight = 0;
    let maxInFlight = 0;
    const asked: unknown[] = [];
    await runTeam(team, 'clean', {
      requestToolApproval: async (req) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        asked.push(req.args);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return 'deny';
      },
    });
    expect(maxInFlight).toBe(1);
    expect(asked).toHaveLength(2);
    expect(asked).toContainEqual({ id: a });
    expect(asked).toContainEqual({ id: b });
    expect(countRows()).toBe(before);
  });

  test('headless team: mutating member calls are denied', async () => {
    const [a, b] = txnIds();
    scriptTeam(a, b);
    const before = countRows();
    await runTeam(team, 'clean');
    expect(countRows()).toBe(before);
  });

  test('team tool invoked by the agent passes the gate to its members', async () => {
    const [a, b] = txnIds();
    scriptTeam(a, b);
    const teamTool = { ...teamToTool(team), mutates: true };
    const asked: string[] = [];
    const executor = new AgentToolExecutor(new Map<string, ToolDef>([[teamTool.name, teamTool]]), undefined, async (req) => {
      asked.push(req.tool);
      return req.tool === teamTool.name ? 'allow-once' : 'deny';
    });
    const before = countRows();
    await collectEvents(
      executor.executeAll({ content: '', toolCalls: [{ id: 'x', name: teamTool.name, args: { query: 'clean' } }] }, createRunContext('q')),
    );
    expect(asked).toEqual(['team_cleaners', 'delete_transaction', 'delete_transaction']);
    expect(countRows()).toBe(before);
  });
});
