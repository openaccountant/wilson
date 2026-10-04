import { callLlm } from '../model/llm.js';
import { CHAIN_ITERATION_CLOSING, buildOrchestrationIterationPrompt } from '../agent/iteration-prompt-format.js';
import { getToolsByNames } from '../tools/registry.js';
import type { ToolDef } from '../model/types.js';
import type { ChainDef, ChainRunOptions } from './types.js';
import { orchestrationGate, runOrchestratedToolCall, type OrchestrationGate } from './tool-calls.js';

const DEFAULT_MAX_STEP_ITERATIONS = 5;

/** Recorded on every chain call, so the judge tools know the prompt format (not 'standalone'). */
const CHAIN_CALL_TYPE = 'chain';

/** Interaction bookkeeping for one chain run: a run id and a call counter shared by all its steps. */
interface RunTrace {
  runId: string;
  next: () => number;
}

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
  trace: RunTrace,
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
      runId: trace.runId,
      sequenceNum: trace.next(),
      callType: CHAIN_CALL_TYPE,
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
    iterationPrompt = buildOrchestrationIterationPrompt(prompt, toolResults, CHAIN_ITERATION_CLOSING);
  }

  // Max iterations reached — ask for a summary without tools
  const { response: finalResponse } = await callLlm(
    `${iterationPrompt}\n\nYou've reached the iteration limit. Provide your final output now.`,
    { model, systemPrompt: stepSystemPrompt, signal, runId: trace.runId, sequenceNum: trace.next(), callType: CHAIN_CALL_TYPE },
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
  let seq = 0;
  const trace: RunTrace = { runId: `chain-${crypto.randomUUID()}`, next: () => ++seq };

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
      trace,
    );

    options.onStepComplete?.(step.id, currentInput);
  }

  return currentInput;
}
