import { Container, Text } from '@mariozechner/pi-tui';
import type { ApprovalDecision } from '../agent/types.js';
import type { SessionApprovalScope } from '../tools/mutation.js';
import { createApprovalSelector } from './select-list.js';
import { theme } from '../theme.js';

function formatToolLabel(tool: string): string {
  return tool
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * What the "don't ask again" option covers, for its label: the tool, or the
 * tool and action ("Memory Manage (add)"). Null when there is no session
 * option (chain/team tools).
 */
export function sessionApprovalLabel(tool: string, session: SessionApprovalScope | null): string | null {
  if (!session) return null;
  return session.action ? `${formatToolLabel(tool)} (${session.action})` : formatToolLabel(tool);
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/**
 * Delta from a prepare step (src/mcp/tool-catalog.ts::prepareMutation), for
 * tools that resolve a single record and know exactly what's changing.
 */
export interface ApprovalDelta {
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

/**
 * Build the lines this prompt renders below the tool name. Prefers an
 * actual before/after delta when one is available; otherwise falls back to
 * listing the call's own arguments — meaningful for *any* tool, unlike the
 * old hardcoded `args.path` (built for file-editing tools and meaningless
 * for a transaction mutation like categorize/tax_flag/edit_transaction).
 */
export function describeApproval(args: Record<string, unknown>, delta?: ApprovalDelta): string[] {
  if (delta) {
    const before = delta.before ?? {};
    const after = delta.after ?? {};
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    if (keys.size === 0) return ['No fields changed.'];
    return [...keys].map((key) => `  ${key}: ${formatValue(before[key])} → ${theme.bold(formatValue(after[key]))}`);
  }

  const entries = Object.entries(args).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return ['(no arguments)'];
  return entries.map(([key, value]) => `  ${key}: ${formatValue(value)}`);
}

export class ApprovalPromptComponent extends Container {
  readonly selector: any;
  onSelect?: (decision: ApprovalDecision) => void;

  /**
   * `session` is what 'allow-session' would cover (ToolApprovalRequest.session);
   * null removes that option. Omitted = the whole tool.
   */
  constructor(tool: string, args: Record<string, unknown>, delta?: ApprovalDelta, session?: SessionApprovalScope | null) {
    super();
    const sessionLabel = session === undefined ? formatToolLabel(tool) : sessionApprovalLabel(tool, session);
    this.selector = createApprovalSelector((decision) => this.onSelect?.(decision), sessionLabel);
    const width = Math.max(20, process.stdout.columns ?? 80);
    const border = theme.warning('─'.repeat(width));

    this.addChild(new Text(border, 0, 0));
    this.addChild(new Text(theme.warning(theme.bold('Permission required')), 0, 0));
    this.addChild(new Text(formatToolLabel(tool), 0, 0));
    for (const line of describeApproval(args, delta)) {
      this.addChild(new Text(theme.muted(line), 0, 0));
    }
    this.addChild(new Text(theme.muted('Do you want to allow this?'), 0, 0));
    this.addChild(new Text('', 0, 0));
    this.addChild(this.selector);
    this.addChild(new Text('', 0, 0));
    this.addChild(new Text(theme.muted('Enter to confirm · esc to deny'), 0, 0));
    this.addChild(new Text(border, 0, 0));
  }
}
