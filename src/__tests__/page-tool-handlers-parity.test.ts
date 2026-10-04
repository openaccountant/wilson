import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { MCP_TOOL_CATALOG } from '../mcp/tool-catalog.js';

/**
 * The catalog says which page tools exist and where they live; React registers the handlers. Nothing else ties the two
 * together, so this reads the UI sources (same approach as the tab-id parity test) and fails when a handler is
 * registered for a tool the catalog does not know, on the wrong tab, or a catalog page tool has no handler at all:
 * the first is dead code, the second is a tool that is registered but answers with "not available".
 */

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const stripComments = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const TAB_FILES: Record<string, string> = {
  transactions: '../dashboard/ui/src/tabs/TransactionsTab.tsx',
  review: '../dashboard/ui/src/tabs/ReviewTab.tsx',
  llm: '../dashboard/ui/src/tabs/LlmTab.tsx',
};

/** `useWebMcpPageTools('tab', { name: async (...) => ..., })` → tab and handler names. */
function pageToolCalls(code: string): Array<{ tab: string; names: string[] }> {
  const calls: Array<{ tab: string; names: string[] }> = [];
  for (const match of code.matchAll(/useWebMcpPageTools\('(\w+)',\s*\{([\s\S]*?)\n  \}\);/g)) {
    calls.push({ tab: match[1], names: [...match[2].matchAll(/^    (\w+): async /gm)].map((m) => m[1]) });
  }
  return calls;
}

const imperativePageTools = MCP_TOOL_CATALOG.filter((d) => d.classification === 'page' && d.exposure === 'imperative');

describe('page tool handlers match the catalog', () => {
  test("each tab registers only its own tab's page tools, and every one of them is a catalog page tool for that tab", () => {
    for (const [tab, file] of Object.entries(TAB_FILES)) {
      const calls = pageToolCalls(stripComments(read(file)));
      expect(calls.map((c) => c.tab), file).toEqual([tab]);
      for (const name of calls[0].names) {
        const def = MCP_TOOL_CATALOG.find((d) => d.name === name);
        expect(def, `${file} registers ${name}`).toBeDefined();
        expect(def!.classification, name).toBe('page');
        expect(def!.exposure, name).toBe('imperative');
        expect(def!.surface as unknown, name).toEqual({ tab });
      }
    }
  });

  test('every tab-scoped imperative page tool in the catalog has a handler in its tab', () => {
    for (const def of imperativePageTools) {
      if (def.surface === 'global') continue;
      const file = TAB_FILES[def.surface.tab];
      expect(file, `no tab file for ${def.name} (${def.surface.tab})`).toBeDefined();
      const names = pageToolCalls(stripComments(read(file))).flatMap((c) => c.names);
      expect(names, def.name).toContain(def.name);
    }
  });

  test('every global imperative page tool in the catalog has a handler in WebMcpProvider, and it registers nothing else', () => {
    const code = stripComments(read('../dashboard/ui/src/agent/WebMcpProvider.tsx'));
    const registered = [...code.matchAll(/^ {6}(\w+): async /gm)].map((m) => m[1]).sort();
    const globals = imperativePageTools.filter((d) => d.surface === 'global').map((d) => d.name).sort();
    expect(registered).toEqual(globals);
    expect(globals.length).toBeGreaterThan(0);
  });

  test('the app mounts the provider around the tab content, with the tab and the same navigation a click uses', () => {
    const code = stripComments(read('../dashboard/ui/src/App.tsx'));
    expect(code).toMatch(/<WebMcpProvider activeTab=\{activeTab\} onNavigate=\{handleTabChange\}>[\s\S]*<main[\s\S]*<\/main>[\s\S]*<\/WebMcpProvider>/);
  });

  test('a tab unmount aborts its handlers: the hook hands the registry one AbortController per mount', () => {
    const code = stripComments(read('../dashboard/ui/src/agent/useWebMcpPageTools.ts'));
    expect(code).toContain('bindPageHandlers');
    expect(code).toMatch(/return bindPageHandlers\(/); // the effect returns the disposer that aborts
  });
});
