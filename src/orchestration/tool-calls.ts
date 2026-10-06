import type { ToolCall, ToolDef, ToolInvokeConfig } from '../model/types.js';
import { gateToolCall, serializeApprovals, type ToolApprovalHandler } from '../agent/approval-gate.js';
import { logger } from '../utils/logger.js';

/**
 * How a chain step or team member reaches the parent agent's approval gate.
 * Built once per chain/team run (see orchestrationGate).
 */
export interface OrchestrationGate {
  requestToolApproval?: ToolApprovalHandler;
  sessionApprovedTools?: Set<string>;
  signal?: AbortSignal;
  model?: string;
}

/**
 * The gate for one chain/team run: the parent's handler, serialized so
 * parallel team members ask one at a time, and denying once the run is
 * cancelled. With no handler (headless, or a surface that cannot prompt)
 * every mutating call is denied.
 */
export function orchestrationGate(options: {
  requestToolApproval?: ToolApprovalHandler;
  sessionApprovedTools?: Set<string>;
  signal?: AbortSignal;
  model?: string;
}): OrchestrationGate {
  return {
    requestToolApproval: serializeApprovals(options.requestToolApproval, options.signal),
    sessionApprovedTools: options.sessionApprovedTools,
    signal: options.signal,
    model: options.model,
  };
}

export const DENIED_RESULT =
  'Denied: this call needs the user\'s approval and was not approved, so it did not run and nothing was changed. ' +
  'Do not retry it; continue without it.';

/**
 * Run one tool call made by a chain step or team member and return the line
 * fed back to that step's model. Every call passes the same approval gate as
 * the main agent (src/agent/approval-gate.ts): each mutating call gets its own
 * approval request naming the real tool and args, and a denied call becomes
 * the tool result instead of ending the step. Nested chains/teams receive the
 * gate through the invoke config, so their inner calls are gated too.
 */
export async function runOrchestratedToolCall(
  tc: ToolCall,
  toolMap: Map<string, ToolDef>,
  gate: OrchestrationGate,
): Promise<string> {
  const tool = toolMap.get(tc.name);
  if (!tool) return `[${tc.name}] Error: Tool not found`;

  let allowed: boolean;
  try {
    const handler = gate.signal?.aborted ? undefined : gate.requestToolApproval;
    ({ allowed } = await gateToolCall(tc.name, tool, tc.args, handler, gate.sessionApprovedTools));
  } catch (err) {
    // A handler that fails cannot have approved anything: fail closed.
    logger.warn(`Orchestration approval failed; denying ${tc.name}`, {
      error: err instanceof Error ? err.message : String(err),
    });
    allowed = false;
  }
  if (!allowed) {
    logger.info(`Orchestration tool call denied: ${tc.name}`, { tool: tc.name });
    return `[${tc.name}] ${DENIED_RESULT}`;
  }

  const config: ToolInvokeConfig = {
    ...(gate.signal ? { signal: gate.signal } : {}),
    ...(gate.model ? { model: gate.model } : {}),
    ...(gate.requestToolApproval ? { requestToolApproval: gate.requestToolApproval } : {}),
    ...(gate.sessionApprovedTools ? { sessionApprovedTools: gate.sessionApprovedTools } : {}),
  };
  try {
    const result = await tool.func(tc.args, config);
    return `[${tc.name}] ${result}`;
  } catch (err) {
    return `[${tc.name}] Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}
