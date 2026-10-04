import { describe, expect, test, beforeEach } from 'bun:test';
import { z } from 'zod';
import { AgentToolExecutor } from '../agent/tool-executor.js';
import { createRunContext } from '../agent/run-context.js';
import type { LlmResponse, ToolDef } from '../model/types.js';
import type { ApprovalDecision } from '../agent/types.js';
import { defineTool } from '../tools/define-tool.js';
import { ensureTestProfile, mockTool, collectEvents, createTestDb, seedTestData } from './helpers.js';
import { ALWAYS_MUTATING, CONDITIONALLY_MUTATING, READ_ONLY } from './mutation-audit.js';
import { deleteTransactionTool, initDeleteTransactionTool } from '../tools/query/delete-transaction.js';
import { memoryManageTool } from '../tools/memory/memory-manage.js';
import { taxFlagTool } from '../tools/tax/tax-flag.js';
import { chainToTool } from '../orchestration/registry.js';
import { editTransactionTool, initEditTransactionTool } from '../tools/query/edit-transaction.js';
import { budgetSetTool, initBudgetSetTool } from '../tools/budget/budget-set.js';
import { getBudgets } from '../db/queries.js';

describe('AgentToolExecutor', () => {
  beforeEach(() => {
    ensureTestProfile();
  });

  function makeLlmResponse(toolCalls: LlmResponse['toolCalls']): LlmResponse {
    return { content: '', toolCalls };
  }

  test('single tool execution emits start and end events', async () => {
    const tool = mockTool('test_tool', async () => 'result-data');
    const toolMap = new Map<string, ToolDef>([['test_tool', tool]]);
    const executor = new AgentToolExecutor(toolMap);
    const ctx = createRunContext('test query');

    const response = makeLlmResponse([
      { id: 'tc1', name: 'test_tool', args: { q: 'hello' } },
    ]);

    const events = await collectEvents(executor.executeAll(response, ctx));
    const types = events.map((e) => e.type);
    expect(types).toContain('tool_start');
    expect(types).toContain('tool_end');

    const endEvent = events.find((e) => e.type === 'tool_end')!;
    expect(endEvent.tool).toBe('test_tool');
    expect((endEvent as any).result).toBe('result-data');
  });

  test('tool error emits start and error events', async () => {
    const tool = mockTool('bad_tool', async () => {
      throw new Error('tool failed');
    });
    const toolMap = new Map<string, ToolDef>([['bad_tool', tool]]);
    const executor = new AgentToolExecutor(toolMap);
    const ctx = createRunContext('test query');

    const response = makeLlmResponse([
      { id: 'tc1', name: 'bad_tool', args: {} },
    ]);

    const events = await collectEvents(executor.executeAll(response, ctx));
    const types = events.map((e) => e.type);
    expect(types).toContain('tool_start');
    expect(types).toContain('tool_error');

    const errorEvent = events.find((e) => e.type === 'tool_error')!;
    expect((errorEvent as any).error).toBe('tool failed');
  });

  test('unknown tool emits error', async () => {
    const toolMap = new Map<string, ToolDef>();
    const executor = new AgentToolExecutor(toolMap);
    const ctx = createRunContext('test query');

    const response = makeLlmResponse([
      { id: 'tc1', name: 'nonexistent', args: {} },
    ]);

    const events = await collectEvents(executor.executeAll(response, ctx));
    const errorEvent = events.find((e) => e.type === 'tool_error');
    expect(errorEvent).toBeTruthy();
    expect((errorEvent as any).error).toContain("'nonexistent' not found");
  });

  test('skill dedup skips already-executed skills', async () => {
    const tool = mockTool('skill', async () => 'skill instructions');
    const toolMap = new Map<string, ToolDef>([['skill', tool]]);
    const executor = new AgentToolExecutor(toolMap);
    const ctx = createRunContext('test query');

    // Simulate first skill execution by adding a tool result to scratchpad
    ctx.scratchpad.addToolResult('skill', { skill: 'budget-audit' }, 'instructions');

    const response = makeLlmResponse([
      { id: 'tc1', name: 'skill', args: { skill: 'budget-audit' } },
    ]);

    const events = await collectEvents(executor.executeAll(response, ctx));
    // The deduped skill should produce no events
    expect(events).toHaveLength(0);
  });

  test('approval flow - deny stops execution', async () => {
    const tool = { ...mockTool('categorize', async () => 'categorized'), mutates: true };
    const toolMap = new Map<string, ToolDef>([['categorize', tool]]);
    const requestApproval = async (): Promise<ApprovalDecision> => 'deny';
    const executor = new AgentToolExecutor(toolMap, undefined, requestApproval);
    const ctx = createRunContext('test query');

    const response = makeLlmResponse([
      { id: 'tc1', name: 'categorize', args: {} },
    ]);

    const events = await collectEvents(executor.executeAll(response, ctx));
    const types = events.map((e) => e.type);
    expect(types).toContain('tool_approval');
    expect(types).toContain('tool_denied');
    // Should not have tool_start or tool_end
    expect(types).not.toContain('tool_end');
  });

  test('approval flow - allow-once permits execution', async () => {
    const tool = { ...mockTool('categorize', async () => 'done'), mutates: true };
    const toolMap = new Map<string, ToolDef>([['categorize', tool]]);
    const requestApproval = async (): Promise<ApprovalDecision> => 'allow-once';
    const executor = new AgentToolExecutor(toolMap, undefined, requestApproval);
    const ctx = createRunContext('test query');

    const response = makeLlmResponse([
      { id: 'tc1', name: 'categorize', args: {} },
    ]);

    const events = await collectEvents(executor.executeAll(response, ctx));
    const types = events.map((e) => e.type);
    expect(types).toContain('tool_approval');
    expect(types).toContain('tool_start');
    expect(types).toContain('tool_end');
  });

  test('approval flow - allow-session adds to session set', async () => {
    const tool = { ...mockTool('categorize', async () => 'done'), mutates: true };
    const toolMap = new Map<string, ToolDef>([['categorize', tool]]);
    const sessionApproved = new Set<string>();
    const requestApproval = async (): Promise<ApprovalDecision> => 'allow-session';
    const executor = new AgentToolExecutor(toolMap, undefined, requestApproval, sessionApproved);
    const ctx = createRunContext('test query');

    const response = makeLlmResponse([
      { id: 'tc1', name: 'categorize', args: {} },
    ]);

    await collectEvents(executor.executeAll(response, ctx));
    expect(sessionApproved.has('categorize')).toBe(true);
  });

  test('tool result is stringified if not a string', async () => {
    const tool = mockTool('json_tool', async () => JSON.stringify({ total: 500 }));
    const toolMap = new Map<string, ToolDef>([['json_tool', tool]]);
    const executor = new AgentToolExecutor(toolMap);
    const ctx = createRunContext('test query');

    const response = makeLlmResponse([
      { id: 'tc1', name: 'json_tool', args: {} },
    ]);

    const events = await collectEvents(executor.executeAll(response, ctx));
    const endEvent = events.find((e) => e.type === 'tool_end')!;
    expect((endEvent as any).result).toBe('{"total":500}');
  });

  test('multiple tool calls execute sequentially', async () => {
    const callOrder: string[] = [];
    const tool1 = mockTool('tool_a', async () => { callOrder.push('a'); return 'a-result'; });
    const tool2 = mockTool('tool_b', async () => { callOrder.push('b'); return 'b-result'; });
    const toolMap = new Map<string, ToolDef>([['tool_a', tool1], ['tool_b', tool2]]);
    const executor = new AgentToolExecutor(toolMap);
    const ctx = createRunContext('test query');

    const response = makeLlmResponse([
      { id: 'tc1', name: 'tool_a', args: {} },
      { id: 'tc2', name: 'tool_b', args: {} },
    ]);

    const events = await collectEvents(executor.executeAll(response, ctx));
    expect(callOrder).toEqual(['a', 'b']);
    const endEvents = events.filter((e) => e.type === 'tool_end');
    expect(endEvents).toHaveLength(2);
  });

  test('malformed args are rejected before the tool function runs', async () => {
    let funcCalls = 0;
    const tool = defineTool({
      name: 'edit_transaction',
      description: 'Edit',
      schema: z.object({ id: z.number(), amount: z.number().optional() }),
      // Schema-guard test, not an approval test: skip the gate explicitly.
      mutates: false,
      func: async () => {
        funcCalls++;
        return 'edited';
      },
    });
    const toolMap = new Map<string, ToolDef>([['edit_transaction', tool]]);
    const executor = new AgentToolExecutor(toolMap);
    const ctx = createRunContext('test query');

    const response = makeLlmResponse([
      { id: 'tc1', name: 'edit_transaction', args: { id: 'abc', amount: 'not-a-number' } },
    ]);

    const events = await collectEvents(executor.executeAll(response, ctx));
    expect(funcCalls).toBe(0); // tool function never invoked

    const errEvent = events.find((e) => e.type === 'tool_error')!;
    expect(errEvent).toBeTruthy();
    expect((errEvent as any).error).toContain('Invalid arguments for tool');
    expect((errEvent as any).error).toContain('id'); // offending fields named
    expect((errEvent as any).error).toContain('amount');
    expect(events.some((e) => e.type === 'tool_end')).toBe(false);

    // Error is fed back to the model on the next iteration (re-prompt)
    expect(ctx.scratchpad.getToolResults()).toContain('Invalid arguments');
  });

  describe('tools whose schema the model was not shown (local tool selection)', () => {
    function mutatingEdit(onRun: () => void): ToolDef {
      return defineTool({
        name: 'edit_transaction',
        description: 'Edit a transaction',
        schema: z.object({ id: z.number(), category: z.string().optional() }),
        mutates: true,
        func: async () => {
          onRun();
          return 'edited';
        },
      });
    }

    test('bad args: the schema comes back with "call it again"; no approval asked, nothing runs', async () => {
      let runs = 0;
      let approvals = 0;
      const toolMap = new Map<string, ToolDef>([['edit_transaction', mutatingEdit(() => runs++)]]);
      const executor = new AgentToolExecutor(toolMap, undefined, async () => {
        approvals++;
        return 'allow-once';
      });
      const ctx = createRunContext('fix it');
      const events = await collectEvents(
        executor.executeAll(makeLlmResponse([{ id: 'tc1', name: 'edit_transaction', args: {} }]), ctx, undefined, {
          shownTools: new Set(['transaction_search']),
        }),
      );
      expect(runs).toBe(0);
      expect(approvals).toBe(0);
      const err = events.find((e) => e.type === 'tool_error') as any;
      expect(err.error).toContain('Tool edit_transaction needs these arguments:');
      expect(err.error).toContain('"id"');
      expect(err.error).toContain('Call it again.');
      expect(ctx.scratchpad.getToolResults()).toContain('needs these arguments');
      expect(ctx.scratchpad.getToolCallRecords().map((r) => r.tool)).toEqual(['edit_transaction']);
    });

    test('valid args: approval (#152) is still asked before it runs', async () => {
      let runs = 0;
      const decisions: string[] = [];
      const toolMap = new Map<string, ToolDef>([['edit_transaction', mutatingEdit(() => runs++)]]);
      const executor = new AgentToolExecutor(toolMap, undefined, async (req) => {
        decisions.push(req.tool);
        return 'deny';
      });
      const ctx = createRunContext('fix it');
      const events = await collectEvents(
        executor.executeAll(makeLlmResponse([{ id: 'tc1', name: 'edit_transaction', args: { id: 3 } }]), ctx, undefined, {
          shownTools: new Set(['transaction_search']),
        }),
      );
      expect(decisions).toEqual(['edit_transaction']);
      expect(runs).toBe(0);
      expect(events.some((e) => e.type === 'tool_denied')).toBe(true);
    });

    test('a shown tool with bad args keeps today’s path (approval, then the schema guard)', async () => {
      let approvals = 0;
      const toolMap = new Map<string, ToolDef>([['edit_transaction', mutatingEdit(() => {})]]);
      const executor = new AgentToolExecutor(toolMap, undefined, async () => {
        approvals++;
        return 'allow-once';
      });
      const ctx = createRunContext('fix it');
      const events = await collectEvents(
        executor.executeAll(makeLlmResponse([{ id: 'tc1', name: 'edit_transaction', args: {} }]), ctx, undefined, {
          shownTools: new Set(['edit_transaction']),
        }),
      );
      expect(approvals).toBe(1);
      expect((events.find((e) => e.type === 'tool_error') as any).error).toContain("Invalid arguments for tool 'edit_transaction'");
    });
  });

  test('valid args execute normally through the schema guard', async () => {
    let funcCalls = 0;
    const tool = defineTool({
      name: 'edit_transaction',
      description: 'Edit',
      schema: z.object({ id: z.number(), amount: z.number().optional() }),
      // Schema-guard test, not an approval test: skip the gate explicitly.
      mutates: false,
      func: async () => {
        funcCalls++;
        return 'edited';
      },
    });
    const toolMap = new Map<string, ToolDef>([['edit_transaction', tool]]);
    const executor = new AgentToolExecutor(toolMap);
    const ctx = createRunContext('test query');

    const response = makeLlmResponse([
      { id: 'tc1', name: 'edit_transaction', args: { id: 42, amount: -12.5 } },
    ]);

    const events = await collectEvents(executor.executeAll(response, ctx));
    expect(funcCalls).toBe(1);
    const endEvent = events.find((e) => e.type === 'tool_end')!;
    expect(endEvent).toBeTruthy();
    expect((endEvent as any).result).toBe('edited');
    expect(events.some((e) => e.type === 'tool_error')).toBe(false);
  });
});

/**
 * #152: every mutating agent tool asks for approval before it runs, a denial
 * prevents the write, and read-only tools never prompt.
 */
describe('AgentToolExecutor approval for mutating tools (#152)', () => {
  beforeEach(() => {
    ensureTestProfile();
  });

  function respond(toolCalls: LlmResponse['toolCalls']): LlmResponse {
    return { content: '', toolCalls };
  }

  /** The real tool definition (flag included) with its func swapped for a recorder. */
  function recorded(tool: ToolDef, log: string[]): ToolDef {
    return {
      ...tool,
      func: async () => {
        log.push(`run:${tool.name}`);
        return 'ok';
      },
    };
  }

  const mutatingCalls: Array<[ToolDef, Record<string, unknown>]> = [
    ...ALWAYS_MUTATING,
    ...CONDITIONALLY_MUTATING.flatMap(({ tool, writes }) => writes.map((args) => [tool, args] as [ToolDef, Record<string, unknown>])),
  ];
  const readCalls: Array<[ToolDef, Record<string, unknown>]> = [
    ...READ_ONLY.map((tool) => [tool, {}] as [ToolDef, Record<string, unknown>]),
    ...CONDITIONALLY_MUTATING.flatMap(({ tool, reads }) => reads.map((args) => [tool, args] as [ToolDef, Record<string, unknown>])),
  ];

  for (const [tool, args] of mutatingCalls) {
    test(`${tool.name} ${JSON.stringify(args)} emits tool_approval before executing`, async () => {
      const log: string[] = [];
      const requestApproval = async (req: { tool: string; args: Record<string, unknown> }): Promise<ApprovalDecision> => {
        log.push(`approve?:${req.tool}`);
        expect(req.args).toEqual(args);
        return 'allow-once';
      };
      const executor = new AgentToolExecutor(new Map([[tool.name, recorded(tool, log)]]), undefined, requestApproval);
      const events = await collectEvents(
        executor.executeAll(respond([{ id: 'tc1', name: tool.name, args }]), createRunContext('q')),
      );
      const types = events.map((e) => e.type);
      expect(types.indexOf('tool_approval')).toBeGreaterThanOrEqual(0);
      expect(types.indexOf('tool_approval')).toBeLessThan(types.indexOf('tool_start'));
      expect(log).toEqual([`approve?:${tool.name}`, `run:${tool.name}`]);
    });

    test(`${tool.name} ${JSON.stringify(args)} does not run when denied`, async () => {
      const log: string[] = [];
      const executor = new AgentToolExecutor(
        new Map([[tool.name, recorded(tool, log)]]),
        undefined,
        async () => 'deny',
      );
      const events = await collectEvents(
        executor.executeAll(respond([{ id: 'tc1', name: tool.name, args }]), createRunContext('q')),
      );
      const types = events.map((e) => e.type);
      expect(types).toEqual(['tool_approval', 'tool_denied']);
      expect(log).toEqual([]);
    });
  }

  for (const [tool, args] of readCalls) {
    test(`${tool.name} ${JSON.stringify(args)} runs without an approval prompt`, async () => {
      const log: string[] = [];
      let asked = 0;
      const executor = new AgentToolExecutor(
        new Map([[tool.name, recorded(tool, log)]]),
        undefined,
        async () => {
          asked++;
          return 'deny';
        },
      );
      const events = await collectEvents(
        executor.executeAll(respond([{ id: 'tc1', name: tool.name, args }]), createRunContext('q')),
      );
      expect(asked).toBe(0);
      expect(events.some((e) => e.type === 'tool_approval')).toBe(false);
      expect(events.some((e) => e.type === 'tool_end')).toBe(true);
      expect(log).toEqual([`run:${tool.name}`]);
    });
  }

  test('a tool with no mutation declaration needs approval (fail closed)', async () => {
    let ran = false;
    const undeclared: ToolDef = {
      name: 'undeclared_tool',
      description: 'no mutates flag',
      schema: z.object({}).passthrough(),
      func: async () => {
        ran = true;
        return 'ran';
      },
    };
    const requests: string[] = [];
    const executor = new AgentToolExecutor(new Map([['undeclared_tool', undeclared]]), undefined, async (r) => {
      requests.push(r.tool);
      return 'deny';
    });
    const events = await collectEvents(
      executor.executeAll({ content: '', toolCalls: [{ id: 'tc1', name: 'undeclared_tool', args: {} }] }, createRunContext('q')),
    );
    expect(requests).toEqual(['undeclared_tool']);
    expect(events.map((e) => e.type)).toEqual(['tool_approval', 'tool_denied']);
    expect(ran).toBe(false);
  });

  test('with no approval handler a mutating tool is denied (fail closed)', async () => {
    const log: string[] = [];
    const executor = new AgentToolExecutor(new Map([['delete_transaction', recorded(deleteTransactionTool, log)]]));
    const events = await collectEvents(
      executor.executeAll(respond([{ id: 'tc1', name: 'delete_transaction', args: { id: 1 } }]), createRunContext('q')),
    );
    expect(events.map((e) => e.type)).toEqual(['tool_approval', 'tool_denied']);
    expect(log).toEqual([]);
  });

  test('allow-session only covers the tool that was approved', async () => {
    const log: string[] = [];
    const asked: string[] = [];
    const sessionApproved = new Set<string>();
    const toolMap = new Map<string, ToolDef>([
      ['categorize', recorded(ALWAYS_MUTATING.find(([t]) => t.name === 'categorize')![0], log)],
      ['delete_transaction', recorded(deleteTransactionTool, log)],
    ]);
    const executor = new AgentToolExecutor(
      toolMap,
      undefined,
      async (req) => {
        asked.push(req.tool);
        return req.tool === 'categorize' ? 'allow-session' : 'deny';
      },
      sessionApproved,
    );
    await collectEvents(executor.executeAll(respond([{ id: 'a', name: 'categorize', args: {} }]), createRunContext('q')));
    await collectEvents(executor.executeAll(respond([{ id: 'b', name: 'categorize', args: {} }]), createRunContext('q')));
    await collectEvents(executor.executeAll(respond([{ id: 'c', name: 'delete_transaction', args: { id: 1 } }]), createRunContext('q')));
    expect([...sessionApproved]).toEqual(['categorize']);
    expect(asked).toEqual(['categorize', 'delete_transaction']);
    expect(log).toEqual(['run:categorize', 'run:categorize']);
  });

  async function sessionRun(tool: ToolDef, calls: Record<string, unknown>[], decide: (req: { tool: string; args: Record<string, unknown> }) => ApprovalDecision) {
    const log: string[] = [];
    const asked: Array<Record<string, unknown>> = [];
    const sessionApproved = new Set<string>();
    const executor = new AgentToolExecutor(
      new Map([[tool.name, recorded(tool, log)]]),
      undefined,
      async (req) => {
        asked.push(req.args);
        return decide(req);
      },
      sessionApproved,
    );
    for (const [i, args] of calls.entries()) {
      await collectEvents(executor.executeAll(respond([{ id: `c${i}`, name: tool.name, args }]), createRunContext('q')));
    }
    return { log, asked, sessionApproved };
  }

  test('allow-session for memory_manage add does not allow deactivate', async () => {
    const { asked, sessionApproved } = await sessionRun(
      memoryManageTool,
      [{ action: 'add' }, { action: 'add' }, { action: 'deactivate' }],
      (req) => (req.args.action === 'add' ? 'allow-session' : 'deny'),
    );
    expect(asked).toEqual([{ action: 'add' }, { action: 'deactivate' }]);
    expect([...sessionApproved]).toEqual(['memory_manage:add']);
  });

  test('allow-session for tax_flag flag does not allow export', async () => {
    const { asked, log } = await sessionRun(
      taxFlagTool,
      [{ action: 'flag' }, { action: 'flag' }, { action: 'export' }],
      (req) => (req.args.action === 'flag' ? 'allow-session' : 'deny'),
    );
    expect(asked).toEqual([{ action: 'flag' }, { action: 'export' }]);
    expect(log).toEqual(['run:tax_flag', 'run:tax_flag']);
  });

  test('chain/team tools ask every time, even after allow-session', async () => {
    const chainTool = { ...chainToTool({ name: 'imp', description: 'd', steps: [{ id: 'a', tools: ['csv_import'] }] }), mutates: true };
    const { asked, log, sessionApproved } = await sessionRun(chainTool, [{ input: 'a' }, { input: 'b' }], () => 'allow-session');
    expect(asked).toEqual([{ input: 'a' }, { input: 'b' }]);
    expect(log).toEqual(['run:chain_imp', 'run:chain_imp']);
    expect(sessionApproved.size).toBe(0);
  });

  test('the approval request says what allow-session would cover', async () => {
    const requests: unknown[] = [];
    const chainTool = { ...chainToTool({ name: 'imp', description: 'd', steps: [{ id: 'a', tools: ['csv_import'] }] }), mutates: true };
    const executor = new AgentToolExecutor(
      new Map<string, ToolDef>([
        ['memory_manage', recorded(memoryManageTool, [])],
        ['delete_transaction', recorded(deleteTransactionTool, [])],
        ['chain_imp', recorded(chainTool, [])],
      ]),
      undefined,
      async (req) => {
        requests.push(req);
        return 'deny';
      },
    );
    for (const [name, args] of [['memory_manage', { action: 'add' }], ['delete_transaction', { id: 1 }], ['chain_imp', { input: 'x' }]] as const) {
      await collectEvents(executor.executeAll(respond([{ id: 'x', name, args: { ...args } }]), createRunContext('q')));
    }
    expect(requests).toEqual([
      { tool: 'memory_manage', args: { action: 'add' }, session: { key: 'memory_manage:add', action: 'add' } },
      { tool: 'delete_transaction', args: { id: 1 }, session: { key: 'delete_transaction' } },
      { tool: 'chain_imp', args: { input: 'x' }, session: null },
    ]);
  });

  describe('a denial leaves the database untouched; an approval writes', () => {
    function setup() {
      const db = createTestDb();
      seedTestData(db);
      initDeleteTransactionTool(db);
      initEditTransactionTool(db);
      initBudgetSetTool(db);
      const toolMap = new Map<string, ToolDef>([
        ['delete_transaction', deleteTransactionTool],
        ['edit_transaction', editTransactionTool],
        ['budget_set', budgetSetTool],
      ]);
      const target = db.prepare("SELECT id, category FROM transactions WHERE description = 'Restaurant'").get() as { id: number; category: string };
      return { db, toolMap, target };
    }

    const calls = (id: number): LlmResponse['toolCalls'] => [
      { id: 'e', name: 'edit_transaction', args: { id, category: 'Groceries' } },
      { id: 'b', name: 'budget_set', args: { category: 'Dining', monthlyLimit: 999 } },
      { id: 'd', name: 'delete_transaction', args: { id } },
    ];

    test('deny', async () => {
      const { db, toolMap, target } = setup();
      const executor = new AgentToolExecutor(toolMap, undefined, async () => 'deny');
      for (const call of calls(target.id)) {
        await collectEvents(executor.executeAll(respond([call]), createRunContext('q')));
      }
      const row = db.prepare('SELECT category FROM transactions WHERE id = @id').get({ id: target.id }) as { category: string } | undefined;
      expect(row?.category).toBe('Dining');
      expect(getBudgets(db).find((b) => b.category === 'Dining')?.monthly_limit).toBe(100);
    });

    test('allow-once', async () => {
      const { db, toolMap, target } = setup();
      const executor = new AgentToolExecutor(toolMap, undefined, async () => 'allow-once');
      const [edit, budget, del] = calls(target.id);
      await collectEvents(executor.executeAll(respond([edit]), createRunContext('q')));
      expect((db.prepare('SELECT category FROM transactions WHERE id = @id').get({ id: target.id }) as { category: string }).category).toBe('Groceries');
      await collectEvents(executor.executeAll(respond([budget]), createRunContext('q')));
      expect(getBudgets(db).find((b) => b.category === 'Dining')?.monthly_limit).toBe(999);
      await collectEvents(executor.executeAll(respond([del]), createRunContext('q')));
      expect(db.prepare('SELECT id FROM transactions WHERE id = @id').get({ id: target.id })).toBeFalsy();
    });
  });
});

