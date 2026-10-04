import { describe, expect, test } from 'bun:test';
import { MCP_TOOL_CATALOG } from '../mcp/tool-catalog.js';
import { OPEN_JEV_ROUTE_OPTIONS } from '../dashboard/ui/src/hybrid/openjev-route.js';
import { READ_TOOL_NAMES } from '../dashboard/ui/src/store/mirror-tools.js';

/**
 * Round 4 §3 guard rail: the open-jev route options are the read tools' catalog
 * descriptions as they were when the router was measured, copied verbatim into a
 * frozen constant (the UI cannot import the catalog). The strings themselves are
 * pinned by the frozen-JSON test (specs/eval/round4-openjev-frozen.json): changing
 * them invalidates that measurement.
 *
 * The WebMCP catalog v2 rewrote the read tools' descriptions for agents (paging,
 * untrusted-data notes) and added read tools the browser mirror does not serve. The
 * router keeps its measured strings and its five mirror tools; re-freezing it on the
 * v2 wording is a deliberate re-measurement, not a side effect of a catalog edit.
 */
const MEASURED_CATALOG_DESCRIPTIONS: Readonly<Record<string, string>> = {
  transaction_search: 'Search transactions using a natural language query.',
  spending_summary: 'Spending breakdown by category for the current month, quarter, or year.',
  profit_loss: 'Profit & loss report: income vs. expenses by category for a given period.',
  net_worth: 'Net worth summary, trend over time, or full balance sheet.',
  forecast:
    "Trailing-rate projection of end-of-period cash/savings, with optional what-if adjustments " +
    "(adjust a category's monthly spend, or drop a recurring expense).",
};

describe('open-jev route options snapshot', () => {
  test('every option is a read tool of the catalog, described as it was when the router was measured', () => {
    for (const [name, description] of Object.entries(OPEN_JEV_ROUTE_OPTIONS)) {
      const def = MCP_TOOL_CATALOG.find((t) => t.name === name);
      expect(def, name).toBeDefined();
      expect(def!.classification).toBe('read');
      expect(description).toBe(MEASURED_CATALOG_DESCRIPTIONS[name]);
    }
  });

  test('the options cover exactly the read tools the browser mirror serves', () => {
    expect(Object.keys(OPEN_JEV_ROUTE_OPTIONS).sort()).toEqual([...READ_TOOL_NAMES].sort());
  });
});
