import { describe, expect, test } from 'bun:test';
import {
  AUDIT_SENTINELS,
  auditChip,
  buildToolRows,
  formatAuditRow,
  lockFor,
  statusDot,
  type AgentState,
  type AgentToolState,
} from '../dashboard/agent-access-model.js';

/**
 * The pure view-model behind Settings -> Agent access and the bridge panel
 * (spec P1, "agent-access-model.ts"). Both surfaces render from it, so the
 * rules the user relies on (viewer locks, "changes never Allow", what a chip
 * colour means) are pinned here without a browser.
 */

const tool = (over: Partial<AgentToolState> = {}): AgentToolState => ({
  name: 'transaction_search',
  description: 'Search transactions',
  classification: 'read',
  policy: 'allow',
  policyLocked: false,
  grant: null,
  ...over,
});

const state = (tools: AgentToolState[], over: Partial<AgentState> = {}): AgentState => ({
  enabled: true,
  grantTtlMinutes: 60,
  ttlOptions: [15, 60, 240, 720],
  role: 'admin',
  authEnabled: false,
  tools,
  pending: [],
  auditTail: [],
  ...over,
});

describe('buildToolRows', () => {
  test('viewer rows for tools that change data are locked, with the reason; read rows are not', () => {
    const rows = buildToolRows(state([tool(), tool({ name: 'edit_transaction', classification: 'mutating', policy: 'ask' })], { role: 'viewer', authEnabled: true }), 'viewer');
    const read = rows.find((r) => r.name === 'transaction_search')!;
    const write = rows.find((r) => r.name === 'edit_transaction')!;
    expect(read.locked).toBe(false);
    expect(write.locked).toBe(true);
    expect(write.lockReason).toBe('Viewer accounts cannot use tools that change data');
    expect(write.policyOptions.every((o) => o.disabled)).toBe(true);
    expect(lockFor('mutating', 'viewer')).toEqual({ locked: true, reason: 'Viewer accounts cannot use tools that change data' });
    expect(lockFor('mutating', 'admin')).toEqual({ locked: false, reason: null });
  });

  test('WRITE rows never offer Allow: the option is there but disabled, with the reason', () => {
    const rows = buildToolRows(state([tool({ name: 'edit_transaction', classification: 'mutating', policy: 'ask' })]), 'admin');
    const allow = rows[0].policyOptions.find((o) => o.value === 'allow')!;
    expect(allow.disabled).toBe(true);
    expect(allow.title).toBe('Changes always wait for your approval');
    expect(rows[0].policyOptions.filter((o) => !o.disabled).map((o) => o.value)).toEqual(['off', 'ask']);
    expect(rows[0].classBadge).toEqual({ label: 'WRITE', tone: 'amber' });
  });

  test('READ rows offer all three and show the READ badge; the chosen policy is marked', () => {
    const [row] = buildToolRows(state([tool({ policy: 'ask' })]), 'admin');
    expect(row.policyOptions.map((o) => [o.value, o.disabled])).toEqual([['off', false], ['ask', false], ['allow', false]]);
    expect(row.policy).toBe('ask');
    expect(row.classBadge).toEqual({ label: 'READ', tone: 'muted' });
  });

  test('a stored allow on a WRITE tool is shown as ask (the server clamps it)', () => {
    const [row] = buildToolRows(state([tool({ classification: 'mutating', policy: 'allow' })]), 'admin');
    expect(row.policy).toBe('ask');
  });

  test('PROPOSAL rows (the judge) offer Allow, unlike WRITE rows, and are locked for a viewer', () => {
    const [row] = buildToolRows(state([tool({ name: 'propose_judgements', classification: 'proposal', policy: 'ask' })]), 'admin');
    expect(row.classBadge).toEqual({ label: 'PROPOSAL', tone: 'blue' });
    expect(row.policyOptions.map((o) => [o.value, o.disabled])).toEqual([['off', false], ['ask', false], ['allow', false]]);
    expect(row.policy).toBe('ask');
    const [allowed] = buildToolRows(state([tool({ name: 'propose_judgements', classification: 'proposal', policy: 'allow' })]), 'admin');
    expect(allowed.policy).toBe('allow'); // stays allow: what it inserts is inert until a person accepts it
    const [viewerRow] = buildToolRows(state([tool({ name: 'propose_judgements', classification: 'proposal', policy: 'ask' })], { role: 'viewer', authEnabled: true }), 'viewer');
    expect(viewerRow.locked).toBe(true);
    expect(lockFor('proposal', 'viewer').locked).toBe(true);
  });

  test('the judge reads carry the "chat history and financial data" label; other reads do not', () => {
    const rows = buildToolRows(state([tool({ name: 'get_interaction' }), tool({ name: 'list_interactions' }), tool({ name: 'get_judge_rubric' }), tool()]), 'admin');
    expect(rows.map((r) => r.dataWarning)).toEqual([
      'Includes your chat history and financial data',
      'Includes your chat history and financial data',
      null,
      null,
    ]);
  });

  test('grant state: none, or granted with its expiry', () => {
    const rows = buildToolRows(state([tool(), tool({ name: 'forecast', grant: { id: 'g1', expiresAt: '2026-10-03T12:00:00.000Z' } })]), 'admin');
    expect(rows[0].grantState).toEqual({ kind: 'none' });
    expect(rows[1].grantState).toEqual({ kind: 'granted', grantId: 'g1', expiresAt: '2026-10-03T12:00:00.000Z' });
  });

  test('a tool whose policy is Off cannot be granted, and says why', () => {
    const [row] = buildToolRows(state([tool({ policy: 'off' })]), 'admin');
    expect(row.grantable).toBe(false);
    expect(row.grantBlockedReason).toBe('Turned off in your policies');
  });

  test('while agent access is off, nothing is grantable', () => {
    const [row] = buildToolRows(state([tool()], { enabled: false }), 'admin');
    expect(row.grantable).toBe(false);
    expect(row.grantBlockedReason).toBe('Agent access is off');
  });
});

describe('statusDot (bridge button)', () => {
  test('red when off, green when this tab has live tools, muted when it has none', () => {
    expect(statusDot(state([tool()], { enabled: false }))).toBe('red');
    expect(statusDot(state([tool({ grant: { id: 'g', expiresAt: 'x' } })]))).toBe('green');
    expect(statusDot(state([tool()]))).toBe('muted');
  });
});

describe('audit rows', () => {
  const entry = (over: Record<string, unknown> = {}) => ({
    id: 1,
    ts: '2026-10-03T12:34:56.000Z',
    tier: 'signal',
    transport: 'imperative',
    tool_name: 'transaction_search',
    decision: 'allowed',
    count: 1,
    args_preview: '{"query":"groceries"}',
    ...over,
  });

  test('decision maps to a chip colour: allowed/committed green; denied, rejected, rate_limited red; created/approved amber', () => {
    for (const d of ['allowed', 'committed']) expect(auditChip(d)).toBe('green');
    for (const d of ['denied_policy', 'denied_kill_switch', 'denied_grant', 'denied_role', 'rejected', 'rate_limited', 'invalid_args', 'error']) {
      expect(auditChip(d)).toBe('red');
    }
    for (const d of ['operation_created', 'approved']) expect(auditChip(d)).toBe('amber');
    for (const d of ['stale', 'expired', 'cancelled', 'rest_export']) expect(auditChip(d)).toBe('muted');
  });

  test('a retired tool name keeps showing as stored, with its current name beside it', () => {
    expect(formatAuditRow(entry({ tool_name: 'transaction_search', toolCurrent: 'search_transactions' })).tool).toBe('transaction_search (now search_transactions)');
    expect(formatAuditRow(entry({ tool_name: 'search_transactions' })).tool).toBe('search_transactions');
  });

  test('a client-reported transport is flagged with a tooltip; a server-derived one is not', () => {
    for (const t of ['imperative', 'declarative', 'page']) {
      const row = formatAuditRow(entry({ transport: t }));
      expect(row.transportClientReported).toBe(true);
      expect(row.transportTitle).toBe('Reported by the calling page; not verified by Wilson');
    }
    for (const t of ['http-mcp', 'chat', 'rest']) {
      const row = formatAuditRow(entry({ transport: t }));
      expect(row.transportClientReported).toBe(false);
      expect(row.transportTitle).toBeNull();
    }
  });

  test('a normal row carries the tool, decision label, chip, count and the preview with the full text as its title', () => {
    const preview = '{"query":"' + 'x'.repeat(200) + '"}';
    const row = formatAuditRow(entry({ count: 12, decision: 'rate_limited', args_preview: preview }));
    expect(row.kind).toBe('call');
    expect(row.tool).toBe('transaction_search');
    expect(row.decisionLabel).toBe('rate limited');
    expect(row.chip).toBe('red');
    expect(row.count).toBe(12);
    expect(row.preview.length).toBeLessThanOrEqual(80);
    expect(row.previewTitle).toBe(preview);
    expect(formatAuditRow(entry()).count).toBeNull();
  });

  test('sentinel rows are formatted as full-width notices, not as calls', () => {
    for (const decision of ['audit_compacted', 'audit_evicted']) {
      const row = formatAuditRow(entry({ tier: 'sentinel', decision, count: 40, tool_name: 'audit', args_preview: 'compacted 40 rows' }));
      expect(row.kind).toBe('notice');
      expect(row.notice).toContain('40');
    }
    const paging = formatAuditRow(entry({ tier: 'sentinel', decision: 'deep_paging', tool_name: 'transaction_search', args_preview: 'paged' }));
    expect(paging.kind).toBe('notice');
    expect(paging.notice).toContain('transaction_search');
    expect([...AUDIT_SENTINELS]).toEqual(['audit_compacted', 'audit_evicted', 'deep_paging']);
  });

  test('the time is a stable ISO string the UI formats in local time; a bad timestamp does not throw', () => {
    expect(formatAuditRow(entry()).timeIso).toBe('2026-10-03T12:34:56.000Z');
    expect(() => formatAuditRow(entry({ ts: 'garbage' }))).not.toThrow();
  });
});
