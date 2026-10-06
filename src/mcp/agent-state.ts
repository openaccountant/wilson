/**
 * The one snapshot both agent-access surfaces render from (`GET /api/mcp/state`):
 * Settings -> Agent access and the bridge's floating panel. Because both read
 * this, they cannot disagree about whether agent access is on, what a tool's
 * policy is, which grants this tab holds, or what is waiting for approval.
 */
import type { Database } from '../db/compat-sqlite.js';
import { MCP_TOOL_CATALOG } from './tool-catalog.js';
import { listActiveGrants, isAgentAccessEnabled, type OperationActor, type RequestScope } from './engine.js';
import { getConfiguredPolicy } from './policies.js';
import { GRANT_TTL_OPTIONS, getGrantTtlMinutes, getJudgeDailyLimit } from './agent-settings.js';
import { toOperationView, type OperationView, type OperationViewer } from './operation-view.js';
import { listAudit, type AuditEntry } from './audit.js';
import { lockFor } from '../dashboard/agent-access-model.js';
import type { McpOperation } from './store.js';

export interface AgentStateTool {
  name: string;
  description: string;
  classification: string;
  policy: 'off' | 'ask' | 'allow';
  policyLocked: boolean;
  lockReason?: string;
  grant: { id: string; expiresAt: string } | null;
  exposure: 'imperative' | 'declarative';
}

export interface AgentStateBody {
  enabled: boolean;
  grantTtlMinutes: number;
  ttlOptions: number[];
  /** How many judge proposals may be inserted per day in this profile. Changed only from Settings, by an admin. */
  judgeDailyLimit: number;
  role: 'admin' | 'viewer';
  authEnabled: boolean;
  tools: AgentStateTool[];
  pending: OperationView[];
  auditTail: AuditEntry[];
}

/** Rows shown in the bridge panel's "last activity" section and Settings' collapsed header. */
export const AUDIT_TAIL_LIMIT = 5;

export function buildAgentState(
  db: Database,
  input: {
    /** The requesting tab's scope. A request with no tab session passes an empty `sessionGeneration`, so no grant matches. */
    scope: RequestScope;
    actor: OperationActor;
    viewer: OperationViewer;
    pending: McpOperation[];
  }
): AgentStateBody {
  const { scope, actor, viewer } = input;
  const grants = scope.sessionGeneration ? listActiveGrants(db, scope) : [];
  const grantByTool = new Map(grants.map((g) => [g.tool_name, g]));

  // Only tools a tab can use. /mcp-only tools (get_operation_result) belong to client tokens.
  const tools: AgentStateTool[] = MCP_TOOL_CATALOG.filter((def) => def.transports.includes('webmcp')).map((def) => {
    const lock = lockFor(def.classification, actor.role);
    const grant = grantByTool.get(def.name);
    return {
      name: def.name,
      description: def.description,
      classification: def.classification,
      policy: getConfiguredPolicy(db, actor.userId, def.name),
      policyLocked: lock.locked,
      ...(lock.reason ? { lockReason: lock.reason } : {}),
      grant: grant ? { id: grant.id, expiresAt: grant.expires_at } : null,
      exposure: def.exposure,
    };
  });

  return {
    enabled: isAgentAccessEnabled(),
    grantTtlMinutes: getGrantTtlMinutes(),
    ttlOptions: [...GRANT_TTL_OPTIONS],
    judgeDailyLimit: getJudgeDailyLimit(),
    role: actor.role,
    authEnabled: actor.authEnabled,
    tools,
    pending: input.pending.map((op) => toOperationView(op, viewer)),
    // A viewer sees only their own rows, as on GET /api/mcp/audit.
    auditTail: listAudit(db, { limit: AUDIT_TAIL_LIMIT, restrictToUserId: actor.authEnabled && actor.role !== 'admin' ? actor.userId : undefined }).entries,
  };
}
