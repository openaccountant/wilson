import { afterEach, describe, expect, test } from 'bun:test';
import { createTestDb, seedTestData } from './helpers.js';
import { count, firstTxnId, grantTools, testScope } from './mcp-helpers.js';
import { callTool, exposedTools, grantLocalAccess } from '../mcp/engine.js';
import { MCP_TOOL_CATALOG } from '../mcp/tool-catalog.js';
import {
  allowedPolicies,
  getConfiguredPolicy,
  getEffectivePolicy,
  listPolicies,
  setPolicy,
  type PolicyActor,
} from '../mcp/policies.js';
import { setKillSwitch } from '../mcp/engine.js';
import { setGlobalAgentState } from '../mcp/global-state.js';

afterEach(() => setGlobalAgentState({ enabled: undefined, killSwitchEpoch: undefined }));

/**
 * P1 policy model (spec 1.2): per user, per profile, Off / Ask / Allow per
 * tool. Reads default to Allow, changes default to Ask and can never be Allow.
 */

const admin: PolicyActor = { userId: null, role: 'admin', authEnabled: false };
const viewer: PolicyActor = { userId: 7, role: 'viewer', authEnabled: true };
const adminUser: PolicyActor = { userId: 3, role: 'admin', authEnabled: true };

describe('default policy', () => {
  test('reads default to allow, changes to ask; every catalog tool declares it', () => {
    const db = createTestDb();
    for (const def of MCP_TOOL_CATALOG) {
      expect(['off', 'ask', 'allow']).toContain(def.defaultPolicy);
      // Reads and page tools (which change only what the tab shows) default to allow; changes and judge proposals to ask.
      expect(getEffectivePolicy(db, null, def.name)).toBe(def.classification === 'mutating' || def.classification === 'proposal' ? 'ask' : 'allow');
    }
  });

  test('a mutating default is never allow (the catalog cannot ship one)', () => {
    for (const def of MCP_TOOL_CATALOG.filter((d) => d.classification === 'mutating')) {
      expect(def.defaultPolicy).not.toBe('allow');
    }
  });

  test('a policy row stored for a tool changes only that tool', () => {
    const db = createTestDb();
    expect(setPolicy(db, admin, 'search_transactions', 'ask').ok).toBe(true);
    expect(getConfiguredPolicy(db, null, 'search_transactions')).toBe('ask');
    expect(getConfiguredPolicy(db, null, 'get_spending_summary')).toBe('allow');
  });
});

describe('changes can never be allowed', () => {
  test('setPolicy(allow) on a mutating tool is refused with the reason, and nothing is stored', () => {
    const db = createTestDb();
    const out = setPolicy(db, admin, 'update_transaction', 'allow');
    expect(out).toMatchObject({ ok: false, status: 400 });
    expect((out as { error: string }).error).toBe('Changes always require approval; choose Ask or Off.');
    expect(count(db, 'mcp_tool_policies')).toBe(0);
  });

  test('a stored allow on a mutating tool (written behind our back) is clamped to ask', () => {
    const db = createTestDb();
    db.prepare("INSERT INTO mcp_tool_policies (user_key, tool_name, policy) VALUES (0, 'update_transaction', 'allow')").run();
    expect(getConfiguredPolicy(db, null, 'update_transaction')).toBe('ask');
    expect(getEffectivePolicy(db, null, 'update_transaction')).toBe('ask');
  });

  test('the table itself only accepts off, ask or allow', () => {
    const db = createTestDb();
    expect(() => db.prepare("INSERT INTO mcp_tool_policies (user_key, tool_name, policy) VALUES (0, 'x', 'sure')").run()).toThrow();
  });

  test('allowedPolicies: reads offer all three, changes offer off and ask, a /mcp-only lookup offers off and allow', () => {
    const byName = (n: string) => MCP_TOOL_CATALOG.find((d) => d.name === n)!;
    expect(allowedPolicies(byName('search_transactions'))).toEqual(['off', 'ask', 'allow']);
    expect(allowedPolicies(byName('update_transaction'))).toEqual(['off', 'ask']);
    expect(allowedPolicies(byName('get_operation_result'))).toEqual(['off', 'allow']);
  });
});

describe('who may set a policy', () => {
  test('a viewer cannot set a policy on a tool that changes data', () => {
    const db = createTestDb();
    const out = setPolicy(db, viewer, 'update_transaction', 'off');
    expect(out).toMatchObject({ ok: false, status: 403, code: 'role_forbidden' });
    expect(count(db, 'mcp_tool_policies')).toBe(0);
  });

  test('a viewer may set policies on read tools, for themselves only', () => {
    const db = createTestDb();
    expect(setPolicy(db, viewer, 'search_transactions', 'ask').ok).toBe(true);
    expect(getEffectivePolicy(db, 7, 'search_transactions')).toBe('ask');
    expect(getEffectivePolicy(db, 3, 'search_transactions')).toBe('allow');
  });

  test('an unknown tool is a 404-style refusal, not a stored row', () => {
    const db = createTestDb();
    expect(setPolicy(db, admin, 'drop_tables', 'off')).toMatchObject({ ok: false, status: 404 });
    expect(count(db, 'mcp_tool_policies')).toBe(0);
  });

  test('enabling auth keeps what was chosen without it: a tool turned Off stays Off for a user with no row of their own', () => {
    const db = createTestDb();
    expect(setPolicy(db, admin, 'search_transactions', 'off')).toMatchObject({ ok: true });
    expect(getConfiguredPolicy(db, null, 'search_transactions')).toBe('off');
    // Auth is switched on; user 3 has never set anything.
    expect(getConfiguredPolicy(db, adminUser.userId, 'search_transactions')).toBe('off');
    expect(getEffectivePolicy(db, adminUser.userId, 'search_transactions')).toBe('off');
    // Their own choice wins from then on, and does not leak into the auth-off row.
    expect(setPolicy(db, adminUser, 'search_transactions', 'allow')).toMatchObject({ ok: true });
    expect(getConfiguredPolicy(db, adminUser.userId, 'search_transactions')).toBe('allow');
    expect(getConfiguredPolicy(db, null, 'search_transactions')).toBe('off');
  });

  test('policies are per user: one user turning a tool off leaves another user alone', () => {
    const db = createTestDb();
    setPolicy(db, adminUser, 'get_cash_forecast', 'off');
    expect(getEffectivePolicy(db, 3, 'get_cash_forecast')).toBe('off');
    expect(getEffectivePolicy(db, 4, 'get_cash_forecast')).toBe('allow');
    expect(getEffectivePolicy(db, null, 'get_cash_forecast')).toBe('allow');
  });

  test('listPolicies shows the configured and effective policy of every tool', () => {
    const db = createTestDb();
    setPolicy(db, admin, 'get_cash_forecast', 'ask');
    const rows = listPolicies(db, null);
    expect(rows.find((r) => r.tool === 'get_cash_forecast')).toEqual({ tool: 'get_cash_forecast', policy: 'ask', effective: 'ask' });
    expect(rows.find((r) => r.tool === 'update_transaction')).toEqual({ tool: 'update_transaction', policy: 'ask', effective: 'ask' });
    expect(rows).toHaveLength(MCP_TOOL_CATALOG.length);
  });
});

describe('policy is enforced on the one call path', () => {
  test('policy off: a grant POST is refused (400 policy_off) and no grant row is made', () => {
    const db = createTestDb();
    setPolicy(db, admin, 'search_transactions', 'off');
    const out = grantLocalAccess(db, testScope(), ['search_transactions']);
    expect(out).toMatchObject({ ok: false, status: 400, code: 'policy_off' });
    expect(count(db, 'mcp_grants')).toBe(0);
  });

  test('policy off: callTool answers 403 policy_off even with a live grant, and audits denied_policy', async () => {
    const db = createTestDb();
    seedTestData(db);
    const scope = testScope();
    const grants = grantTools(db, scope, ['search_transactions']);
    setPolicy(db, admin, 'search_transactions', 'off');
    const out = await callTool(db, scope, grants.search_transactions, 'search_transactions', { query: 'groceries' }, 'imperative');
    expect(out).toMatchObject({ ok: false, status: 403, code: 'policy_off' });
    expect(count(db, 'mcp_audit_log', "decision = 'denied_policy'")).toBe(1);
  });

  test('policy off: the tool is no longer offered to the tab, and comes back when the policy does', () => {
    const db = createTestDb();
    const scope = testScope();
    grantTools(db, scope, ['search_transactions', 'get_cash_forecast']);
    setPolicy(db, admin, 'search_transactions', 'off');
    expect(exposedTools(db, scope).map((t) => t.name)).toEqual(['get_cash_forecast']);
    setPolicy(db, admin, 'search_transactions', 'allow');
    expect(exposedTools(db, scope).map((t) => t.name).sort()).toEqual(['get_cash_forecast', 'search_transactions']);
  });

  test('policy off applies to /mcp as well (same call path)', async () => {
    const db = createTestDb();
    seedTestData(db);
    const scope = testScope();
    const grants = grantTools(db, scope, ['search_transactions']);
    setPolicy(db, admin, 'search_transactions', 'off');
    const out = await callTool(db, scope, grants.search_transactions, 'search_transactions', { query: 'x' }, 'http-mcp');
    // http-mcp has its own grant rules; either way the call must not run.
    expect(out.ok).toBe(false);
  });

  test('the effective policy is off for every tool while the kill switch is off', () => {
    const db = createTestDb();
    setKillSwitch(db, false);
    for (const def of MCP_TOOL_CATALOG) expect(getEffectivePolicy(db, null, def.name)).toBe('off');
    setKillSwitch(db, true);
    expect(getEffectivePolicy(db, null, 'get_cash_forecast')).toBe('allow');
  });

  test('allow (the default) leaves a read running immediately', async () => {
    const db = createTestDb();
    seedTestData(db);
    const scope = testScope();
    const grants = grantTools(db, scope, ['search_transactions']);
    const out = await callTool(db, scope, grants.search_transactions, 'search_transactions', { query: 'groceries' }, 'imperative');
    expect(out).toMatchObject({ ok: true, kind: 'read' });
    expect(firstTxnId(db)).toBeGreaterThan(0);
  });
});
