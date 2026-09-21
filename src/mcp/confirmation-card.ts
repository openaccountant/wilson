/**
 * Pure content model for the WebMCP confirmation card — the single visible
 * confirmation surface for every mutating call (WebMCP tool call, HTTP-MCP
 * fallback, dashboard chat). Zero imports, browser-safe: the in-page bridge
 * (src/dashboard/webmcp-bridge.ts) assembles DOM from this model, and the
 * root test-suite pins the content without a browser.
 *
 * The card always renders what the SERVER computed in `prepare` — the tool's
 * human label, who requested it, the summary line naming the exact change
 * (which transaction, from/to), and the structured before/after delta. It
 * never renders agent-provided prose: the summary is the server's own
 * prepareMutation output, persisted on the operation row.
 */

export interface ConfirmationCardOperation {
  source: string;
  tool_name: string;
  summary?: string | null;
  before_json?: string | null;
  after_json?: string | null;
}

export interface ConfirmationCardDeltaRow {
  field: string;
  from: string;
  to: string;
}

export interface ConfirmationCardModel {
  /** e.g. "Categorize Transaction" — human label, falling back to the raw tool name. */
  title: string;
  /** e.g. "this page (WebMCP)" — who proposed the mutation. */
  sourceLabel: string;
  /** Server-computed summary line, or null when prepare produced none (chat-shaped ops). */
  summary: string | null;
  /**
   * Field-level from/to rows. Null means prepare produced no structured delta
   * at all ("No structured delta available for this action."); an empty array
   * means a delta existed but changed no fields ("No fields changed.").
   */
  deltaRows: ConfirmationCardRowSet | null;
}

export interface ConfirmationCardRowSet {
  rows: ConfirmationCardDeltaRow[];
}

/** Human label per catalog tool — mirrors src/mcp/tool-catalog.ts names. */
const TOOL_LABELS: Record<string, string> = {
  categorize_transaction: 'Categorize Transaction',
  edit_transaction: 'Edit Transaction',
  tax_flag: 'Tax Flag',
};

/** Same display rules as the bridge's original renderDelta — extracted verbatim so rendering can't drift. */
export function formatValue(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function sourceLabelFor(source: string): string {
  if (source === 'chat') return 'dashboard chat';
  if (source === 'http-mcp') return 'external MCP client';
  return 'this page (WebMCP)';
}

export function confirmationCardModel(op: ConfirmationCardOperation): ConfirmationCardModel {
  const title = TOOL_LABELS[op.tool_name] ?? op.tool_name;

  let deltaRows: ConfirmationCardRowSet | null = null;
  const before: unknown = op.before_json ? JSON.parse(op.before_json) : null;
  const after: unknown = op.after_json ? JSON.parse(op.after_json) : null;
  if (!(before === null && after === null)) {
    // Same fallback rules as the bridge's renderDelta: a null side contributes no keys.
    const beforeObj = (before ?? {}) as Record<string, unknown>;
    const afterObj = (after ?? {}) as Record<string, unknown>;
    const keys = [...new Set([...Object.keys(beforeObj), ...Object.keys(afterObj)])];
    deltaRows = {
      rows: keys.map((key) => ({
        field: key,
        from: formatValue(beforeObj[key]),
        to: formatValue(afterObj[key]),
      })),
    };
  }

  return {
    title,
    sourceLabel: sourceLabelFor(op.source),
    summary: op.summary ?? null,
    deltaRows,
  };
}