import { describe, test, expect, spyOn, beforeEach, afterEach } from 'bun:test';
import type { ChainDef, TeamDef } from '../orchestration/types.js';
import * as loader from '../orchestration/loader.js';
import * as licenseModule from '../licensing/license.js';
import * as chainModule from '../orchestration/chain.js';
import * as teamModule from '../orchestration/team.js';
import { chainToTool, teamToTool, getOrchestrationTools, clearOrchestrationCache } from '../orchestration/registry.js';

describe('orchestration/registry', () => {
  let discoverChainsSpy: ReturnType<typeof spyOn>;
  let discoverTeamsSpy: ReturnType<typeof spyOn>;
  let loadPaidChainStepsSpy: ReturnType<typeof spyOn>;
  let hasLicenseSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    clearOrchestrationCache();
    discoverChainsSpy = spyOn(loader, 'discoverChains').mockReturnValue([]);
    discoverTeamsSpy = spyOn(loader, 'discoverTeams').mockReturnValue([]);
    loadPaidChainStepsSpy = spyOn(loader, 'loadPaidChainSteps').mockResolvedValue(null);
    hasLicenseSpy = spyOn(licenseModule, 'hasLicense').mockReturnValue(false);
  });

  afterEach(() => {
    discoverChainsSpy?.mockRestore();
    discoverTeamsSpy?.mockRestore();
    loadPaidChainStepsSpy?.mockRestore();
    hasLicenseSpy?.mockRestore();
  });

  describe('chainToTool', () => {
    test('creates tool with correct name and description', () => {
      const chain: ChainDef = {
        name: 'monthly-report',
        description: 'Generate monthly report',
        steps: [{ id: 'step1' }],
      };

      const tool = chainToTool(chain);
      expect(tool.name).toBe('chain_monthly_report');
      expect(tool.description).toContain('monthly-report');
      expect(tool.description).toContain('Generate monthly report');
    });

    test('replaces hyphens with underscores in tool name', () => {
      const chain: ChainDef = {
        name: 'tax-loss-harvest',
        description: 'Tax loss harvesting',
        steps: [{ id: 'step1' }],
      };

      const tool = chainToTool(chain);
      expect(tool.name).toBe('chain_tax_loss_harvest');
    });

    test('tool has a schema with input field', () => {
      const chain: ChainDef = {
        name: 'test',
        description: 'Test chain',
        steps: [{ id: 'step1' }],
      };

      const tool = chainToTool(chain);
      expect(tool.schema).toBeDefined();
      const shape = (tool.schema as any).shape;
      expect(shape.input).toBeDefined();
    });

    test('tool func calls runChain and returns result', async () => {
      const runChainSpy = spyOn(chainModule, 'runChain').mockResolvedValue('chain result');
      const chain: ChainDef = {
        name: 'test-run',
        description: 'Test running',
        steps: [{ id: 'step1' }],
      };

      const tool = chainToTool(chain);
      const result = await tool.func({ input: 'test input' }, { model: 'gpt-4o' });
      expect(runChainSpy).toHaveBeenCalledWith(chain, 'test input', { model: 'gpt-4o', signal: undefined });
      expect(result).toBe('chain result');
      runChainSpy.mockRestore();
    });
  });

  describe('teamToTool', () => {
    test('creates tool with correct name and description', () => {
      const team: TeamDef = {
        name: 'research-team',
        description: 'Research financial data',
        dispatcher: { systemPrompt: 'Dispatch tasks' },
        members: [{ id: 'researcher' }],
      };

      const tool = teamToTool(team);
      expect(tool.name).toBe('team_research_team');
      expect(tool.description).toContain('research-team');
      expect(tool.description).toContain('Research financial data');
    });

    test('tool has a schema with query field', () => {
      const team: TeamDef = {
        name: 'test',
        description: 'Test team',
        dispatcher: {},
        members: [],
      };

      const tool = teamToTool(team);
      expect(tool.schema).toBeDefined();
      const shape = (tool.schema as any).shape;
      expect(shape.query).toBeDefined();
    });

    test('tool func calls runTeam and returns result', async () => {
      const runTeamSpy = spyOn(teamModule, 'runTeam').mockResolvedValue('team result');
      const team: TeamDef = {
        name: 'test-run',
        description: 'Test running',
        dispatcher: { systemPrompt: 'dispatch' },
        members: [{ id: 'm1' }],
      };

      const tool = teamToTool(team);
      const result = await tool.func({ query: 'test query' }, { model: 'gpt-4o' });
      expect(runTeamSpy).toHaveBeenCalledWith(team, 'test query', { model: 'gpt-4o', signal: undefined });
      expect(result).toBe('team result');
      runTeamSpy.mockRestore();
    });
  });

  describe('getOrchestrationTools', () => {
    test('returns empty array when no chains or teams', async () => {
      discoverChainsSpy.mockReturnValue([]);
      discoverTeamsSpy.mockReturnValue([]);

      const tools = await getOrchestrationTools();
      expect(tools).toEqual([]);
    });

    test('includes free chains', async () => {
      const freeChain: ChainDef = {
        name: 'free-chain',
        description: 'A free chain',
        steps: [{ id: 'step1' }],
        tier: 'free',
      };
      discoverChainsSpy.mockReturnValue([freeChain]);
      discoverTeamsSpy.mockReturnValue([]);

      const tools = await getOrchestrationTools();
      expect(tools.length).toBe(1);
      expect(tools[0].name).toBe('chain_free_chain');
    });

    test('skips paid chains without license', async () => {
      const paidChain: ChainDef = {
        name: 'paid-chain',
        description: 'A paid chain',
        steps: [],
        tier: 'paid',
      };
      discoverChainsSpy.mockReturnValue([paidChain]);
      discoverTeamsSpy.mockReturnValue([]);
      hasLicenseSpy.mockReturnValue(false);

      const tools = await getOrchestrationTools();
      expect(tools.length).toBe(0);
    });

    test('includes paid chains with license and fetched steps', async () => {
      const paidChain: ChainDef = {
        name: 'paid-chain',
        description: 'A paid chain',
        steps: [],
        tier: 'paid',
      };
      discoverChainsSpy.mockReturnValue([paidChain]);
      discoverTeamsSpy.mockReturnValue([]);
      hasLicenseSpy.mockReturnValue(true);
      loadPaidChainStepsSpy.mockResolvedValue([{ id: 'fetched-step' }]);

      const tools = await getOrchestrationTools();
      expect(tools.length).toBe(1);
      expect(tools[0].name).toBe('chain_paid_chain');
    });

    test('skips paid chains with license but no fetchable steps', async () => {
      const paidChain: ChainDef = {
        name: 'paid-chain',
        description: 'A paid chain',
        steps: [],
        tier: 'paid',
      };
      discoverChainsSpy.mockReturnValue([paidChain]);
      discoverTeamsSpy.mockReturnValue([]);
      hasLicenseSpy.mockReturnValue(true);
      loadPaidChainStepsSpy.mockResolvedValue(null);

      const tools = await getOrchestrationTools();
      expect(tools.length).toBe(0);
    });

    test('includes teams', async () => {
      const team: TeamDef = {
        name: 'my-team',
        description: 'My team',
        dispatcher: {},
        members: [{ id: 'member1' }],
      };
      discoverChainsSpy.mockReturnValue([]);
      discoverTeamsSpy.mockReturnValue([team]);

      const tools = await getOrchestrationTools();
      expect(tools.length).toBe(1);
      expect(tools[0].name).toBe('team_my_team');
    });

    test('combines chains and teams', async () => {
      const chain: ChainDef = {
        name: 'a-chain',
        description: 'Chain',
        steps: [{ id: 's1' }],
        tier: 'free',
      };
      const team: TeamDef = {
        name: 'a-team',
        description: 'Team',
        dispatcher: {},
        members: [{ id: 'm1' }],
      };
      discoverChainsSpy.mockReturnValue([chain]);
      discoverTeamsSpy.mockReturnValue([team]);

      const tools = await getOrchestrationTools();
      expect(tools.length).toBe(2);
      const names = tools.map((t) => t.name);
      expect(names).toContain('chain_a_chain');
      expect(names).toContain('team_a_team');
    });
  });
});
