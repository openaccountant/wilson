/**
 * Pure view-model for Settings -> Agent access and the bridge's floating
 * panel. Both surfaces read the same `GET /api/mcp/state` and render through
 * these functions, so the rules a user relies on (a viewer cannot touch change
 * tools, a change can never be Allow, what a coloured chip means) live in one
 * place and are tested without a browser.
 *
 * Import-free and DOM-free: the React build reaches it through the
 * `@agent-access-model` alias, the vanilla bridge bundles it, and root tests
 * import it directly.
 */

export type PolicyValue = 'off' | 'ask' | 'allow';
export type ToolClass = 'read' | 'mutating' | 'proposal' | 'page';

export interface AgentToolState {
  name: string;
  description: string;
  classification: string;
  /** What the user chose (or the default), already clamped by the server. */
  policy: PolicyValue;
  policyLocked: boolean;
  lockReason?: string | null;
  /** This tab's live grant for the tool, if any. */
  grant: { id: string; expiresAt: string } | null;
  /** `declarative`: a form in the page exposes it. Absent on older servers (treated as `imperative`). */
  exposure?: string;
}

/** The slice of an operation the cards need; the server's OperationView has more. */
export interface AgentPendingOperation {
  id: string;
  source: string;
  tool_name: string;
  kind?: string;
  status?: string;
  summary?: string | null;
  bank_data?: string | null;
  before_json?: string | null;
  after_json?: string | null;
  created_at?: string;
  expires_at?: string;
  requestedBy?: { kind: string; label: string } | null;
  read?: { args: Record<string, unknown>; filter?: Array<{ label: string; value: string }> } | null;
}

export interface AgentAuditEntry {
  id: number;
  ts: string;
  tier: string;
  transport: string;
  tool_name: string;
  decision: string;
  count: number;
  args_preview: string | null;
  /** Set when `tool_name` is a retired catalog name: its current name (history is shown verbatim, plus this). */
  toolCurrent?: string;
}

export interface AgentState {
  /** The global kill switch. False means no tool is exposed to any agent, in any profile. */
  enabled: boolean;
  grantTtlMinutes: number;
  ttlOptions: number[];
  /** Judge proposals allowed per day in this profile (absent on older servers). */
  judgeDailyLimit?: number;
  role: 'admin' | 'viewer';
  authEnabled: boolean;
  tools: AgentToolState[];
  pending: AgentPendingOperation[];
  auditTail: AgentAuditEntry[];
}

/**
 * `state` with its `pending` list replaced by `operations` (what `GET /api/mcp/operations` just said). The bridge's card
 * poller runs every 1.5 s while the full state refreshes every 5 s, so the panel's "N pending" would lag the cards it
 * sits next to; both lists come from the same server view, so the poller's answer is simply the fresher one. Returns
 * the SAME object when nothing changed (same ids in the same order), so an idle poll re-renders nothing.
 */
export function withPendingOperations(state: AgentState | null, operations: AgentPendingOperation[]): AgentState | null {
  if (!state) return state;
  const same = state.pending.length === operations.length && state.pending.every((op, i) => op.id === operations[i].id);
  return same ? state : { ...state, pending: operations };
}

export const VIEWER_LOCK_REASON = 'Viewer accounts cannot use tools that change data';
export const CHANGES_ALLOW_REASON = 'Changes always wait for your approval';

/** A tool that writes stored data: a change, or a judge proposal (inert rows). A page tool changes only what the tab shows, so it is not one. */
export function changesData(classification: string): boolean {
  return classification === 'mutating' || classification === 'proposal';
}

/**
 * Only a real change can never be Allow: it always waits for a card. A judge proposal may be Allow, because what it
 * inserts stays inert until a person accepts each row (so its default is still Ask).
 */
export function alwaysAsks(classification: string): boolean {
  return classification === 'mutating';
}

/** Reads that return the user's chat history: the grant row says so. */
export const DATA_WARNING_TOOLS: ReadonlySet<string> = new Set(['get_interaction', 'list_interactions']);
export const DATA_WARNING_TEXT = 'Includes your chat history and financial data';

/** A viewer may use read and page tools, never one that changes data. */
export function lockFor(classification: string, role: string): { locked: boolean; reason: string | null } {
  if (role !== 'admin' && changesData(classification)) return { locked: true, reason: VIEWER_LOCK_REASON };
  return { locked: false, reason: null };
}

// ── Tool rows ────────────────────────────────────────────────────────────────

export interface PolicyOption {
  value: PolicyValue;
  label: string;
  disabled: boolean;
  title?: string;
}

export type ClassBadge = { label: 'READ' | 'WRITE' | 'PROPOSAL' | 'PAGE'; tone: 'muted' | 'amber' | 'blue' };

export type GrantState = { kind: 'none' } | { kind: 'granted'; grantId: string; expiresAt: string };

export interface ToolRow {
  name: string;
  description: string;
  classBadge: ClassBadge;
  /** The chosen policy, with a stored Allow on a change shown as Ask (the server clamps it). */
  policy: PolicyValue;
  policyOptions: PolicyOption[];
  locked: boolean;
  lockReason: string | null;
  grantState: GrantState;
  /** Whether this tab can be granted the tool right now. */
  grantable: boolean;
  grantBlockedReason: string | null;
  /** Shown beside the tool when its reads include the user's chat history and financial data. */
  dataWarning: string | null;
}

const POLICY_LABEL: Record<PolicyValue, string> = { off: 'Off', ask: 'Ask', allow: 'Allow' };

function badgeFor(classification: string): ClassBadge {
  switch (classification) {
    case 'mutating':
      return { label: 'WRITE', tone: 'amber' };
    case 'proposal':
      return { label: 'PROPOSAL', tone: 'blue' };
    case 'page':
      return { label: 'PAGE', tone: 'muted' };
    default:
      return { label: 'READ', tone: 'muted' };
  }
}

export function buildToolRows(state: AgentState, role: string): ToolRow[] {
  return state.tools.map((tool) => {
    const viewerLock = lockFor(tool.classification, role);
    const locked = viewerLock.locked || tool.policyLocked;
    const lockReason = locked ? (viewerLock.reason ?? tool.lockReason ?? VIEWER_LOCK_REASON) : null;
    const isChange = alwaysAsks(tool.classification);
    const policy: PolicyValue = isChange && tool.policy === 'allow' ? 'ask' : tool.policy;

    const policyOptions: PolicyOption[] = (['off', 'ask', 'allow'] as const).map((value) => {
      const noAllow = isChange && value === 'allow';
      return {
        value,
        label: POLICY_LABEL[value],
        disabled: locked || noAllow,
        ...(noAllow ? { title: CHANGES_ALLOW_REASON } : locked && lockReason ? { title: lockReason } : {}),
      };
    });

    let grantBlockedReason: string | null = null;
    if (!state.enabled) grantBlockedReason = 'Agent access is off';
    else if (locked) grantBlockedReason = lockReason;
    else if (policy === 'off') grantBlockedReason = 'Turned off in your policies';

    return {
      name: tool.name,
      description: tool.description,
      classBadge: badgeFor(tool.classification),
      policy,
      policyOptions,
      locked,
      lockReason,
      grantState: tool.grant ? { kind: 'granted', grantId: tool.grant.id, expiresAt: tool.grant.expiresAt } : { kind: 'none' },
      grantable: grantBlockedReason === null,
      grantBlockedReason,
      dataWarning: DATA_WARNING_TOOLS.has(tool.name) ? DATA_WARNING_TEXT : null,
    };
  });
}

/** The bridge button's dot: red = agent access is off, green = this tab has live tools, muted = none. */
export function statusDot(state: Pick<AgentState, 'enabled' | 'tools'>): 'red' | 'green' | 'muted' {
  if (!state.enabled) return 'red';
  return state.tools.some((t) => t.grant !== null) ? 'green' : 'muted';
}

export function ttlLabel(minutes: number): string {
  if (minutes < 60) return `${minutes} minutes`;
  const hours = minutes / 60;
  return hours === 1 ? '1 hour' : `${hours} hours`;
}

// ── Activity log ─────────────────────────────────────────────────────────────

export const AUDIT_SENTINELS = ['audit_compacted', 'audit_evicted', 'deep_paging'] as const;

export type ChipTone = 'green' | 'red' | 'amber' | 'muted';

const RED = new Set(['denied_policy', 'denied_kill_switch', 'denied_grant', 'denied_role', 'rejected', 'rate_limited', 'invalid_args', 'error']);

/** Allowed and committed are green; refusals red; waiting-on-you amber; the rest quiet. */
export function auditChip(decision: string): ChipTone {
  if (decision === 'allowed' || decision === 'committed') return 'green';
  if (RED.has(decision)) return 'red';
  if (decision === 'operation_created' || decision === 'approved') return 'amber';
  return 'muted';
}

/** Imperative, declarative and page come from the calling page; http-mcp, chat and rest are set by the server. */
const CLIENT_REPORTED = new Set(['imperative', 'declarative', 'page']);
export const CLIENT_REPORTED_TITLE = 'Reported by the calling page; not verified by Wilson';

/** The decisions the Activity filter offers, in the order a person thinks about them. Sentinels are notices, not filterable calls. */
export const AUDIT_DECISION_OPTIONS = [
  'allowed', 'operation_created', 'approved', 'committed', 'rejected', 'stale', 'expired', 'cancelled',
  'denied_policy', 'denied_kill_switch', 'denied_grant', 'denied_role', 'invalid_args', 'rate_limited', 'error', 'rest_export', 'rest_write',
] as const;

const PREVIEW_MAX = 80;

export interface AuditRowView {
  kind: 'call' | 'notice';
  id: number;
  /** The raw timestamp; the UI renders it in local time. */
  timeIso: string;
  tool: string;
  decision: string;
  decisionLabel: string;
  chip: ChipTone;
  /** Only when more than one call is folded into the row. */
  count: number | null;
  transport: string;
  transportClientReported: boolean;
  transportTitle: string | null;
  preview: string;
  /** The full preview, for a `title` attribute. Plain text. */
  previewTitle: string;
  notice: string | null;
}

function noticeFor(entry: AgentAuditEntry): string {
  const n = entry.count;
  switch (entry.decision) {
    case 'audit_compacted':
      return `Older activity was summarized to save space: ${n} detailed rows became hourly totals.`;
    case 'audit_evicted':
      return `${n} of the oldest activity rows were deleted to keep the log under its size limit.`;
    default:
      return `${entry.tool_name} was paged through more than 20 pages of one query.`;
  }
}

export function formatAuditRow(entry: AgentAuditEntry): AuditRowView {
  const full = entry.args_preview ?? '';
  const sentinel = entry.tier === 'sentinel' || (AUDIT_SENTINELS as readonly string[]).includes(entry.decision);
  const clientReported = CLIENT_REPORTED.has(entry.transport);
  return {
    kind: sentinel ? 'notice' : 'call',
    id: entry.id,
    timeIso: entry.ts,
    // History is verbatim: a retired name keeps showing, with its current name beside it.
    tool: entry.toolCurrent ? `${entry.tool_name} (now ${entry.toolCurrent})` : entry.tool_name,
    decision: entry.decision,
    decisionLabel: entry.decision.replace(/_/g, ' '),
    chip: auditChip(entry.decision),
    count: entry.count > 1 ? entry.count : null,
    transport: entry.transport,
    transportClientReported: clientReported,
    transportTitle: clientReported ? CLIENT_REPORTED_TITLE : null,
    preview: full.length > PREVIEW_MAX ? `${full.slice(0, PREVIEW_MAX - 1)}…` : full,
    previewTitle: full,
    notice: sentinel ? noticeFor(entry) : null,
  };
}
