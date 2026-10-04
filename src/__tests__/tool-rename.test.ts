import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDb, seedTestData } from './helpers.js';
import { count, firstTxnId, grantTools, makeUser, mintTestToken, testScope } from './mcp-helpers.js';
import { Database } from '../db/compat-sqlite.js';
import { runMigrations, MIGRATIONS } from '../db/migrations.js';
import { initDatabase } from '../db/database.js';
import * as toolRename from '../mcp/tool-rename.js';
import { applyToolRenames } from '../mcp/tool-rename.js';
import { RETIRED_TOOL_NAMES } from '../mcp/tool-names.js';
import { MCP_TOOL_CATALOG, getToolDef, schemaDigest } from '../mcp/tool-catalog.js';
import { allowedPolicies, getConfiguredPolicy, getEffectivePolicy, setPolicy, type Policy, type PolicyActor } from '../mcp/policies.js';
import { approveWebMcpOperation, callTool, exposedTools } from '../mcp/engine.js';
import { appendAudit, listAudit } from '../mcp/audit.js';
import { createOperation, getOperation, validateGrant } from '../mcp/store.js';
import { resolveClientToken } from '../mcp/client-tokens.js';
import { JUDGE_RUBRIC_VERSION } from '../training/judge-rubric.js';

/**
 * The no-migration compatibility strategy for the 0.10.0 WebMCP rename (specs/webmcp-tool-naming.md §4): an idempotent
 * startup fix-up plus a permanent policy read fallback. These tests seed rows the way an earlier 0.10 dev build wrote
 * them (old names), and pin that the same effective access survives, nothing widens, and history is untouched.
 */

const PAIRS = Object.entries(RETIRED_TOOL_NAMES).map(([old, r]) => [old, r.name] as const);
const RANK: Record<string, number> = { off: 0, ask: 1, allow: 2 };
const POLICY_VALUES: Policy[] = ['off', 'ask', 'allow'];
const NEW_STATES: Array<Policy | null> = [null, 'off', 'ask', 'allow'];
const admin: PolicyActor = { userId: null, role: 'admin', authEnabled: false };

function quiet<T>(fn: () => T): T {
  const log = spyOn(console, 'log').mockImplementation(() => {});
  try {
    return fn();
  } finally {
    log.mockRestore();
  }
}

function putPolicy(db: Database, userKey: number, tool: string, policy: string): void {
  db.prepare('INSERT OR REPLACE INTO mcp_tool_policies (user_key, tool_name, policy) VALUES (@k, @t, @p)').run({ k: userKey, t: tool, p: policy });
}
function rawPolicy(db: Database, userKey: number, tool: string): string | undefined {
  return (db.prepare('SELECT policy FROM mcp_tool_policies WHERE user_key = @k AND tool_name = @t').get({ k: userKey, t: tool }) as { policy: string } | undefined)?.policy;
}
function clampFor(tool: string, policy: Policy): Policy {
  const allowed = allowedPolicies(getToolDef(tool)!);
  return allowed.includes(policy) ? policy : policy === 'allow' ? 'ask' : 'allow';
}
/** A recorded chat call (llm_interactions row), optionally with the chat tool calls it made. */
function addInteraction(db: Database, opts: { userPrompt?: string; toolCalls?: unknown } = {}): number {
  const res = db
    .prepare(
      `INSERT INTO llm_interactions (run_id, sequence_num, call_type, model, provider, system_prompt, user_prompt, response_content, tool_calls_json, status)
       VALUES (@runId, 1, 'agent', 'gpt-4', 'openai', 'sys', @userPrompt, 'You spent $42.10 on coffee.', @toolCalls, 'ok')`,
    )
    .run({ runId: `run-${Math.random().toString(36).slice(2)}`, userPrompt: opts.userPrompt ?? 'How much did I spend on coffee?', toolCalls: opts.toolCalls === undefined ? null : JSON.stringify(opts.toolCalls) });
  return (res as { lastInsertRowid: number }).lastInsertRowid as number;
}
const hash = (rows: unknown[]) => createHash('sha256').update(JSON.stringify(rows)).digest('hex');
const dump = (db: Database, table: string) => db.prepare(`SELECT * FROM ${table} ORDER BY 1, 2`).all();

/** Turn rows a current build wrote into the rows an earlier dev build would have written. */
function backdate(db: Database, newName: string, oldName: string): void {
  db.prepare('UPDATE mcp_grants SET tool_name = @o WHERE tool_name = @n').run({ o: oldName, n: newName });
  db.prepare("UPDATE mcp_operations SET tool_name = @o WHERE tool_name = @n AND source != 'chat'").run({ o: oldName, n: newName });
}

afterEach(() => {
  /* every test builds its own in-memory db */
});

describe('I2 policy equivalence: never default-allow', () => {
  test('policy merge matrix: every pair, old value, new state; NEW equals clamp(minRank), OLD mirrors NEW', () => {
    const db = createTestDb();
    let userKey = 100;
    const cases: Array<{ old: string; neu: string; oldValue: Policy; newState: Policy | null; key: number }> = [];
    for (const [old, neu] of PAIRS) {
      for (const oldValue of POLICY_VALUES) {
        for (const newState of NEW_STATES) {
          const key = userKey++;
          putPolicy(db, key, old, oldValue);
          if (newState) putPolicy(db, key, neu, newState);
          cases.push({ old, neu, oldValue, newState, key });
        }
      }
    }
    quiet(() => applyToolRenames(db));
    for (const c of cases) {
      const merged = (c.newState === null ? c.oldValue : RANK[c.newState]! < RANK[c.oldValue]! ? c.newState : c.oldValue) as Policy;
      expect(getConfiguredPolicy(db, c.key, c.neu), JSON.stringify(c)).toBe(clampFor(c.neu, merged));
      expect(rawPolicy(db, c.key, c.neu), `new row ${JSON.stringify(c)}`).toBe(merged);
      expect(rawPolicy(db, c.key, c.old), `mirror row ${JSON.stringify(c)}`).toBe(merged); // kept, not deleted (AR-P1)
    }
  });

  test('mirror row kept and equal: a second run changes nothing', () => {
    const db = createTestDb();
    putPolicy(db, 1, 'spending_summary', 'off');
    putPolicy(db, 1, 'get_spending_summary', 'allow');
    quiet(() => applyToolRenames(db));
    const before = hash(dump(db, 'mcp_tool_policies'));
    expect(quiet(() => applyToolRenames(db))).toEqual({ policies: 0, grants: 0, revoked: 0, operations: 0 });
    expect(hash(dump(db, 'mcp_tool_policies'))).toBe(before);
    expect(rawPolicy(db, 1, 'spending_summary')).toBe('off');
    expect(rawPolicy(db, 1, 'get_spending_summary')).toBe('off');
  });

  test('read fallback without the fix-up: an old-name Off still holds for every renamed tool', () => {
    const db = createTestDb();
    for (const [old, neu] of PAIRS) {
      putPolicy(db, 0, old, 'off');
      expect(getConfiguredPolicy(db, null, neu), neu).toBe('off');
      expect(getEffectivePolicy(db, 9, neu), neu).toBe('off'); // inherits the auth-off row
    }
  });

  test('read fallback keeps the most restrictive of old and new, within one user key', () => {
    const db = createTestDb();
    putPolicy(db, 0, 'net_worth', 'ask');
    putPolicy(db, 0, 'get_net_worth', 'allow');
    expect(getConfiguredPolicy(db, null, 'get_net_worth')).toBe('ask');
    putPolicy(db, 0, 'get_net_worth', 'off');
    expect(getConfiguredPolicy(db, null, 'get_net_worth')).toBe('off');
  });

  test('user_key 0 row carried, and a user\'s own row still beats the user 0 row', () => {
    const db = createTestDb();
    putPolicy(db, 0, 'profit_loss', 'off');
    quiet(() => applyToolRenames(db));
    expect(getConfiguredPolicy(db, 4, 'get_profit_loss')).toBe('off'); // enabling auth never undoes an Off
    putPolicy(db, 4, 'get_profit_loss', 'allow');
    expect(getConfiguredPolicy(db, 4, 'get_profit_loss')).toBe('allow'); // the user's own choice wins
    expect(getConfiguredPolicy(db, null, 'get_profit_loss')).toBe('off');
  });

  test('a policy row for any other name is ignored', () => {
    const db = createTestDb();
    putPolicy(db, 0, 'get_net_worth', 'off');
    putPolicy(db, 0, 'future_tool', 'off');
    expect(quiet(() => applyToolRenames(db)).policies).toBe(0);
    expect(rawPolicy(db, 0, 'future_tool')).toBe('off');
  });
});

describe('I3 no widening of grants', () => {
  const scopeOf = (over = {}) => testScope(over);

  function grantRow(db: Database, over: Record<string, unknown> = {}): string {
    const id = crypto.randomUUID();
    db.prepare(
      `INSERT INTO mcp_grants (id, batch_id, tool_name, schema_digest, user_id, role, profile, origin, session_generation, expires_at, revoked_at)
       VALUES (@id, @batch, @tool, @digest, @user, 'admin', @profile, @origin, @sg, @exp, @rev)`,
    ).run({ id, batch: 'b', tool: 'transaction_search', digest: 'd', user: null, profile: 'test', origin: 'http://localhost:3141', sg: 'sess-1', exp: new Date(Date.now() + 3_600_000).toISOString(), rev: null, ...over });
    return id;
  }
  const row = (db: Database, id: string) => db.prepare('SELECT * FROM mcp_grants WHERE id = @id').get({ id }) as Record<string, any>;

  test('live grants renamed with the same digest, scope and expiry', () => {
    const db = createTestDb();
    const exp = new Date(Date.now() + 5 * 3_600_000).toISOString();
    const id = grantRow(db, { digest: schemaDigest('search_transactions'), exp });
    expect(quiet(() => applyToolRenames(db))).toMatchObject({ grants: 1, revoked: 0 });
    expect(row(db, id)).toMatchObject({ tool_name: 'search_transactions', schema_digest: schemaDigest('search_transactions'), expires_at: exp, revoked_at: null });
  });

  test('dead grants (revoked or expired) are untouched', () => {
    const db = createTestDb();
    const revoked = grantRow(db, { rev: '2026-01-01 00:00:00' });
    const expired = grantRow(db, { exp: '2020-01-01T00:00:00.000Z' });
    quiet(() => applyToolRenames(db));
    expect(row(db, revoked).tool_name).toBe('transaction_search');
    expect(row(db, expired).tool_name).toBe('transaction_search');
  });

  test('mixed expires_at formats compare by julianday: a SQLite-format future expiry is live', () => {
    const db = createTestDb();
    const id = grantRow(db, { exp: new Date(Date.now() + 3_600_000).toISOString().replace('T', ' ').slice(0, 19) });
    quiet(() => applyToolRenames(db));
    expect(row(db, id).tool_name).toBe('search_transactions');
  });

  test('an existing NEW grant for the same owner wins: the OLD one is revoked, never duplicated', () => {
    const db = createTestDb();
    const oldId = grantRow(db, { tool: 'transaction_search' });
    const newId = grantRow(db, { tool: 'search_transactions' });
    expect(quiet(() => applyToolRenames(db))).toMatchObject({ grants: 0, revoked: 1 });
    expect(row(db, oldId).revoked_at).not.toBeNull();
    expect(row(db, newId).revoked_at).toBeNull();
    expect(count(db, 'mcp_grants', "tool_name = 'search_transactions' AND revoked_at IS NULL")).toBe(1);
  });

  test('the collision is scoped to the full owner: a different origin, user or profile is never revoked', () => {
    const db = createTestDb();
    grantRow(db, { tool: 'search_transactions', origin: 'http://other.example' });
    grantRow(db, { tool: 'search_transactions', user: 7 });
    grantRow(db, { tool: 'search_transactions', profile: 'other' });
    const oldId = grantRow(db, { tool: 'transaction_search' });
    expect(quiet(() => applyToolRenames(db))).toMatchObject({ grants: 1, revoked: 0 });
    expect(row(db, oldId)).toMatchObject({ tool_name: 'search_transactions', revoked_at: null });
  });

  test('a pending op bound to a revoked OLD grant goes stale at commit and is never re-pointed', async () => {
    const db = createTestDb();
    seedTestData(db);
    const scope = scopeOf();
    const grants = grantTools(db, scope, ['update_transaction']);
    const res = await callTool(db, scope, grants.update_transaction, 'update_transaction', { id: firstTxnId(db), notes: 'x' }, 'imperative');
    if (!res.ok || res.kind !== 'operation') throw new Error('expected an operation');
    backdate(db, 'update_transaction', 'edit_transaction');
    // The same owner already holds a live grant for the new name (granted by a build that knew it).
    db.prepare(
      `INSERT INTO mcp_grants (id, batch_id, tool_name, schema_digest, user_id, role, profile, origin, session_generation, expires_at)
       SELECT 'dup-new', batch_id, 'update_transaction', schema_digest, user_id, role, profile, origin, session_generation, expires_at FROM mcp_grants WHERE tool_name = 'edit_transaction'`,
    ).run();
    expect(quiet(() => applyToolRenames(db)).revoked).toBe(1);
    expect(getOperation(db, res.operation.id)!.grant_id).toBe(grants.update_transaction); // not re-pointed
    const out = approveWebMcpOperation(db, res.operation.id, 'test');
    expect(out.outcome).toBe('stale');
  });

  test('a token holding OLD grants ends with exactly the mapped tool list, and still resolves', () => {
    const db = createTestDb();
    const minted = mintTestToken(db, ['search_transactions', 'get_tax_summary', 'list_review_items', 'get_operation_result'], { authEnabled: false });
    backdate(db, 'search_transactions', 'transaction_search');
    backdate(db, 'get_tax_summary', 'tax_summary');
    backdate(db, 'list_review_items', 'list_review_queue');
    const before = db.prepare("SELECT schema_digest, expires_at, session_generation FROM mcp_grants ORDER BY id").all();
    expect(quiet(() => applyToolRenames(db))).toMatchObject({ grants: 3, revoked: 0 });
    const names = db.prepare('SELECT tool_name FROM mcp_grants WHERE revoked_at IS NULL').all().map((r: any) => r.tool_name).sort();
    expect(names).toEqual(['get_operation_result', 'get_tax_summary', 'list_review_items', 'search_transactions']);
    expect(db.prepare("SELECT schema_digest, expires_at, session_generation FROM mcp_grants ORDER BY id").all()).toEqual(before);
    const resolved = resolveClientToken(db, minted.token, 'test');
    expect([...resolved!.grantByTool.keys()].sort()).toEqual(names);
  });
});

describe('I4 chat isolation', () => {
  test('pending operations: webmcp and http-mcp are renamed; chat and terminal rows are untouched', () => {
    const db = createTestDb();
    const mk = (source: 'webmcp' | 'http-mcp' | 'chat', toolName: string) =>
      createOperation(db, {
        source, grantId: null, toolName, args: {}, before: null, after: null, transactionId: null, revisionAtPrepare: null,
        profile: 'test', origin: 'o', sessionGeneration: source === 'chat' ? 'dashboard-chat' : 's', userId: null, role: 'admin',
      });
    const tab = mk('webmcp', 'edit_transaction');
    const mcp = mk('http-mcp', 'tax_flag');
    const chatTax = mk('chat', 'tax_flag');
    const chatEdit = mk('chat', 'edit_transaction');
    const done = mk('webmcp', 'edit_transaction');
    db.prepare("UPDATE mcp_operations SET status = 'committed' WHERE id = @id").run({ id: done.id });
    expect(quiet(() => applyToolRenames(db)).operations).toBe(2);
    expect(getOperation(db, tab.id)!.tool_name).toBe('update_transaction');
    expect(getOperation(db, mcp.id)!.tool_name).toBe('set_tax_flag');
    expect(getOperation(db, chatTax.id)!.tool_name).toBe('tax_flag');
    expect(getOperation(db, chatEdit.id)!.tool_name).toBe('edit_transaction');
    expect(getOperation(db, done.id)!.tool_name).toBe('edit_transaction');
  });

  test('llm tables, interaction annotations, approval tokens and client tokens are untouched', () => {
    const db = createTestDb();
    const id = addInteraction(db, { userPrompt: 'q', toolCalls: [{ id: 't', name: 'transaction_search', args: {} }] });
    db.prepare("INSERT INTO llm_tool_results (interaction_id, tool_call_id, tool_name, tool_args_json, tool_result) VALUES (@id, 'tc', 'tax_flag', '{}', 'r')").run({ id });
    mintTestToken(db, ['search_transactions'], {});
    const tables = ['llm_interactions', 'llm_tool_results', 'interaction_annotations', 'mcp_client_tokens', 'mcp_approval_tokens'];
    const before = tables.map((t) => hash(dump(db, t)));
    putPolicy(db, 0, 'tax_flag', 'off');
    quiet(() => applyToolRenames(db));
    expect(tables.map((t) => hash(dump(db, t)))).toEqual(before);
    expect(count(db, 'llm_tool_results', "tool_name = 'tax_flag'")).toBe(1);
  });
});

describe('I5 audit is verbatim', () => {
  const base = (over: Record<string, unknown> = {}) => ({
    transport: 'imperative', principalKind: 'tab' as const, principalId: 'p1', userId: null, role: 'admin', origin: 'o',
    toolName: 'transaction_search', classification: 'read', decision: 'allowed' as const, ...over,
  });

  test('the fix-up rewrites no audit row; new rows carry canonical names', () => {
    const db = createTestDb();
    appendAudit(db, base() as any);
    appendAudit(db, base({ decision: 'invalid_args', toolName: 'tax_flag' }) as any);
    const before = hash(dump(db, 'mcp_audit_log'));
    putPolicy(db, 0, 'tax_flag', 'off');
    quiet(() => applyToolRenames(db));
    expect(hash(dump(db, 'mcp_audit_log'))).toBe(before);
  });

  test('a noise upsert under the NEW name next to an OLD row in the same bucket does not throw', () => {
    const db = createTestDb();
    appendAudit(db, base({ decision: 'invalid_args', toolName: 'transaction_search' }) as any);
    quiet(() => applyToolRenames(db));
    expect(() => appendAudit(db, base({ decision: 'invalid_args', toolName: 'search_transactions' }) as any)).not.toThrow();
    expect(count(db, 'mcp_audit_log')).toBe(2);
  });

  test('filter expands to retired catalog rows (tool-call transports, and REST lifecycle rows of webmcp/http-mcp ops)', () => {
    const db = createTestDb();
    const webOp = createOperation(db, { source: 'webmcp', grantId: null, toolName: 'edit_transaction', args: {}, before: null, after: null, transactionId: null, revisionAtPrepare: null, profile: 'test', origin: 'o', sessionGeneration: 's', userId: null, role: 'admin' });
    appendAudit(db, base({ toolName: 'edit_transaction', classification: 'mutating' }) as any);
    appendAudit(db, base({ toolName: 'update_transaction', classification: 'mutating' }) as any);
    appendAudit(db, base({ transport: 'rest', toolName: 'edit_transaction', classification: 'mutating', decision: 'committed', operationId: webOp.id }) as any);
    const out = listAudit(db, { tool: 'update_transaction' }).entries;
    expect(out.map((e) => e.tool_name).sort()).toEqual(['edit_transaction', 'edit_transaction', 'update_transaction']);
    expect(out.filter((e) => e.tool_name === 'edit_transaction').every((e) => e.toolCurrent === 'update_transaction')).toBe(true);
    expect(out.find((e) => e.tool_name === 'update_transaction')!.toolCurrent).toBeUndefined();
  });

  test('chat expiry rows, purged-op rest rows and route rows are not mapped', () => {
    const db = createTestDb();
    const chatOp = createOperation(db, { source: 'chat', grantId: null, toolName: 'tax_flag', args: {}, before: null, after: null, transactionId: null, revisionAtPrepare: null, profile: 'test', origin: 'o', sessionGeneration: 'dashboard-chat', userId: null, role: 'admin' });
    appendAudit(db, base({ transport: 'rest', toolName: 'tax_flag', classification: 'mutating', decision: 'expired', operationId: chatOp.id }) as any);
    appendAudit(db, base({ transport: 'rest', toolName: 'tax_flag', classification: 'mutating', decision: 'expired', operationId: 'purged-op' }) as any);
    appendAudit(db, base({ transport: 'rest', toolName: 'tax_flag', classification: 'mutating', decision: 'rest_write', operationId: null }) as any);
    expect(listAudit(db, { tool: 'set_tax_flag' }).entries).toEqual([]);
    const all = listAudit(db, {}).entries;
    expect(all).toHaveLength(3);
    expect(all.every((e) => e.tool_name === 'tax_flag' && e.toolCurrent === undefined)).toBe(true);
  });
});

describe('I7 canonical after ingress', () => {
  test('a pre-upgrade pending judge_interaction op keeps declarative provenance after the fix-up', async () => {
    const db = createTestDb();
    const interactionId = addInteraction(db);
    const scope = testScope();
    const grants = grantTools(db, scope, ['propose_judgment']);
    const args = { interaction_id: interactionId, rating: 4, rationale: 'grounded: the totals match the preview', judge_model: 'claude-sonnet' };
    const parked = await callTool(db, scope, grants.propose_judgment, 'propose_judgment', args, 'declarative');
    if (!parked.ok || parked.kind !== 'operation') throw new Error('expected a parked proposal');
    backdate(db, 'propose_judgment', 'judge_interaction');
    putPolicy(db, 0, 'judge_interaction', 'ask');
    quiet(() => applyToolRenames(db));
    expect(getOperation(db, parked.operation.id)!.tool_name).toBe('propose_judgment');
    expect(approveWebMcpOperation(db, parked.operation.id, 'test').outcome).toBe('committed');
    const row = db.prepare("SELECT created_via, status, source FROM interaction_annotations WHERE source = 'judge'").get() as Record<string, string>;
    expect(row).toEqual({ created_via: 'declarative', status: 'proposed', source: 'judge' });
    expect(JUDGE_RUBRIC_VERSION).toBeTruthy();
  });

  test('a pre-upgrade pending propose_judgements batch op commits through propose_judgments with the batch answer', async () => {
    const db = createTestDb();
    const scope = testScope();
    const grants = grantTools(db, scope, ['propose_judgments']);
    const interactionId = addInteraction(db);
    const parked = await callTool(
      db, scope, grants.propose_judgments, 'propose_judgments',
      { judgeModel: 'm', rubricVersion: JUDGE_RUBRIC_VERSION, items: [{ interactionId, rating: 4, rationale: 'grounded: the totals match the preview' }] }, 'imperative',
    );
    if (!parked.ok || parked.kind !== 'operation') throw new Error('expected a parked proposal');
    backdate(db, 'propose_judgments', 'propose_judgements');
    quiet(() => applyToolRenames(db));
    const out = approveWebMcpOperation(db, parked.operation.id, 'test');
    expect(out.outcome).toBe('committed');
    expect(db.prepare("SELECT created_via FROM interaction_annotations WHERE source = 'judge'").get()).toEqual({ created_via: 'webmcp' });
  });
});

describe('I8 idempotent, always on', () => {
  test('the first run logs one line with counts; a second run changes 0 rows and logs nothing', () => {
    const db = createTestDb();
    putPolicy(db, 0, 'net_worth', 'off');
    const log = spyOn(console, 'log').mockImplementation(() => {});
    try {
      const first = applyToolRenames(db, { profile: 'demo' });
      expect(first.policies).toBe(1);
      expect(log).toHaveBeenCalledTimes(1);
      expect(String(log.mock.calls[0]![0])).toBe('[mcp] tool names updated (profile=demo): policies=1 grants=0 revoked=0 operations=0');
      expect(applyToolRenames(db, { profile: 'demo' })).toEqual({ policies: 0, grants: 0, revoked: 0, operations: 0 });
      expect(log).toHaveBeenCalledTimes(1);
    } finally {
      log.mockRestore();
    }
  });

  test('missing tables are skipped (a DB older than the mcp tables)', () => {
    const db = new Database(':memory:');
    expect(applyToolRenames(db, { quiet: true })).toEqual({ policies: 0, grants: 0, revoked: 0, operations: 0 });
  });

  test('initDatabase runs it for every DB, right after the migrations', () => {
    const spy = spyOn(toolRename, 'applyToolRenames');
    try {
      const db = initDatabase(':memory:', 'probe');
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]![1]).toMatchObject({ profile: 'probe' });
      expect(db.prepare('SELECT COUNT(*) AS n FROM mcp_tool_policies').get()).toEqual({ n: 0 });
    } finally {
      spy.mockRestore();
    }
  });
});

describe('I9 a failed fix-up is not fail-open', () => {
  function seedOldBuild() {
    const db = createTestDb();
    seedTestData(db);
    const scope = testScope();
    const grants = grantTools(db, scope, ['update_transaction', 'search_transactions']);
    return { db, scope, grants };
  }

  test('a failure injected mid-transaction leaves every table unchanged, and old rows stay closed', async () => {
    const { db, scope, grants } = seedOldBuild();
    const res = await callTool(db, scope, grants.update_transaction, 'update_transaction', { id: firstTxnId(db), notes: 'x' }, 'imperative');
    if (!res.ok || res.kind !== 'operation') throw new Error('expected an operation');
    backdate(db, 'update_transaction', 'edit_transaction');
    backdate(db, 'search_transactions', 'transaction_search');
    putPolicy(db, 0, 'spending_summary', 'off');
    const tables = ['mcp_tool_policies', 'mcp_grants', 'mcp_operations'];
    const before = tables.map((t) => hash(dump(db, t)));
    const err = spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(applyToolRenames(db, { onStep: (s) => { if (s === 'operations') throw new Error('injected'); } })).toEqual({ policies: 0, grants: 0, revoked: 0, operations: 0 });
    } finally {
      err.mockRestore();
    }
    expect(tables.map((t) => hash(dump(db, t)))).toEqual(before);
    // Old policies stay effective through the read fallback.
    expect(getEffectivePolicy(db, null, 'get_spending_summary')).toBe('off');
    // Old-name grants fail closed: scope_mismatch under the new name, and not listed.
    expect(validateGrant(db, grants.search_transactions, 'search_transactions', schemaDigest('search_transactions'), scope as any)).toEqual({ ok: false, reason: 'scope_mismatch' });
    expect(exposedTools(db, scope).map((t) => t.name)).toEqual([]);
    // An old-name pending op commits as stale/policy_off.
    const out = approveWebMcpOperation(db, res.operation.id, 'test');
    expect(out).toMatchObject({ outcome: 'stale', reason: 'policy_off' });
  });

  test('a SQLITE_BUSY on BEGIN IMMEDIATE skips the run and stays closed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tool-rename-busy-'));
    try {
      const path = join(dir, 'busy.db');
      const a = new Database(path);
      a.pragma('journal_mode = WAL');
      runMigrations(a);
      putPolicy(a, 0, 'net_worth', 'off');
      const b = new Database(path);
      b.pragma('busy_timeout = 0');
      a.exec('BEGIN IMMEDIATE');
      const err = spyOn(console, 'error').mockImplementation(() => {});
      try {
        expect(applyToolRenames(b, { quiet: true })).toEqual({ policies: 0, grants: 0, revoked: 0, operations: 0 });
        expect(err).toHaveBeenCalled();
      } finally {
        err.mockRestore();
        a.exec('ROLLBACK');
      }
      expect(rawPolicy(b, 0, 'get_net_worth')).toBeUndefined();
      expect(getConfiguredPolicy(b, null, 'get_net_worth')).toBe('off'); // the fallback still holds
      // The next start retries and succeeds.
      expect(applyToolRenames(b, { quiet: true }).policies).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('I10 no migration', () => {
  test('the top migration version is still 33 (v34 is reserved for open-jev)', () => {
    expect(Math.max(...MIGRATIONS.map((m) => m.version))).toBe(33);
    expect(MIGRATIONS).toHaveLength(33);
  });
});

describe('the catalog still knows every renamed tool', () => {
  test('each pair maps to a catalog tool', () => {
    for (const [, neu] of PAIRS) expect(MCP_TOOL_CATALOG.some((d) => d.name === neu), neu).toBe(true);
  });
});
