/**
 * Retired WebMCP catalog tool names (renamed in 0.10.0; see specs/webmcp-tool-naming.md).
 *
 * Pure: imports nothing, so the DB layer, tests and server can all use it without pulling in the catalog.
 *
 * Hard rule: these helpers are called only at the sites the spec lists. They are NEVER called on a row or
 * request whose source is chat (five retired names are live chat tool names), and NEVER inside `getToolDef`,
 * which stays an exact match. A retired name grants nothing.
 */

export interface RetiredToolName {
  /** The current catalog name. */
  readonly name: string;
  readonly retiredIn: string;
  /** The name was in a release (v0.9.x). */
  readonly shipped: boolean;
}

export const RETIRED_TOOL_NAMES: Readonly<Record<string, RetiredToolName>> = Object.freeze({
  tax_flag: { name: 'set_tax_flag', retiredIn: '0.10.0', shipped: true },
  edit_transaction: { name: 'update_transaction', retiredIn: '0.10.0', shipped: true },
  tax_summary: { name: 'get_tax_summary', retiredIn: '0.10.0', shipped: false },
  transaction_search: { name: 'search_transactions', retiredIn: '0.10.0', shipped: true },
  spending_summary: { name: 'get_spending_summary', retiredIn: '0.10.0', shipped: true },
  profit_loss: { name: 'get_profit_loss', retiredIn: '0.10.0', shipped: true },
  net_worth: { name: 'get_net_worth', retiredIn: '0.10.0', shipped: true },
  forecast: { name: 'get_cash_forecast', retiredIn: '0.10.0', shipped: true },
  filter_transactions: { name: 'list_transactions', retiredIn: '0.10.0', shipped: false },
  review_action: { name: 'resolve_review_item', retiredIn: '0.10.0', shipped: false },
  set_forecast_inputs: { name: 'fill_forecast_inputs', retiredIn: '0.10.0', shipped: false },
  navigate_to_tab: { name: 'open_tab', retiredIn: '0.10.0', shipped: false },
  list_review_queue: { name: 'list_review_items', retiredIn: '0.10.0', shipped: false },
  propose_judgements: { name: 'propose_judgments', retiredIn: '0.10.0', shipped: false },
  judge_interaction: { name: 'propose_judgment', retiredIn: '0.10.0', shipped: false },
});

const OWN = Object.prototype.hasOwnProperty;

export function isRetiredToolName(name: string): boolean {
  return OWN.call(RETIRED_TOOL_NAMES, name);
}

/** The retired names that now map to `current` (empty for a name that was never renamed). */
export function retiredNamesFor(current: string): string[] {
  return Object.keys(RETIRED_TOOL_NAMES).filter((old) => RETIRED_TOOL_NAMES[old]!.name === current);
}

/** The current name for a retired one, or undefined. */
export function currentNameFor(old: string): string | undefined {
  return isRetiredToolName(old) ? RETIRED_TOOL_NAMES[old]!.name : undefined;
}

/** Message tail for a refused retired name, e.g. `renamed to "search_transactions" in 0.10.0`. */
export function retiredNameHint(old: string): string | undefined {
  const r = isRetiredToolName(old) ? RETIRED_TOOL_NAMES[old]! : undefined;
  return r ? `renamed to "${r.name}" in ${r.retiredIn}` : undefined;
}

const POLICY_RANK: Readonly<Record<string, number>> = { off: 0, ask: 1, allow: 2 };

/** The stricter of two policy values (`off` < `ask` < `allow`). */
export function mostRestrictivePolicy<T extends string>(a: T, b: T): T {
  return (POLICY_RANK[a] ?? 0) <= (POLICY_RANK[b] ?? 0) ? a : b;
}
