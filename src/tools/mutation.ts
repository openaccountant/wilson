import type { MutationFlag, ToolDef } from '../model/types.js';

/**
 * Mutation flags for agent tools (#152).
 *
 * A tool that writes — to the database, the filesystem, or an external
 * service — declares `mutates` next to its definition (see defineTool). The
 * approval gate (src/agent/approval-gate.ts) — used by the agent's tool
 * executor and by chain steps / team members alike — asks for approval
 * before any call for which `isMutatingCall` is true. Read-only tools declare
 * `mutates: false` explicitly: a tool with NO declaration is treated as
 * mutating (fail closed), so a new tool cannot skip the gate by omission.
 * src/__tests__/mutation-audit.ts pins the classification of every tool.
 */

/**
 * Flag for a tool whose `action` argument selects between reads and writes.
 * Lists the READ actions; anything else — including a missing or unknown
 * action — counts as a write, so the flag fails closed.
 */
export function mutatesUnlessAction(...readActions: string[]): MutationFlag {
  const reads = new Set(readActions);
  return (args) => !(typeof args?.action === 'string' && reads.has(args.action));
}

/** Flag for a tool whose `dryRun: true` previews without writing. */
export const mutatesUnlessDryRun: MutationFlag = (args) => args?.dryRun !== true;

/**
 * True when the tool can write for at least some arguments. Only an explicit
 * `mutates: false` makes a tool read-only; an omitted flag — or no tool at all
 * (an unresolved name) — counts as mutating.
 */
export function mayMutate(tool: Pick<ToolDef, 'mutates'> | undefined): boolean {
  return tool?.mutates !== false;
}

/**
 * True when this particular call may write and therefore needs approval.
 * Fails closed: an omitted flag, or a flag predicate that throws, counts as
 * mutating. An unknown tool (undefined) is not — the executor reports it as
 * not found and nothing runs.
 */
export function isMutatingCall(tool: Pick<ToolDef, 'mutates'> | undefined, args: Record<string, unknown>): boolean {
  if (!tool) return false;
  const flag = tool.mutates;
  if (typeof flag === 'function') {
    try {
      return flag(args ?? {}) !== false;
    } catch {
      return true;
    }
  }
  return flag !== false;
}

/**
 * What an 'allow-session' approval covers (#152). `key` is what the session
 * remembers; `action` is set when the approval covers a single action of a
 * tool whose writes depend on its args.
 */
export interface SessionApprovalScope {
  key: string;
  action?: string;
}

/**
 * The scope 'allow-session' would grant for this call, or null when the call
 * must be approved every time.
 * - Chain/team tools: null. What a run does is chosen by its step/member
 *   models, so each run is approved on its own (each write inside it is also
 *   gated, see src/orchestration/tool-calls.ts).
 * - Tools whose flag depends on the args (mutatesUnlessAction /
 *   mutatesUnlessDryRun): keyed by tool + action, so approving memory_manage
 *   `add` does not also allow `deactivate`, nor tax_flag `flag` allow `export`.
 * - Every other tool: keyed by the tool.
 */
export function sessionApprovalScope(
  toolName: string,
  tool: Pick<ToolDef, 'mutates' | 'usesTools'> | undefined,
  args: Record<string, unknown>,
): SessionApprovalScope | null {
  if (tool?.usesTools !== undefined || toolName.startsWith('chain_') || toolName.startsWith('team_')) return null;
  if (typeof tool?.mutates === 'function' && typeof args?.action === 'string') {
    return { key: `${toolName}:${args.action}`, action: args.action };
  }
  return { key: toolName };
}
