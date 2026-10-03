import { describe, expect, test } from 'bun:test';
import type { ToolDef } from '../model/types.js';
import { isMutatingCall, mayMutate, sessionApprovalScope } from '../tools/mutation.js';
import { chainToTool, teamToTool } from '../orchestration/registry.js';
import type { ChainDef, TeamDef } from '../orchestration/types.js';
import { transactionSearchTool } from '../tools/query/transaction-search.js';
import { memoryManageTool } from '../tools/memory/memory-manage.js';
import { taxFlagTool } from '../tools/tax/tax-flag.js';
import { deleteTransactionTool } from '../tools/query/delete-transaction.js';
import { entityClassifyTool } from '../tools/entity/entity-classify.js';
import {
  ALWAYS_MUTATING,
  CONDITIONALLY_MUTATING,
  READ_ONLY,
  MUTATING_TOOL_NAMES,
} from './mutation-audit.js';

describe('mutating-tool audit (#152)', () => {
  test('the audited mutating set is exactly what the issue calls out plus every other writer', () => {
    expect(MUTATING_TOOL_NAMES).toEqual([
      'account_manage',
      'balance_update',
      'budget_set',
      'categorize',
      'category_manage',
      'coinbase_sync',
      'csv_import',
      'delete_transaction',
      'edit_transaction',
      'entity_classify',
      'entity_manage',
      'export_transactions',
      'firefly_import',
      'generate_report',
      'goal_manage',
      'link_transactions',
      'memory_manage',
      'monarch_import',
      'mortgage_manage',
      'plaid_balances',
      'plaid_sync',
      'rule_manage',
      'tax_flag',
    ]);
  });

  for (const [tool, args] of ALWAYS_MUTATING) {
    test(`${tool.name} is flagged mutating for every call`, () => {
      expect(mayMutate(tool)).toBe(true);
      expect(isMutatingCall(tool, args)).toBe(true);
      expect(isMutatingCall(tool, {})).toBe(true);
    });
  }

  for (const { tool, writes, reads } of CONDITIONALLY_MUTATING) {
    test(`${tool.name} is flagged mutating for writes and not for reads`, () => {
      expect(mayMutate(tool)).toBe(true);
      for (const args of writes) expect({ args, mutating: isMutatingCall(tool, args) }).toEqual({ args, mutating: true });
      for (const args of reads) expect({ args, mutating: isMutatingCall(tool, args) }).toEqual({ args, mutating: false });
    });
  }

  test('action-based flags fail closed on an unknown or missing action', () => {
    for (const { tool } of CONDITIONALLY_MUTATING) {
      if (tool.name === 'entity_classify' || tool.name === 'link_transactions') continue;
      expect(isMutatingCall(tool, { action: 'definitely-not-an-action' })).toBe(true);
      expect(isMutatingCall(tool, {})).toBe(true);
    }
  });

  for (const tool of READ_ONLY) {
    test(`${tool.name} is read-only`, () => {
      // Declared explicitly: an omitted flag now means "mutating".
      expect(tool.mutates).toBe(false);
      expect(mayMutate(tool)).toBe(false);
      expect(isMutatingCall(tool, {})).toBe(false);
    });
  }

  test('a flag predicate that throws is treated as mutating (fail closed)', () => {
    const tool = {
      ...transactionSearchTool,
      mutates: () => {
        throw new Error('boom');
      },
    } as ToolDef;
    expect(isMutatingCall(tool, {})).toBe(true);
  });

  test('a tool with no mutation declaration is treated as mutating (fail closed)', () => {
    const { mutates: _omit, ...undeclared } = transactionSearchTool;
    expect(mayMutate(undeclared as ToolDef)).toBe(true);
    expect(isMutatingCall(undeclared as ToolDef, {})).toBe(true);
    expect(isMutatingCall({ ...transactionSearchTool, mutates: undefined } as ToolDef, {})).toBe(true);
  });

  test('an undefined tool is not mutating (the executor reports it as not found)', () => {
    expect(isMutatingCall(undefined, {})).toBe(false);
  });
});

describe('orchestration tools inherit mutation from the tools they run', () => {
  const chain = (tools: string[]): ChainDef => ({
    name: 'demo-chain',
    description: 'demo',
    tier: 'free',
    steps: [{ id: 's1', tools }, { id: 's2' }],
  });
  const team = (tools: string[]): TeamDef => ({
    name: 'demo-team',
    description: 'demo',
    dispatcher: {},
    members: [{ id: 'm1', tools }, { id: 'm2' }],
  });

  test('chain/team tools declare themselves mutating until the registry resolves what they call', () => {
    expect(chainToTool(chain(['spending_summary'])).mutates).toBe(true);
    expect(teamToTool(team([])).mutates).toBe(true);
  });

  test('chain/team tools record the tool names their steps/members may call', () => {
    expect(chainToTool(chain(['csv_import', 'spending_summary'])).usesTools).toEqual(['csv_import', 'spending_summary']);
    expect(teamToTool(team(['categorize'])).usesTools).toEqual(['categorize']);
    expect(chainToTool(chain([])).usesTools).toEqual([]);
  });
});

describe('session approval scope (#152)', () => {
  const key = (tool: ToolDef, args: Record<string, unknown>) => sessionApprovalScope(tool.name, tool, args)?.key ?? null;

  test('tools whose writes depend on the action are scoped to tool + action', () => {
    expect(key(memoryManageTool, { action: 'add' })).not.toBe(key(memoryManageTool, { action: 'deactivate' }));
    expect(key(taxFlagTool, { action: 'flag' })).not.toBe(key(taxFlagTool, { action: 'export' }));
    expect(key(taxFlagTool, { action: 'flag', transactionId: 1 })).toBe(key(taxFlagTool, { action: 'flag', transactionId: 2 }));
    expect(sessionApprovalScope('memory_manage', memoryManageTool, { action: 'add' })).toEqual({ key: 'memory_manage:add', action: 'add' });
  });

  test('always-mutating and dry-run tools are scoped to the tool', () => {
    expect(sessionApprovalScope('delete_transaction', deleteTransactionTool, { id: 1 })).toEqual({ key: 'delete_transaction' });
    expect(key(entityClassifyTool, {})).toBe(key(entityClassifyTool, { dryRun: false }));
  });

  test('chain and team tools have no session approval: asked every time', () => {
    const chainTool = chainToTool({ name: 'c', description: 'd', steps: [{ id: 'a', tools: ['categorize'] }] });
    const teamTool = teamToTool({ name: 't', description: 'd', dispatcher: {}, members: [{ id: 'm', tools: ['categorize'] }] });
    expect(sessionApprovalScope(chainTool.name, chainTool, { input: 'x' })).toBeNull();
    expect(sessionApprovalScope(teamTool.name, teamTool, { query: 'x' })).toBeNull();
    // By name too, in case a wrapper drops usesTools.
    expect(sessionApprovalScope('chain_x', { mutates: true }, {})).toBeNull();
    expect(sessionApprovalScope('team_x', { mutates: true }, {})).toBeNull();
  });
});
