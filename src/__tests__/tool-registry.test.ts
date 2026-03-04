import { describe, expect, test, beforeEach, afterEach, mock } from 'bun:test';
import { ensureTestProfile } from './helpers.js';

// Re-mock registry.js to restore real behavior (may have been mocked by chain.test.ts)
// We need the real module, so import and re-export the actual functions
mock.module('../mcp/adapter.js', () => ({
  getCachedMcpTools: mock(() => []),
}));

mock.module('../orchestration/registry.js', () => ({
  getOrchestrationTools: mock(async () => []),
}));

const {
  getToolRegistry,
  getTools,
  getToolsByNames,
  buildToolDescriptions,
} = await import('../tools/registry.js');

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
});
