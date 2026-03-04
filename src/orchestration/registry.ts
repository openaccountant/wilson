import { z } from 'zod';
import { defineTool } from '../tools/define-tool.js';
import type { ToolDef } from '../model/types.js';
import type { ChainDef, TeamDef } from './types.js';
import { runChain } from './chain.js';
import { runTeam } from './team.js';
import { discoverChains, discoverTeams, loadPaidChainSteps } from './loader.js';
import { hasLicense } from '../licensing/license.js';

/**
 * Convert a chain definition into a tool that the main agent can invoke.
 */
export function chainToTool(chain: ChainDef): ToolDef {
  const toolName = `chain_${chain.name.replace(/-/g, '_')}`;

  return defineTool({
    name: toolName,
    description: `Run the "${chain.name}" chain: ${chain.description}`,
    schema: z.object({
      input: z.string().describe('Input for the chain (e.g., file path, query, or context)'),
    }),
    func: async ({ input }, config) => {
      const result = await runChain(chain, input, {
        model: config?.model,
        signal: config?.signal,
      });
      return result;
    },
  });
}

/**
 * Convert a team definition into a tool that the main agent can invoke.
 */
export function teamToTool(team: TeamDef): ToolDef {
  const toolName = `team_${team.name.replace(/-/g, '_')}`;

  return defineTool({
    name: toolName,
    description: `Run the "${team.name}" team: ${team.description}`,
    schema: z.object({
      query: z.string().describe('Query or task for the team to work on'),
    }),
    func: async ({ query }, config) => {
      const result = await runTeam(team, query, {
        model: config?.model,
        signal: config?.signal,
      });
      return result;
    },
  });
}

/**
 * Discover all chains and teams, convert them to tools.
 * Skips paid chains/teams that the user doesn't have a license for.
 * For paid chains with a valid license, fetches steps from the server.
 */
export async function getOrchestrationTools(): Promise<ToolDef[]> {
  const tools: ToolDef[] = [];

  for (const chain of discoverChains()) {
    // Skip unlicensed paid chains
    if (chain.tier === 'paid' && !hasLicense(chain.name)) {
      continue;
    }

    // For paid chains with license, fetch steps from server
    if (chain.tier === 'paid' && chain.steps.length === 0) {
      const steps = await loadPaidChainSteps(chain.name);
      if (steps && steps.length > 0) {
        chain.steps = steps;
      } else {
        continue; // Can't run without steps
      }
    }

    tools.push(chainToTool(chain));
  }

  for (const team of discoverTeams()) {
    tools.push(teamToTool(team));
  }

  return tools;
}
