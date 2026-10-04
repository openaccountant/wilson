/**
 * Per-tool policy: Off / Ask every time / Allow, per user, per profile (spec
 * section 1.2). A policy is a CHOICE layered on top of grants, never a
 * replacement for one: a call still needs a live grant.
 *
 *   effective = kill switch off ? 'off' : clamp(user's stored policy ?? tool default)
 *
 *  - reads (and page tools, which change only what the tab shows) can be Off, Ask or Allow
 *    (default Allow: the per-tab grant is the consent);
 *  - anything that changes data can be Off or Ask. `allow` is refused when set and
 *    clamped to `ask` if a row says it anyway ("Changes always wait for your approval");
 *  - a /mcp-only lookup (get_operation_result) cannot Ask: it reports on a change the
 *    client already proposed.
 *
 * `user_key` is the dashboard user id, or 0 while auth is disabled, so one
 * user's choices never reach another's. A user with no row of their own inherits the
 * auth-off (0) row, so enabling auth never undoes an Off. A viewer may only set policies on read tools.
 */
import type { Database } from '../db/compat-sqlite.js';
import { MCP_TOOL_CATALOG, getToolDef, isChangeTool, type McpToolDef, type ToolPolicy } from './tool-catalog.js';
import { isAgentAccessEnabled } from './global-state.js';
import { lockFor } from '../dashboard/agent-access-model.js';
import { markOperationStatus, type McpOperation, type Role } from './store.js';
import { appendAudit } from './audit.js';

export type Policy = ToolPolicy;
export const POLICIES: readonly Policy[] = ['off', 'ask', 'allow'];

/** Who is changing a policy. With auth off every local session is the same admin (`authEnabled: false`). */
export interface PolicyActor {
  userId: number | null;
  role: Role;
  authEnabled: boolean;
}

export type PolicyResult =
  | { ok: true; tool: string; policy: Policy; effective: Policy }
  | { ok: false; status: number; code: 'unknown_tool' | 'invalid_args' | 'role_forbidden'; error: string };

export const CHANGES_NEED_APPROVAL = 'Changes always require approval; choose Ask or Off.';

const userKeyOf = (userId: number | null): number => userId ?? 0;

/** The policies a tool can take. */
export function allowedPolicies(def: Pick<McpToolDef, 'classification' | 'transports'>): Policy[] {
  if (isChangeTool(def)) return ['off', 'ask'];
  return def.transports.includes('webmcp') ? ['off', 'ask', 'allow'] : ['off', 'allow'];
}

function clamp(def: McpToolDef, policy: Policy): Policy {
  const allowed = allowedPolicies(def);
  if (allowed.includes(policy)) return policy;
  // Not offered for this tool: the safer neighbour. A change never runs without a card; a lookup has no card to show.
  return policy === 'allow' ? 'ask' : 'allow';
}

function storedRow(db: Database, userKey: number, tool: string): Policy | null {
  const row = db
    .prepare('SELECT policy FROM mcp_tool_policies WHERE user_key = @userKey AND tool_name = @tool')
    .get({ userKey, tool }) as { policy: Policy } | undefined;
  return row && POLICIES.includes(row.policy) ? row.policy : null;
}

/**
 * The user's own row, else (for a real user) the row saved while auth was off (`user_key` 0). Enabling auth is
 * meant to tighten things, so a tool the owner turned Off or to Ask before auth does not snap back to its default
 * the moment the first account exists. A user's own choice always wins.
 */
function storedPolicy(db: Database, userId: number | null, tool: string): Policy | null {
  const own = storedRow(db, userKeyOf(userId), tool);
  if (own !== null || userId === null) return own;
  return storedRow(db, 0, tool);
}

/** What the user chose (or the tool's default), clamped. Ignores the kill switch: this is what the table shows. */
export function getConfiguredPolicy(db: Database, userId: number | null, tool: string): Policy {
  const def = getToolDef(tool);
  if (!def) return 'off';
  return clamp(def, storedPolicy(db, userId, tool) ?? def.defaultPolicy);
}

/** What the engine enforces: `off` for every tool while the kill switch is off. */
export function getEffectivePolicy(db: Database, userId: number | null, tool: string): Policy {
  if (!isAgentAccessEnabled()) return 'off';
  return getConfiguredPolicy(db, userId, tool);
}

export function setPolicy(db: Database, actor: PolicyActor, tool: string, policy: string): PolicyResult {
  const def = getToolDef(tool);
  if (!def) return { ok: false, status: 404, code: 'unknown_tool', error: `Unknown tool "${tool.slice(0, 30)}"` };
  if (!(POLICIES as readonly string[]).includes(policy)) {
    return { ok: false, status: 400, code: 'invalid_args', error: 'policy must be one of: off, ask, allow' };
  }
  const lock = lockFor(def.classification, actor.role);
  if (lock.locked) return { ok: false, status: 403, code: 'role_forbidden', error: lock.reason! };
  const wanted = policy as Policy;
  if (!allowedPolicies(def).includes(wanted)) {
    const error = isChangeTool(def) ? CHANGES_NEED_APPROVAL : `${def.name} cannot ask: choose Off or Allow.`;
    return { ok: false, status: 400, code: 'invalid_args', error };
  }
  db.prepare(`
    INSERT INTO mcp_tool_policies (user_key, tool_name, policy, updated_at) VALUES (@userKey, @tool, @policy, datetime('now'))
    ON CONFLICT(user_key, tool_name) DO UPDATE SET policy = excluded.policy, updated_at = excluded.updated_at
  `).run({ userKey: userKeyOf(actor.userId), tool, policy: wanted });
  // Off beats a card that is already waiting: approving it later would run a tool the user has since turned off.
  if (wanted === 'off') rejectPendingForTool(db, actor.userId, def.name, def.classification);
  return { ok: true, tool, policy: wanted, effective: getEffectivePolicy(db, actor.userId, tool) };
}

/**
 * Reject this user's pending agent operations (WebMCP tab or /mcp client; dashboard chat answers through its own
 * promise) for a tool just set Off, recording `{reason:'policy_off'}` and an audit row each. The engine's commit
 * path refuses such an operation too (`commitWebMcpOperation`), for a row this sweep never saw.
 */
function rejectPendingForTool(db: Database, userId: number | null, tool: string, classification: McpToolDef['classification']): string[] {
  const rows = db
    .prepare("SELECT * FROM mcp_operations WHERE status = 'pending' AND source != 'chat' AND tool_name = @tool AND user_id IS @userId")
    .all({ tool, userId }) as McpOperation[];
  for (const op of rows) {
    markOperationStatus(db, op.id, 'rejected', { reason: 'policy_off' });
    try {
      appendAudit(db, {
        transport: 'rest',
        principalKind: 'user',
        principalId: `user:${userId ?? 'anon'}`,
        userId,
        role: op.role,
        origin: op.origin,
        toolName: tool,
        classification,
        decision: 'rejected',
        operationId: op.id,
        grantId: op.grant_id,
        argsPreview: 'policy_off',
      });
    } catch (err) {
      console.error('[mcp-audit] failed to write policy_off row:', err);
    }
  }
  return rows.map((r) => r.id);
}

export interface PolicyRow {
  tool: string;
  /** What the user chose (or the default), clamped. */
  policy: Policy;
  /** What is enforced right now (Off for everything while the kill switch is off). */
  effective: Policy;
}

/** Every catalog tool's configured and effective policy for this user, in catalog order. */
export function listPolicies(db: Database, userId: number | null): PolicyRow[] {
  return MCP_TOOL_CATALOG.map((def) => ({
    tool: def.name,
    policy: getConfiguredPolicy(db, userId, def.name),
    effective: getEffectivePolicy(db, userId, def.name),
  }));
}
