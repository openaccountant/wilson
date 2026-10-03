import { describe, expect, test } from 'bun:test';
import { MCP_TOOL_CATALOG } from '../mcp/tool-catalog.js';
import { OPEN_JEV_ROUTE_OPTIONS } from '../dashboard/ui/src/hybrid/openjev-route.js';

/**
 * Round 4 §3 guard rail: the open-jev route options are the read tools' catalog
 * descriptions, copied verbatim into a frozen constant (the UI cannot import the
 * catalog). A catalog edit fails this test instead of silently changing routing;
 * changing the options after the dev cut is frozen also breaks the frozen-JSON test.
 */
describe('open-jev route options snapshot', () => {
  test('every option string equals the catalog description of that read tool', () => {
    for (const [name, description] of Object.entries(OPEN_JEV_ROUTE_OPTIONS)) {
      const def = MCP_TOOL_CATALOG.find((t) => t.name === name);
      expect(def, name).toBeDefined();
      expect(def!.classification).toBe('read');
      expect(description).toBe(def!.description);
    }
  });

  test('the options cover every read tool in the catalog, and only those', () => {
    const reads = MCP_TOOL_CATALOG.filter((t) => t.classification === 'read').map((t) => t.name);
    expect(Object.keys(OPEN_JEV_ROUTE_OPTIONS).sort()).toEqual([...reads].sort());
  });
});
