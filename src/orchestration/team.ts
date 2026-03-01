import { z } from 'zod';
import { callLlm } from '../model/llm.js';
import { getToolsByNames } from '../tools/registry.js';
import type { ToolDef } from '../model/types.js';
import type { TeamDef, TeamRunOptions } from './types.js';

const DEFAULT_MAX_MEMBER_ITERATIONS = 5;

/**
 * Schema for the dispatcher to assign subtasks to team members.
 */
const dispatchSchema = z.object({
  assignments: z.array(
    z.object({
      memberId: z.string().describe('ID of the team member to assign this subtask to'),
      subtask: z.string().describe('Description of the subtask for this member'),
    })
  ),
});

/**
 * Run a single team member as a mini agent loop (same pattern as chain steps).
 */
async function runMember(
  memberId: string,
  subtask: string,
  originalQuery: string,
  tools: ToolDef[],
  systemPrompt: string | undefined,
  model: string | undefined,
  maxIterations: number,
  signal?: AbortSignal,
): Promise<string> {
  const memberSystemPrompt =
    systemPrompt ??
    'You are a specialist on a financial analysis team. Complete your assigned subtask thoroughly and concisely.';

  const prompt = `Original query: ${originalQuery}\n\nYour assigned subtask: ${subtask}\n\nUse the available tools to complete this subtask, then provide your findings.`;

  let iterationPrompt = prompt;

  for (let i = 0; i < maxIterations; i++) {
    const { response } = await callLlm(iterationPrompt, {
      model,
      systemPrompt: memberSystemPrompt,
      tools: tools.length > 0 ? tools : undefined,
      signal,
    });

    // No tool calls → member's final output
    if (response.toolCalls.length === 0) {
      return response.content;
    }

    // Execute tool calls
    const toolResults: string[] = [];
    const toolMap = new Map(tools.map((t) => [t.name, t]));

    for (const tc of response.toolCalls) {
      const tool = toolMap.get(tc.name);
      if (!tool) {
        toolResults.push(`[${tc.name}] Error: Tool not found`);
        continue;
      }
      try {
        const result = await tool.func(tc.args);
        toolResults.push(`[${tc.name}] ${result}`);
      } catch (err) {
        toolResults.push(`[${tc.name}] Error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    iterationPrompt = `${prompt}\n\nTool results:\n${toolResults.join('\n\n')}\n\nBased on these results, continue or provide your final findings.`;
  }

  // Max iterations — force final output
  const { response: finalResponse } = await callLlm(
    `${iterationPrompt}\n\nYou've reached the iteration limit. Provide your final findings now.`,
    { model, systemPrompt: systemPrompt ?? 'Provide your final findings.', signal },
  );
  return finalResponse.content;
}

/**
 * Run a team: dispatcher assigns subtasks, members run in parallel, dispatcher synthesizes.
 */
export async function runTeam(
  team: TeamDef,
  query: string,
  options: TeamRunOptions = {},
): Promise<string> {
  const dispatcherModel = team.dispatcher.model ?? options.model;

  // 1. Dispatcher assigns subtasks to members
  const memberDescriptions = team.members
    .map((m) => `- ${m.id}: tools=[${(m.tools ?? []).join(', ')}]${m.systemPrompt ? ` (${m.systemPrompt})` : ''}`)
    .join('\n');

  const dispatchPrompt = `You are coordinating a team of specialists to answer this query:

"${query}"

Available team members:
${memberDescriptions}

Assign a specific subtask to each relevant member. Not all members need to be used.`;

  const { response: dispatchResponse } = await callLlm(dispatchPrompt, {
    model: dispatcherModel,
    systemPrompt: team.dispatcher.systemPrompt ?? 'You coordinate financial analysis specialists. Assign clear, specific subtasks.',
    outputSchema: dispatchSchema,
  });

  const assignments = (dispatchResponse.structured as z.infer<typeof dispatchSchema>)?.assignments ?? [];

  if (assignments.length === 0) {
    // No assignments — dispatcher answers directly
    return dispatchResponse.content || 'No subtasks were assigned.';
  }

  // 2. Run assigned members in parallel
  const memberMap = new Map(team.members.map((m) => [m.id, m]));

  const memberPromises = assignments
    .filter((a) => memberMap.has(a.memberId))
    .map(async (assignment) => {
      const member = memberMap.get(assignment.memberId)!;
      const tools = member.tools ? getToolsByNames(member.tools) : [];
      const model = member.model ?? options.model;
      const maxIterations = member.maxIterations ?? DEFAULT_MAX_MEMBER_ITERATIONS;

      const result = await runMember(
        member.id,
        assignment.subtask,
        query,
        tools,
        member.systemPrompt,
        model,
        maxIterations,
        options.signal,
      );

      options.onMemberComplete?.(member.id, result);
      return { memberId: member.id, subtask: assignment.subtask, result };
    });

  const memberResults = await Promise.all(memberPromises);

  // 3. Dispatcher synthesizes results
  const resultsText = memberResults
    .map((r) => `## ${r.memberId}\nSubtask: ${r.subtask}\n\nFindings:\n${r.result}`)
    .join('\n\n---\n\n');

  const synthesisPrompt = `Original query: "${query}"

Your team members have completed their analysis:

${resultsText}

Synthesize these findings into a comprehensive, actionable answer.`;

  const { response: synthesisResponse } = await callLlm(synthesisPrompt, {
    model: dispatcherModel,
    systemPrompt: team.dispatcher.systemPrompt ?? 'Synthesize your team\'s findings into a clear, actionable answer.',
  });

  return synthesisResponse.content;
}
