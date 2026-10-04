/**
 * What the operations API shows a browser tab (threat model T36, T38).
 *
 * `GET /api/mcp/operations` used to return raw `SELECT *` rows to every tab.
 * That leaked `session_generation` (the key behind another tab's grants) and
 * `grant_id`. `toOperationView` is the projection every operation response
 * goes through. It also derives "Requested by" on the SERVER, because the
 * client-reported `transport` is not evidence of where a call came from, and
 * the confirmation card must not call another tab's request "this page".
 */
import { isAgentAccessEnabled } from './global-state.js';
import { clearReadOutcome, readDeliveryRefusal, type McpOperation, type OperationKind, type OperationStatus } from './store.js';
import { principalFor } from './audit.js';
import type { Database } from '../db/compat-sqlite.js';
import { sanitizeUntrustedText } from './output.js';
import { storedCategoryLabel } from './tool-catalog.js';
import { parseNaturalQuery } from '../tools/query/transaction-search.js';

export type RequestedByKind = 'this_tab' | 'another_tab' | 'external_client' | 'chat';

export interface RequestedBy {
  kind: RequestedByKind;
  /** Human text for the card: "this tab", "another tab (…ab12)", "external MCP client", "dashboard chat". */
  label: string;
}

/** What a read-ask card shows: the full arguments, and for transaction_search what the server parsed the query into. */
export interface ReadView {
  args: Record<string, unknown>;
  filter?: Array<{ label: string; value: string }>;
}

export interface OperationView {
  id: string;
  source: string;
  tool_name: string;
  kind: OperationKind;
  summary: string | null;
  /** The quoted bank description for the card's own row. */
  bank_data: string | null;
  /** Present for `kind='read'` only. */
  read: ReadView | null;
  before_json: string | null;
  after_json: string | null;
  transaction_id: number | null;
  status: OperationStatus;
  outcome_json: string | null;
  created_at: string;
  expires_at: string;
  resolved_at: string | null;
  requestedBy: RequestedBy;
}

/** The tab viewing the operation, identified by its (header-supplied) session generation. */
export interface OperationViewer {
  sessionGeneration: string | null;
  /** Lets a read-ask card show the filter the server parsed from a natural-language query. */
  db?: Database;
  /** Looks up the label of the client token behind a `tok:<id>` session, so an external client's card names it. */
  tokenNameOf?: (sessionGeneration: string) => string | null;
}

/** Last 4 hex characters of the audit principal hash, so the card and the Activity log name a tab the same way. */
function principalSuffix(sessionGeneration: string): string {
  return principalFor(sessionGeneration).id.slice(-4);
}

export function requestedByFor(op: Pick<McpOperation, 'source' | 'session_generation'>, viewer: OperationViewer): RequestedBy {
  if (op.source === 'chat') return { kind: 'chat', label: 'dashboard chat' };
  if (op.source === 'http-mcp') {
    const name = viewer.tokenNameOf?.(op.session_generation);
    return { kind: 'external_client', label: name ? `external MCP client "${sanitizeUntrustedText(name, 40)}"` : 'external MCP client' };
  }
  if (viewer.sessionGeneration !== null && op.session_generation === viewer.sessionGeneration) {
    return { kind: 'this_tab', label: 'this tab' };
  }
  return { kind: 'another_tab', label: `another tab (…${principalSuffix(op.session_generation)})` };
}

/** The requesting principal: the tab (or token) whose session raised the operation. Only it may see a read's data. */
function isRequester(op: Pick<McpOperation, 'session_generation'>, viewer: OperationViewer): boolean {
  return viewer.sessionGeneration !== null && op.session_generation === viewer.sessionGeneration;
}

function money(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

/** transaction_search's query as the server read it, so the human approves what will actually run. */
function parsedFilter(db: Database, args: Record<string, unknown>): Array<{ label: string; value: string }> | undefined {
  if (typeof args.query !== 'string') return undefined;
  const f = parseNaturalQuery(args.query, db);
  const rows: Array<{ label: string; value: string }> = [];
  if (f.merchant) rows.push({ label: 'Merchant', value: f.merchant });
  if (f.category) rows.push({ label: 'Category', value: f.category });
  if (f.dateStart) rows.push({ label: 'From', value: f.dateStart });
  if (f.dateEnd) rows.push({ label: 'To', value: f.dateEnd });
  if (f.minAmount !== undefined) rows.push({ label: 'Amount at least', value: money(f.minAmount) });
  if (f.maxAmount !== undefined) rows.push({ label: 'Amount at most', value: money(f.maxAmount) });
  return rows;
}

function readViewOf(op: McpOperation, viewer: OperationViewer): ReadView | null {
  if (op.kind !== 'read') return null;
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(op.args_json) as Record<string, unknown>;
  } catch {
    // An unreadable row shows no arguments rather than failing the whole queue.
  }
  const filter = op.tool_name === 'transaction_search' && viewer.db ? parsedFilter(viewer.db, args) : undefined;
  return { args, ...(filter ? { filter } : {}) };
}

export function toOperationView(op: McpOperation, viewer: OperationViewer): OperationView {
  return {
    id: op.id,
    source: op.source,
    tool_name: op.tool_name,
    kind: op.kind,
    summary: op.summary,
    bank_data: op.bank_data,
    read: readViewOf(op, viewer),
    before_json: op.before_json,
    after_json: op.after_json,
    transaction_id: op.transaction_id,
    status: op.status,
    // A read's data never rides the human-facing view: the card list does not need it, and only the agent view
    // (`toAgentResolvedView`, which the route follows with `clearReadOutcome`) delivers it, once, to the requester (T36).
    outcome_json: op.kind === 'read' ? null : op.outcome_json,
    created_at: op.created_at,
    expires_at: op.expires_at,
    resolved_at: op.resolved_at,
    requestedBy: requestedByFor(op, viewer),
  };
}

/**
 * What an AGENT may learn about an operation it raised. `before_json`, the
 * summary and the stored outcome hold raw database text (a transaction's
 * description and notes), which read tools only ever return sanitized, masked,
 * budgeted and audited. Preparing a no-op edit and cancelling it must not be a
 * way around that, so the agent's copy has no row text at all: identity,
 * status, expiry, requester, and the outcome status. The human's card keeps
 * the full view (`toOperationView`, GET /api/mcp/operations).
 */
export interface AgentOperationView {
  id: string;
  status: OperationStatus;
  tool: string;
  expires_at: string;
  requestedBy: RequestedBy;
  /** Null while the operation is pending. */
  outcome: OperationStatus | null;
  /** Present (as `read`) only for a read-ask operation, so the agent knows to wait for data rather than an outcome. */
  kind?: 'read';
  /** Sanitized post-commit result. Present only on the poll after the human resolved it (`toAgentResolvedView`). */
  result?: unknown;
  /** A committed read's capped data, for the requesting principal only. Delivered once (the route clears it after). */
  data?: unknown;
}

export function toAgentOperationView(_db: Database, op: McpOperation, viewer: OperationViewer): AgentOperationView {
  return {
    id: op.id,
    status: op.status,
    tool: op.tool_name,
    expires_at: op.expires_at,
    requestedBy: requestedByFor(op, viewer),
    outcome: op.status === 'pending' ? null : op.status,
    ...(op.kind === 'read' ? { kind: 'read' as const } : {}),
  };
}

/** The agent view plus the sanitized result of a committed operation. */
export function toAgentResolvedView(db: Database, op: McpOperation, viewer: OperationViewer): AgentOperationView {
  const view = toAgentOperationView(db, op, viewer);
  if (op.status === 'pending' || op.outcome_json === null) return view;
  if (op.kind === 'read' && op.status === 'committed') {
    // Switched off: nothing is delivered, whatever a stale row still holds.
    if (!isAgentAccessEnabled()) return view;
    // The stored data was capped, sanitized and masked by executeRead when the human allowed it, so it goes out
    // as it is, and only to the principal that asked.
    if (!isRequester(op, viewer)) return view;
    // The approval's authority must still stand: a revoked or flipped-over grant gets the status alone, and the
    // stored copy goes (T36).
    if (readDeliveryRefusal(db, op) !== null) {
      clearReadOutcome(db, op.id);
      return view;
    }
    try {
      return { ...view, data: JSON.parse(op.outcome_json) };
    } catch {
      return view;
    }
  }
  return { ...view, result: sanitizeStoredOutcomeForAgent(db, op.outcome_json) };
}

const OUTCOME_TEXT_MAX = 64;

/**
 * An outcome (the `after` of a committed mutation, or a stale `reason`) as an
 * agent may see it. Numbers and booleans pass; a `category` goes through the
 * same label rule as every other category an agent reads (system names as they
 * are, custom ones only when plain, else `#id (custom)`); any other string is
 * hidden-character-stripped, PII-masked and truncated.
 */
export function sanitizeOutcomeForAgent(db: Database, value: unknown, key?: string, depth = 0): unknown {
  if (typeof value === 'string') {
    if (key === 'category') return storedCategoryLabel(db, value);
    return sanitizeUntrustedText(value, OUTCOME_TEXT_MAX);
  }
  if (depth >= 4) return '[nested]';
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => sanitizeOutcomeForAgent(db, v, key, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, sanitizeOutcomeForAgent(db, v, k, depth + 1)])
    );
  }
  return value;
}

export function sanitizeStoredOutcomeForAgent(db: Database, outcomeJson: string | null): unknown {
  if (outcomeJson === null) return undefined;
  try {
    return sanitizeOutcomeForAgent(db, JSON.parse(outcomeJson));
  } catch {
    return undefined;
  }
}
