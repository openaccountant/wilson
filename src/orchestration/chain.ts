import { callLlm } from '../model/llm.js';
import { getToolsByNames } from '../tools/registry.js';
import type { ToolDef } from '../model/types.js';
import type { ChainDef, ChainRunOptions } from './types.js';
import { orchestrationGate, runOrchestratedToolCall, type OrchestrationGate } from './tool-calls.js';

const DEFAULT_MAX_STEP_ITERATIONS = 5;

/**
 * Run a single step as a mini agent loop.
 * The step agent can call tools up to maxIterations times, then must produce a text answer.
 * Every tool call passes the parent agent's approval gate (see tool-calls.ts).
 */
async function runStepAgent(
  stepId: string,
  systemPrompt: string | undefined,
  currentInput: string,
  originalQuery: string,
  tools: ToolDef[],
  model: string | undefined,
  maxIterations: number,
  gate: OrchestrationGate,
): Promise<string> {
  const signal = gate.signal;
  const stepSystemPrompt =
    systemPrompt ??
    'You are a step in a multi-step financial analysis pipeline. Complete your assigned task concisely.';

  const prompt = tools.length > 0
    ? `Original query: ${originalQuery}\n\nCurrent task input:\n${currentInput}\n\nUse the available tools to complete this step, then provide your output.`
    : `Original query: ${originalQuery}\n\nCurrent task input:\n${currentInput}\n\nProvide your analysis and output.`;

  let iterationPrompt = prompt;

  for (let i = 0; i < maxIterations; i++) {
    const { response } = await callLlm(iterationPrompt, {
      model,
      systemPrompt: stepSystemPrompt,
      tools: tools.length > 0 ? tools : undefined,
      signal,
    });

    // No tool calls → this is the step's final output
    if (response.toolCalls.length === 0) {
      return response.content;
    }

    // Execute tool calls (each through the approval gate) and collect results
    const toolResults: string[] = [];
    const toolMap = new Map(tools.map((t) => [t.name, t]));

    for (const tc of response.toolCalls) {
      toolResults.push(await runOrchestratedToolCall(tc, toolMap, gate));
    }

    // Feed tool results back for next iteration
    iterationPrompt = `${prompt}\n\nTool results:\n${toolResults.join('\n\n')}\n\nBased on these results, continue your analysis or provide your final output.`;
  }

  // Max iterations reached — ask for a summary without tools
  const { response: finalResponse } = await callLlm(
    `${iterationPrompt}\n\nYou've reached the iteration limit. Provide your final output now.`,
    { model, systemPrompt: stepSystemPrompt, signal },
  );
  return finalResponse.content;
}

/**
 * Run a chain: sequential pipeline where each step's output flows into the next.
 */
export async function runChain(
  chain: ChainDef,
  input: string,
  options: ChainRunOptions = {},
): Promise<string> {
  let currentInput = input;
  // One gate for the whole run: approvals are asked one at a time and denied
  // once the run is cancelled; with no handler, mutating calls are denied.
  const gate = orchestrationGate(options);

  for (const step of chain.steps) {
    const tools = step.tools ? await getToolsByNames(step.tools) : [];
    const model = step.model ?? options.model;
    const maxIterations = step.maxIterations ?? DEFAULT_MAX_STEP_ITERATIONS;

    currentInput = await runStepAgent(
      step.id,
      step.systemPrompt,
      currentInput,
      input,
      tools,
      model,
      maxIterations,
      { ...gate, model },
    );

    options.onStepComplete?.(step.id, currentInput);
  }

  return currentInput;
}
