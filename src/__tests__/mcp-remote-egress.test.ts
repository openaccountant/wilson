import { describe, expect, test, beforeEach, afterEach, afterAll, spyOn } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import * as mcpClient from '../mcp/client.js';
import * as mcpConfig from '../mcp/config.js';
import { loadMcpTools, getCachedMcpTools } from '../mcp/adapter.js';
import { scrubEgressArgs, scrubEgressText } from '../mcp/egress.js';
import { setRemoteCallLogPath } from '../mcp/remote-call-log.js';
import { gateToolCall } from '../agent/approval-gate.js';
import type { ToolApprovalRequest } from '../agent/types.js';
import { logger } from '../utils/logger.js';

describe('scrubEgressText', () => {
  const scrub = (s: string) => scrubEgressText(s).value;

  test('benign tax questions pass through unchanged', () => {
    for (const q of [
      'QBI deduction threshold 2025 married filing jointly',
      'Form 1040 Schedule C line 31',
      'W-2 vs 1099-NEC for a contractor',
      'Section 199A specified service trade or business',
      'standard mileage rate 2025 and 26 CFR 1.162-1',
      'estimated tax due dates 2025-04-15 for tax year 2024-2025',
      'Rev. Proc. 2024-40 inflation adjustments',
      'is the 21% corporate rate flat?',
    ]) {
      const res = scrubEgressText(q);
      expect(res.value).toBe(q);
      expect(res.redactions).toBe(0);
    }
  });

  test('dollar amounts', () => {
    expect(scrub('I made $1,234.56 in interest')).toBe('I made [amount] in interest');
    expect(scrub('paid $50k and -$300 and US$ 20')).toBe('paid [amount] and [amount] and [amount]');
    expect(scrub('income 85,000 plus 1234.56')).toBe('income [amount] plus [amount]');
    expect(scrub('about 1200 USD or 45 dollars')).toBe('about [amount] or [amount]');
  });

  test('SSN with and without dashes, ITIN, EIN', () => {
    expect(scrub('my SSN is 123-45-6789')).toBe('my SSN is [tax-id]');
    expect(scrub('my SSN is 123456789')).toBe('my SSN is [tax-id]');
    expect(scrub('ssn 123 45 6789')).toBe('ssn [tax-id]');
    expect(scrub('ITIN 912-70-1234')).toBe('ITIN [tax-id]');
    expect(scrub('EIN 12-3456789')).toBe('EIN [tax-id]');
  });

  test('account and card numbers, nothing of them kept', () => {
    const out = scrub('checking 000123456789 and card 4111 1111 1111 1234');
    expect(out).toBe('checking [number] and card [number]');
    expect(out).not.toContain('1234');
    expect(scrub('acct 12345-678')).toBe('acct [number]');
  });

  test('emails and phone numbers', () => {
    expect(scrub('reach me at jd@example.com or (415) 555-0134')).toBe('reach me at [email] or [phone]');
  });

  test('hidden characters and fullwidth digits do not hide a number', () => {
    expect(scrub('123​45​6789')).toBe('[tax-id]');
    expect(scrub('SSN １２３－４５－６７８９')).toBe('SSN [tax-id]');
  });

  test('numbers split by double spaces, tabs, newlines or a spaced hyphen are still caught', () => {
    for (const s of ['4111  1111  1111  1234', '4111\t1111\t1111\t1234', '4111\n1111\n1111\n1234', '4111 - 1111 - 1111 - 1234']) {
      expect(scrub(`card ${s}`)).toBe('card [number]');
    }
    for (const s of ['123  45  6789', '123 - 45 - 6789', '123.45.6789', '123_45_6789']) {
      expect(scrub(`ssn ${s}`)).toBe('ssn [tax-id]');
    }
  });

  test('suffixed, coded and signed amounts', () => {
    for (const [q, want] of [
      ['I made 95k', 'I made [amount]'],
      ['income of 85k', 'income of [amount]'],
      ['12k income', '[amount] income'],
      ['1.2 million', '[amount]'],
      ['salary 120 thousand', 'salary [amount]'],
      ['USD 4500', '[amount]'],
      ['CAD 1234.5', '[amount]'],
      ['4500 EUR', '[amount]'],
      ['4500 euros', '[amount]'],
      ['-1234.5', '[amount]'],
      ['income 85 000', 'income [amount]'],
    ]) expect(scrub(q!)).toBe(want!);
    // Plan names are not amounts.
    expect(scrub('401k vs 403b contribution limit, my 1099-K')).toBe('401k vs 403b contribution limit, my 1099-K');
  });

  test('non-ASCII decimal digits and combining marks do not hide a number', () => {
    expect(scrub('١٢٣-٤٥-٦٧٨٩')).toBe('[tax-id]');
    expect(scrub('۱۲۳۴۵۶۷۸۹')).toBe('[tax-id]');
    expect(scrub('१२३४५६७८९')).toBe('[tax-id]');
    expect(scrub('1́2́3́-4́5-6́78́9')).toBe('[tax-id]');
    expect(scrub('𝟏𝟐𝟑-𝟒𝟓-𝟔𝟕𝟖𝟗')).toBe('[tax-id]');
  });

  test('regulation citations, rates, years, dates and form numbers pass through', () => {
    for (const q of [
      'Treas. Reg. 1.62-2 accountable plan rules',
      '26 CFR 1.61-1 gross income',
      'Reg 1.83-3',
      'Medicare tax 1.45% and 2.35% additional',
      'SE tax rate 12.40% plus 2.90%',
      'IRC 6654 penalty 2025 Form 1040 8995 1099-NEC W-2',
      'tax years 2023 2024 2025',
      'forms 1040 1099 8995',
      '26 CFR 1.1012-1 basis',
      'Treas. Reg. 1.6654-2 and 301.7701-3',
      'payment made 04/15/2025 timely?',
      'due 1/15/2026',
      'Form 14039 identity theft',
      'Form 13614-C',
      'Notice 2024-7',
    ]) {
      const res = scrubEgressText(q);
      expect(res.value).toBe(q);
      expect(res.redactions).toBe(0);
    }
    // A keyword does not excuse an account-length number, and a year next to one does not hide it.
    expect(scrub('Form 482917')).toBe('Form [number]');
    expect(scrub('tax year 2025 acct 12345678')).toBe('tax year 2025 acct [number]');
    expect(scrub('account 1234 5678 9012 3456')).toBe('account [number]');
  });

  test('pathological input stays fast', () => {
    const t = performance.now();
    for (const s of ['1 '.repeat(20000), '1 - '.repeat(20000) + 'x', '1.'.repeat(20000) + '-', '١'.repeat(20000), '-1'.repeat(20000)]) scrubEgressText(s);
    expect(performance.now() - t).toBeLessThan(1000);
  });

  test('counts redactions by kind', () => {
    const res = scrubEgressText('$10.00 to jd@example.com, SSN 123-45-6789');
    expect(res.redactions).toBe(3);
    expect(res.kinds).toEqual({ amount: 1, email: 1, tax_id: 1 });
  });
});

describe('scrubEgressArgs', () => {
  test('walks nested objects and arrays; numbers pass through', () => {
    const res = scrubEgressArgs({ query: 'SSN 123-45-6789', opts: { notes: ['$5,000 bonus', 'ok'], limit: 10 } });
    expect(res.value).toEqual({ query: 'SSN [tax-id]', opts: { notes: ['[amount] bonus', 'ok'], limit: 10 } });
    expect(res.redactions).toBe(2);
  });

  test('returns the same object when nothing is found', () => {
    const args = { query: 'QBI deduction threshold 2025 married filing jointly' };
    expect(scrubEgressArgs(args).value).toBe(args);
  });

  test('too-deep nesting is replaced, not sent', () => {
    let deep: Record<string, unknown> = { s: '123-45-6789' };
    for (let i = 0; i < 40; i++) deep = { d: deep };
    const res = scrubEgressArgs(deep);
    expect(JSON.stringify(res.value)).not.toContain('6789');
    expect(res.redactions).toBeGreaterThan(0);
  });
});

// ── At the adapter call site ─────────────────────────────────────────────────

type Call = { server: string; name: string; arguments: Record<string, unknown> };
const calls: Call[] = [];

const TOOLS = {
  oa: [
    'search_skills', 'start', 'submit_feedback', 'compute', 'search_rules', 'get_deadlines', 'list_jurisdictions',
    'list_verifiers', 'validate_vat_number', 'check_audit_exemption',
  ],
  // The same server with compute opted back in (hiddenTools emptied in mcp.json).
  oaOptIn: ['search_skills', 'compute'],
  strict: ['search_skills'],
  local: ['echo'],
};
const KIND: Record<string, mcpConfig.McpTransportKind> = { oa: 'http', oaOptIn: 'http', strict: 'http', local: 'stdio' };

const fakeClient = (server: string) => ({
  listTools: async () => ({ tools: TOOLS[server as keyof typeof TOOLS].map((name) => ({ name, inputSchema: { type: 'object', properties: { query: { type: 'string' } } } })) }),
  callTool: async (req: { name: string; arguments: Record<string, unknown> }) => {
    calls.push({ server, ...req });
    return { content: [{ type: 'text', text: 'answer' }] };
  },
});

const serversSpy = spyOn(mcpClient, 'getConnectedServers').mockImplementation(() => Object.keys(TOOLS));
const clientSpy = spyOn(mcpClient, 'getMcpClient').mockImplementation((name: string) => fakeClient(name) as never);
const kindSpy = spyOn(mcpClient, 'getServerTransportKind').mockImplementation((name: string) => KIND[name]);
let configSpy: ReturnType<typeof spyOn>;
let warnSpy: ReturnType<typeof spyOn>;
let logDir: string;
let logPath: string;

beforeEach(async () => {
  calls.length = 0;
  logDir = mkdtempSync(join(tmpdir(), 'mcp-remote-log-'));
  logPath = join(logDir, 'remote.log');
  setRemoteCallLogPath(logPath);
  configSpy = spyOn(mcpConfig, 'loadMcpConfig').mockImplementation(() => ({
    servers: {
      oa: { ...mcpConfig.MCP_SERVER_PRESETS.openaccountants!.config },
      oaOptIn: { ...mcpConfig.MCP_SERVER_PRESETS.openaccountants!.config, hiddenTools: [] },
      strict: { transport: 'http', url: 'https://strict.example.com/mcp', egress: 'block', readOnlyTools: ['search_skills'] },
      local: { command: 'node', readOnlyTools: ['echo'] },
    },
  }));
  warnSpy = spyOn(logger, 'warn').mockImplementation(() => {});
  await loadMcpTools();
});

afterEach(() => {
  configSpy.mockRestore();
  warnSpy.mockRestore();
  setRemoteCallLogPath();
  rmSync(logDir, { recursive: true, force: true });
});

afterAll(() => {
  serversSpy.mockRestore();
  clientSpy.mockRestore();
  kindSpy.mockRestore();
});

const tool = (name: string) => {
  const t = getCachedMcpTools().find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
};
const logLines = () => (existsSync(logPath) ? readFileSync(logPath, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

describe('egress guard at the MCP adapter call site', () => {
  test('read-only remote tool: personal data is redacted and the call continues', async () => {
    await tool('mcp_oa_search_skills').func({ query: 'I paid $1,234.56, SSN 123-45-6789, EIN 12-3456789' });
    expect(calls).toEqual([{ server: 'oa', name: 'search_skills', arguments: { query: 'I paid [amount], SSN [tax-id], EIN [tax-id]' } }]);
  });

  test('a benign query reaches the remote server unchanged', async () => {
    await tool('mcp_oa_start').func({ query: 'QBI deduction threshold 2025 married filing jointly' });
    expect(calls[0]!.arguments).toEqual({ query: 'QBI deduction threshold 2025 married filing jointly' });
  });

  test('each remote call is logged with server, tool and redaction count — never the raw args', async () => {
    await tool('mcp_oa_search_skills').func({ query: 'acct 000123456789 jd@example.com' });
    await tool('mcp_oa_start').func({ query: 'QBI deduction threshold 2025' });
    const lines = logLines();
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ server: 'oa', tool: 'search_skills', transport: 'http', outcome: 'sent', redactions: 2 });
    expect(lines[1]).toMatchObject({ server: 'oa', tool: 'start', outcome: 'sent', redactions: 0 });
    const raw = readFileSync(logPath, 'utf-8');
    expect(raw).not.toContain('000123456789');
    expect(raw).not.toContain('example.com');
    expect(raw).not.toContain('QBI');
  });

  test('egress "block": a call carrying personal data is not sent', async () => {
    const out = await tool('mcp_strict_search_skills').func({ query: 'my SSN is 123456789' });
    expect(calls).toHaveLength(0);
    expect(out).toContain('Not sent');
    expect(out).not.toContain('123456789');
    expect(logLines()[0]).toMatchObject({ server: 'strict', outcome: 'blocked', redactions: 1 });
  });

  test('egress "block" still sends a clean call', async () => {
    await tool('mcp_strict_search_skills').func({ query: 'home office deduction rules' });
    expect(calls).toHaveLength(1);
  });

  test('stdio servers are unchanged: no scrubbing, no remote log', async () => {
    await tool('mcp_local_echo').func({ query: 'SSN 123-45-6789 $1,234.56' });
    expect(calls[0]!.arguments).toEqual({ query: 'SSN 123-45-6789 $1,234.56' });
    expect(logLines()).toHaveLength(0);
    expect(tool('mcp_local_echo').approvalArgs).toBeUndefined();
  });
});

describe('approval for the remote tax-knowledge server', () => {
  test('submit_feedback is not read-only: it needs approval every time', async () => {
    const requests: ToolApprovalRequest[] = [];
    const t = tool('mcp_oa_submit_feedback');
    const gate = await gateToolCall(t.name, t, { query: 'great' }, async (r) => { requests.push(r); return 'deny'; }, new Set());
    expect(gate).toEqual({ asked: true, decision: 'deny', allowed: false });
    expect(requests).toHaveLength(1);
  });

  test('the preset read-only tools run without a card', async () => {
    for (const name of ['mcp_oa_search_skills', 'mcp_oa_start']) {
      const t = tool(name);
      const gate = await gateToolCall(t.name, t, { query: 'x' }, async () => { throw new Error('asked'); }, new Set());
      expect(gate.asked).toBe(false);
      expect(gate.allowed).toBe(true);
    }
  });

  test('the approval card shows the scrubbed payload, which is exactly what is sent', async () => {
    const requests: ToolApprovalRequest[] = [];
    const t = tool('mcp_oa_submit_feedback');
    const args = { query: 'wrong answer for my $82,000 income, email jd@example.com' };
    const gate = await gateToolCall(t.name, t, args, async (r) => { requests.push(r); return 'allow-once'; }, new Set());
    expect(gate.allowed).toBe(true);
    expect(requests[0]!.args).toEqual({ query: 'wrong answer for my [amount] income, email [email]' });
    await t.func(args);
    expect(calls[0]!.arguments).toEqual(requests[0]!.args);
  });
});

describe('openaccountants preset: compute is hidden unless the user opts in', () => {
  test('compute is not offered to the model by default', () => {
    expect(getCachedMcpTools().some((t) => t.name === 'mcp_oa_compute')).toBe(false);
    // Hiding is per tool: the rest of the server is still there.
    expect(getCachedMcpTools().some((t) => t.name === 'mcp_oa_search_skills')).toBe(true);
  });

  test('hidden wins over readOnlyTools', async () => {
    configSpy.mockImplementation(() => ({
      servers: { oa: { transport: 'http', url: 'https://www.openaccountants.com/api/mcp', readOnlyTools: ['compute'], hiddenTools: ['compute'] } },
    }));
    await loadMcpTools();
    expect(getCachedMcpTools().some((t) => t.name === 'mcp_oa_compute')).toBe(false);
  });

  test('after opting in (hiddenTools emptied), compute is offered and every call needs approval', async () => {
    const t = tool('mcp_oaOptIn_compute');
    const requests: ToolApprovalRequest[] = [];
    const gate = await gateToolCall(t.name, t, { query: 'x' }, async (r) => { requests.push(r); return 'deny'; }, new Set());
    expect(gate).toEqual({ asked: true, decision: 'deny', allowed: false });
    expect(requests).toHaveLength(1);
  });
});

describe('openaccountants preset: the extra read-only lookups', () => {
  const readOnly = ['search_rules', 'get_deadlines', 'list_jurisdictions', 'list_verifiers'];

  test('a short lookup runs without a card', async () => {
    for (const name of readOnly) {
      const t = tool(`mcp_oa_${name}`);
      const gate = await gateToolCall(t.name, t, { query: 'UK VAT 2025' }, async () => { throw new Error(`asked for ${name}`); }, new Set());
      expect(gate).toMatchObject({ asked: false, allowed: true });
    }
  });

  test('the short-lookup rule still applies: long text, many digits or anything redacted asks', async () => {
    for (const name of readOnly) {
      const t = tool(`mcp_oa_${name}`);
      for (const args of [
        { query: 'x'.repeat(301) },
        { query: '2021 2022 2023 2024 2025 2026' },
        { query: 'my SSN is 123-45-6789' },
      ]) {
        const requests: ToolApprovalRequest[] = [];
        const gate = await gateToolCall(t.name, t, args, async (r) => { requests.push(r); return 'deny'; }, new Set());
        expect(gate.asked).toBe(true);
        expect(requests).toHaveLength(1);
      }
    }
  });

  test('validate_vat_number and check_audit_exemption still need approval every time', async () => {
    for (const name of ['validate_vat_number', 'check_audit_exemption']) {
      const t = tool(`mcp_oa_${name}`);
      const requests: ToolApprovalRequest[] = [];
      const gate = await gateToolCall(t.name, t, { query: 'x' }, async (r) => { requests.push(r); return 'deny'; }, new Set());
      expect(gate).toEqual({ asked: true, decision: 'deny', allowed: false });
      expect(requests).toHaveLength(1);
    }
  });
});
