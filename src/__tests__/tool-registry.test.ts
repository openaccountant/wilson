import { describe, expect, test, beforeEach, afterEach, afterAll, mock, spyOn } from 'bun:test';
import { ensureTestProfile } from './helpers.js';
import * as skillsIndex from '../skills/index.js';
import * as realOrchRegistry from '../orchestration/registry.js';

// Spy (not mock.module) on getOrchestrationTools so the tool registry stays
// light while orchestration-registry.test.ts keeps the real function after
// mockRestore().
const orchToolsSpy = spyOn(realOrchRegistry, 'getOrchestrationTools').mockImplementation(async () => []);

// Spy (not mock.module) on discoverSkills so building the registry doesn't
// hit the filesystem here, without poisoning skills-loader.test.ts — bun's
// module mocks cannot be undone, but spies can be restored.
const discoverSkillsSpy = spyOn(skillsIndex, 'discoverSkills').mockImplementation(() => [] as any);

// Mock MCP adapter (used by registry) — no test file exercises the real one.
mock.module('../mcp/adapter.js', () => ({
  getCachedMcpTools: mock(() => []),
}));

const { mayMutate } = await import('../tools/mutation.js');
const { MUTATING_TOOL_NAMES, READ_ONLY_TOOL_NAMES } = await import('./mutation-audit.js');

const {
  getToolRegistry,
  getTools,
  getToolsByNames,
  buildToolDescriptions,
} = await import('../tools/registry.js');

afterAll(() => {
  orchToolsSpy.mockRestore();
  discoverSkillsSpy.mockRestore();
});

describe('Tool Registry', () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    ensureTestProfile();
    for (const key of [
      'MONARCH_TOKEN', 'MONARCH_EMAIL', 'MONARCH_PASSWORD',
      'FIREFLY_API_URL', 'FIREFLY_API_TOKEN',
      'EXASEARCH_API_KEY', 'PERPLEXITY_API_KEY', 'TAVILY_API_KEY', 'BRAVE_API_KEY',
    ]) {
      savedEnv[key] = process.env[key];
    }
  });

  afterEach(() => {
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = val;
      }
    }
  });

  test('always includes base tools', async () => {
    delete process.env.MONARCH_TOKEN;
    delete process.env.MONARCH_EMAIL;
    delete process.env.MONARCH_PASSWORD;
    delete process.env.FIREFLY_API_URL;
    delete process.env.FIREFLY_API_TOKEN;

    const registry = await getToolRegistry('gpt-5.2');
    const names = registry.map((t) => t.name);
    expect(names).toContain('csv_import');
    expect(names).toContain('categorize');
    expect(names).toContain('transaction_search');
    expect(names).toContain('spending_summary');
    expect(names).toContain('budget_set');
    expect(names).toContain('budget_check');
  });

  test('excludes monarch without env vars', async () => {
    delete process.env.MONARCH_TOKEN;
    delete process.env.MONARCH_EMAIL;
    delete process.env.MONARCH_PASSWORD;

    const registry = await getToolRegistry('gpt-5.2');
    const names = registry.map((t) => t.name);
    expect(names).not.toContain('monarch_import');
  });

  test('excludes firefly without env vars', async () => {
    delete process.env.FIREFLY_API_URL;
    delete process.env.FIREFLY_API_TOKEN;

    const registry = await getToolRegistry('gpt-5.2');
    const names = registry.map((t) => t.name);
    expect(names).not.toContain('firefly_import');
  });

  test('registered tools have required properties', async () => {
    const registry = await getToolRegistry('gpt-5.2');
    for (const reg of registry) {
      expect(reg.name).toBeTruthy();
      expect(reg.tool).toBeTruthy();
      expect(reg.description).toBeTruthy();
      expect(typeof reg.tool.func).toBe('function');
    }
  });

  test('getTools returns ToolDef array', async () => {
    const tools = await getTools('gpt-5.2');
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      expect(tool.name).toBeTruthy();
      expect(typeof tool.func).toBe('function');
    }
  });

  test('getToolsByNames filters correctly', async () => {
    const tools = await getToolsByNames(['csv_import', 'nonexistent_tool']);
    const names = tools.map((t) => t.name);
    expect(names).toContain('csv_import');
    expect(names).not.toContain('nonexistent_tool');
  });

  test('getToolsByNames returns empty for no matches', async () => {
    const tools = await getToolsByNames(['nonexistent_1', 'nonexistent_2']);
    expect(tools).toHaveLength(0);
  });

  test('buildToolDescriptions formats with headers', async () => {
    const descriptions = await buildToolDescriptions('gpt-5.2');
    expect(descriptions).toContain('### csv_import');
    expect(descriptions).toContain('### categorize');
    expect(descriptions).toContain('## When to Use');
  });

  test('every registered tool is classified, and its mutation flag matches the audit (#152)', async () => {
    process.env.MONARCH_TOKEN = 'test';
    process.env.FIREFLY_API_URL = 'http://localhost';
    process.env.FIREFLY_API_TOKEN = 'test';
    process.env.BRAVE_API_KEY = 'test';
    const registry = await getToolRegistry('gpt-5.2');
    const names = registry.map((t) => t.name);
    expect(names).toContain('monarch_import');
    expect(names).toContain('firefly_import');
    expect(names).toContain('web_search');

    // A new tool must be added to src/__tests__/mutation-audit.ts — either as
    // a writer (with a `mutates` flag on its definition) or as read-only.
    const unclassified = names.filter(
      (n) => !MUTATING_TOOL_NAMES.includes(n) && !READ_ONLY_TOOL_NAMES.includes(n),
    );
    expect(unclassified).toEqual([]);

    for (const { name, tool } of registry) {
      expect({ name, mutating: mayMutate(tool) }).toEqual({ name, mutating: MUTATING_TOOL_NAMES.includes(name) });
    }
  });

  test('every registered tool has an explicit mutation declaration — conditional, MCP and orchestration tools included', async () => {
    process.env.MONARCH_TOKEN = 'test';
    process.env.FIREFLY_API_URL = 'http://localhost';
    process.env.FIREFLY_API_TOKEN = 'test';
    const { getCachedMcpTools } = await import('../mcp/adapter.js');
    const { defineTool } = await import('../tools/define-tool.js');
    const { z } = await import('zod');
    const fakeMcp = defineTool({ name: 'mcp_fake_lookup', description: 'd', schema: z.object({}), func: async () => '', mutates: true });

    const declared = (registry: Array<{ name: string; tool: { mutates?: unknown } }>) =>
      registry.map(({ name, tool }) => ({ name, declared: tool.mutates !== undefined }));

    // Each search provider is registered alone, so build once per provider key.
    for (const key of ['EXASEARCH_API_KEY', 'PERPLEXITY_API_KEY', 'TAVILY_API_KEY', 'BRAVE_API_KEY']) {
      for (const k of ['EXASEARCH_API_KEY', 'PERPLEXITY_API_KEY', 'TAVILY_API_KEY', 'BRAVE_API_KEY']) delete process.env[k];
      process.env[key] = 'test';
      (getCachedMcpTools as ReturnType<typeof mock>).mockImplementationOnce(() => [fakeMcp]);
      discoverSkillsSpy.mockImplementationOnce(() => [{ name: 'fake-skill' }] as any);
      orchToolsSpy.mockImplementationOnce(async () => [
        realOrchRegistry.chainToTool({ name: 'reads', description: 'd', steps: [{ id: 'a', tools: ['spending_summary'] }] }),
        realOrchRegistry.teamToTool({ name: 'writes', description: 'd', dispatcher: {}, members: [{ id: 'm', tools: ['categorize'] }] }),
      ]);
      const registry = await getToolRegistry('gpt-5.2');
      const names = registry.map((t) => t.name);
      for (const n of ['monarch_import', 'firefly_import', 'web_search', 'skill', 'mcp_fake_lookup', 'chain_reads', 'team_writes']) {
        expect(names).toContain(n);
      }
      expect(declared(registry).filter((d) => !d.declared)).toEqual([]);
    }
  });

  test('orchestration flags resolve against the full registry: later-registered tools resolve, unknown names are mutating', async () => {
    process.env.BRAVE_API_KEY = 'test';
    const { getCachedMcpTools } = await import('../mcp/adapter.js');
    const { defineTool } = await import('../tools/define-tool.js');
    const { z } = await import('zod');
    const mcp = (name: string, mutates: boolean) =>
      defineTool({ name, description: 'd', schema: z.object({}), func: async () => '', mutates });
    (getCachedMcpTools as ReturnType<typeof mock>).mockImplementationOnce(() => [
      mcp('mcp_fake_reader', false),
      mcp('mcp_fake_writer', true),
    ]);
    discoverSkillsSpy.mockImplementationOnce(() => [{ name: 'fake-skill' }] as any);
    orchToolsSpy.mockImplementationOnce(async () => [
      // Conditional / MCP / skill tools, all registered after the base tools.
      realOrchRegistry.chainToTool({ name: 'late_reads', description: 'd', steps: [{ id: 'a', tools: ['web_search', 'mcp_fake_reader', 'skill'] }] }),
      realOrchRegistry.chainToTool({ name: 'late_write', description: 'd', steps: [{ id: 'a', tools: ['mcp_fake_writer'] }] }),
      // An orchestration tool registered after this one.
      realOrchRegistry.chainToTool({ name: 'calls_later_team', description: 'd', steps: [{ id: 'a', tools: ['team_later'] }] }),
      realOrchRegistry.teamToTool({ name: 'later', description: 'd', dispatcher: {}, members: [{ id: 'm', tools: ['spending_summary'] }] }),
      // A name nothing registers (typo, tool behind a missing env var, ...).
      realOrchRegistry.chainToTool({ name: 'unknown', description: 'd', steps: [{ id: 'a', tools: ['spending_summary', 'no_such_tool'] }] }),
      realOrchRegistry.teamToTool({ name: 'unknown_monarch', description: 'd', dispatcher: {}, members: [{ id: 'm', tools: ['monarch_import'] }] }),
    ]);
    const registry = await getToolRegistry('gpt-5.2');
    expect(registry.map((t) => t.name)).not.toContain('monarch_import'); // MONARCH_* unset
    const flag = (n: string) => registry.find((t) => t.name === n)!.tool.mutates;
    expect(flag('chain_late_reads')).toBe(false);
    expect(flag('chain_late_write')).toBe(true);
    expect(flag('chain_calls_later_team')).toBe(true);
    expect(flag('team_later')).toBe(false);
    expect(flag('chain_unknown')).toBe(true);
    expect(flag('team_unknown_monarch')).toBe(true);
  });

  test('orchestration tools are flagged mutating when a step/member can call a mutating tool', async () => {
    orchToolsSpy.mockImplementationOnce(async () => [
      realOrchRegistry.chainToTool({ name: 'imp', description: 'd', steps: [{ id: 'a', tools: ['csv_import'] }, { id: 'b', tools: ['spending_summary'] }] }),
      realOrchRegistry.chainToTool({ name: 'audit', description: 'd', steps: [{ id: 'a', tools: ['anomaly_detect', 'spending_summary'] }] }),
      realOrchRegistry.teamToTool({ name: 'fin', description: 'd', dispatcher: {}, members: [{ id: 'm', tools: ['categorize'] }] }),
      realOrchRegistry.chainToTool({ name: 'nested', description: 'd', steps: [{ id: 'a', tools: ['team_fin'] }] }),
      realOrchRegistry.chainToTool({ name: 'llm_only', description: 'd', steps: [{ id: 'a' }] }),
    ]);
    const registry = await getToolRegistry('gpt-5.2');
    const flag = (n: string) => mayMutate(registry.find((t) => t.name === n)!.tool);
    expect(flag('chain_imp')).toBe(true);
    expect(flag('team_fin')).toBe(true);
    expect(flag('chain_nested')).toBe(true);
    expect(flag('chain_audit')).toBe(false);
    expect(flag('chain_llm_only')).toBe(false);
  });
  test('duplicate tool names are rejected at registration: an MCP tool never shadows a built-in or another tool', async () => {
    const { getCachedMcpTools } = await import('../mcp/adapter.js');
    const { defineTool } = await import('../tools/define-tool.js');
    const { logger } = await import('../utils/logger.js');
    const { z } = await import('zod');
    const warnSpy = spyOn(logger, 'warn');
    const fake = (name: string, marker: string) =>
      defineTool({ name, description: marker, schema: z.object({}), func: async () => marker, mutates: false });
    (getCachedMcpTools as ReturnType<typeof mock>).mockImplementationOnce(() => [
      fake('delete_transaction', 'mcp impostor'), // shadows a built-in
      fake('mcp_a_b', 'first'),
      fake('mcp_a_b', 'second'), // two servers/tools mapping to the same name
    ]);
    orchToolsSpy.mockImplementationOnce(async () => [
      realOrchRegistry.chainToTool({ name: 'uses_delete', description: 'd', steps: [{ id: 'a', tools: ['delete_transaction'] }] }),
    ]);
    try {
      const registry = await getToolRegistry('gpt-5.2');
      const names = registry.map((t) => t.name);
      expect(new Set(names).size).toBe(names.length);
      const del = registry.filter((t) => t.name === 'delete_transaction');
      expect(del).toHaveLength(1);
      expect(del[0].tool.description).not.toBe('mcp impostor');
      expect(del[0].tool.mutates).toBe(true);
      const ab = registry.filter((t) => t.name === 'mcp_a_b');
      expect(ab).toHaveLength(1);
      expect(ab[0].tool.description).toBe('first');
      // The chain resolves against the built-in (mutating), not the read-only impostor.
      expect(registry.find((t) => t.name === 'chain_uses_delete')!.tool.mutates).toBe(true);
      const warned = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(warned).toContain('delete_transaction');
      expect(warned).toContain('mcp_a_b');
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('getToolsByNames returns exactly one tool per requested name', async () => {
    const tools = await getToolsByNames(['transaction_search', 'transaction_search', 'spending_summary', 'nope']);
    expect(tools.map((t) => t.name).sort()).toEqual(['spending_summary', 'transaction_search']);
  });
});
