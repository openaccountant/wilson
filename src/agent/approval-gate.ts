import type { ToolDef } from '../model/types.js';
import { isMutatingCall, sessionApprovalScope } from '../tools/mutation.js';
import type { ApprovalDecision, ToolApprovalRequest } from './types.js';

/** Answers a tool approval request (the runner's approval card, or a fixed policy). */
export type ToolApprovalHandler = (request: ToolApprovalRequest) => Promise<ApprovalDecision>;

/**
 * Outcome of the approval gate for one tool call.
 * - `asked`: a request went to the handler (or would have, with none: denied).
 *   False when the call is read-only or already approved for the session.
 * - `decision`: what was decided; null when nothing was asked.
 */
export interface ApprovalGateResult {
  asked: boolean;
  decision: ApprovalDecision | null;
  allowed: boolean;
}

/**
 * The approval gate every agent tool call passes before it runs (#152): the
 * main agent's executor (src/agent/tool-executor.ts) and the step/member
 * agents of chains and teams (src/orchestration/tool-calls.ts) both call this,
 * so a call made inside a chain is gated exactly like one the agent makes.
 *
 * A mutating call (src/tools/mutation.ts::isMutatingCall) needs the user's
 * approval unless 'allow-session' already covers it. With no handler the
 * call is denied — fail closed. 'allow-session' is remembered in
 * `sessionApprovedTools` only when the call has a session scope.
 */
export async function gateToolCall(
  toolName: string,
  tool: ToolDef | undefined,
  args: Record<string, unknown>,
  requestToolApproval: ToolApprovalHandler | undefined,
  sessionApprovedTools: Set<string> | undefined,
): Promise<ApprovalGateResult> {
  if (!isMutatingCall(tool, args)) return { asked: false, decision: null, allowed: true };
  const session = sessionApprovalScope(toolName, tool, args);
  if (session && sessionApprovedTools?.has(session.key)) return { asked: false, decision: null, allowed: true };

  const decision = (await requestToolApproval?.({ tool: toolName, args, session })) ?? 'deny';
  if (decision === 'allow-session' && session) {
    // Only this tool (or tool + action): approving bulk categorize for the
    // session must not also wave through delete_transaction, nor memory_manage
    // `add` allow `deactivate`. Chain/team calls have no session scope, so
    // 'allow-session' there counts as once.
    sessionApprovedTools?.add(session.key);
  }
  return { asked: true, decision, allowed: decision !== 'deny' };
}

/**
 * Wrap a handler so its requests are answered one at a time, in order. A team
 * runs its members in parallel, but the agent runner holds a single approval
 * slot and denies a request that arrives while another is pending; queueing
 * here gives each member's call its own card instead. Once `signal` is
 * aborted, queued and new requests are denied without asking.
 */
export function serializeApprovals(
  handler: ToolApprovalHandler | undefined,
  signal?: AbortSignal,
): ToolApprovalHandler | undefined {
  if (!handler) return undefined;
  let queue: Promise<unknown> = Promise.resolve();
  return (request) => {
    const answer = queue.then(() =>
      signal?.aborted ? ('deny' as ApprovalDecision) : handler(request),
    );
    queue = answer.catch(() => undefined);
    return answer;
  };
}
