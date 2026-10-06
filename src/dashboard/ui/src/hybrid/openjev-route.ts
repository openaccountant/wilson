// ── open-jev read-tool tiebreak: the pure route decision (Round 4, R4-1) ─────
//
// specs/browser-subagent-round4-openjev-router.md §1, §3, §5, §9.
//
// When the keyword router has 0 or 2+ hits, the open-jev classifier may pick ONE
// of the 5 read tools. Its pick is honoured only when its margin (p1 - p2) clears
// a cut frozen on dev data (§5) and, on a multi-hit, when it is one of the hits
// (DECISIONS Round 4). Everything else hands off to the server as `router-none`,
// which is exactly round-3 behaviour.
//
// `none` is never an option: the rule gate removes non-data and mutation
// questions before open-jev runs, and the spike showed open-jev cannot say none.
//
// Pure, zero-import apart from a type, so the main thread, the model worker (the
// core re-checks a hint) and the eval harness share one definition.

import type { ReadToolName } from '../store/mirror-tools.js';

/** The choice() instructions: the spike's route question with the `none` sentence removed. */
export const OPEN_JEV_ROUTE_QUESTION = 'Which tool should answer this user question?';

/**
 * name -> catalog description, in catalog order, copied VERBATIM from
 * src/mcp/tool-catalog.ts (the UI cannot import it). Asserted by
 * src/__tests__/openjev-route-options-snapshot.test.ts.
 */
export const OPEN_JEV_ROUTE_OPTIONS: Readonly<Record<ReadToolName, string>> = Object.freeze({
  transaction_search: 'Search transactions using a natural language query.',
  spending_summary: 'Spending breakdown by category for the current month, quarter, or year.',
  profit_loss: 'Profit & loss report: income vs. expenses by category for a given period.',
  net_worth: 'Net worth summary, trend over time, or full balance sheet.',
  forecast:
    "Trailing-rate projection of end-of-period cash/savings, with optional what-if adjustments " +
    "(adjust a category's monthly spend, or drop a recurring expense).",
});

/** How options are rendered: tool name + description (the measured configuration) or bare names (§3 fallback). */
export type RouteOptionMode = 'descriptions' | 'bare';

/** The option rendering frozen with the cut (specs/eval/round4-openjev-frozen.json). */
export const OPEN_JEV_ROUTE_OPTION_MODE: RouteOptionMode = 'descriptions';

/**
 * The margin cut, chosen by §5 on DEV data only and frozen in
 * specs/eval/round4-openjev-frozen.json before any held-out arm-O run. `null`
 * means arm O is disabled (no viable cut, or not frozen yet). Not a user setting,
 * and separate from the pre-labeler's per-profile `prelabelMarginCut`.
 */
export const OPEN_JEV_ROUTE_CUT: number | null = null;

/** A chat turn never waits longer than this for a decision (about 3x the measured p95 plus one queued row). */
export const OPEN_JEV_CHAT_TIMEOUT_MS = 400;

/** Valid cut range: B1-a's 0.05 grid bounds. */
const CUT_MIN = 0.05;
const CUT_MAX = 0.95;

/** One open-jev decision over the route options. */
export interface ToolChoice {
  tool: string;
  p1: number;
  p2: number;
  /** p1 - p2 (prelabel/core.ts topTwo). */
  margin: number;
  top2?: [[string, number], [string, number]];
}

export type RouteHandoffWhy = 'disabled' | 'unavailable' | 'bad-margin' | 'unknown-tool' | 'inconsistent' | 'low-margin';

export type RouteDecision =
  | { tool: ReadToolName; via: 'keyword' | 'openjev' }
  | { handoff: 'router-none'; why: RouteHandoffWhy };

const ROUTE_TOOLS = Object.keys(OPEN_JEV_ROUTE_OPTIONS) as ReadToolName[];

export function isRouteTool(x: unknown): x is ReadToolName {
  return typeof x === 'string' && (ROUTE_TOOLS as string[]).includes(x);
}

export function isValidCut(cut: unknown): cut is number {
  return typeof cut === 'number' && Number.isFinite(cut) && cut >= CUT_MIN && cut <= CUT_MAX;
}

/**
 * The route decision for one turn. Total and pure: never throws.
 *  - exactly 1 keyword hit: that tool, `via: 'keyword'` (the choice is ignored);
 *  - otherwise open-jev's top1, `via: 'openjev'`, only when the cut is valid, the
 *    choice exists, its margin is finite and >= cut, its tool is a read tool and,
 *    with 2+ hits, its tool is one of the hits;
 *  - anything else: `router-none` with the reason (eval/UI detail, never on the wire).
 */
export function decideRoute(hits: readonly string[], choice: ToolChoice | null, cut: number | null): RouteDecision {
  const hitList = Array.isArray(hits) ? hits : [];
  if (hitList.length === 1 && isRouteTool(hitList[0])) return { tool: hitList[0], via: 'keyword' };
  if (!isValidCut(cut)) return { handoff: 'router-none', why: 'disabled' };
  if (!choice || typeof choice !== 'object') return { handoff: 'router-none', why: 'unavailable' };
  const { tool, margin } = choice as ToolChoice;
  if (!isRouteTool(tool)) return { handoff: 'router-none', why: 'unknown-tool' };
  if (typeof margin !== 'number' || !Number.isFinite(margin)) return { handoff: 'router-none', why: 'bad-margin' };
  if (hitList.length >= 2 && !hitList.includes(tool)) return { handoff: 'router-none', why: 'inconsistent' };
  if (margin < cut) return { handoff: 'router-none', why: 'low-margin' };
  return { tool, via: 'openjev' };
}

/** The open-jev `choice()` question object for the route decision. */
export function routeChoiceQuestion(mode: RouteOptionMode = OPEN_JEV_ROUTE_OPTION_MODE):
  | { type: 'choice'; instructions: string; options: ReadToolName[]; descriptions: Record<string, string> }
  | { type: 'choice'; instructions: string; options: ReadToolName[] } {
  const options = [...ROUTE_TOOLS];
  return mode === 'descriptions'
    ? { type: 'choice', instructions: OPEN_JEV_ROUTE_QUESTION, options, descriptions: { ...OPEN_JEV_ROUTE_OPTIONS } }
    : { type: 'choice', instructions: OPEN_JEV_ROUTE_QUESTION, options };
}

/** The option strings the model actually reads (open-jev renders a described option as `name: description`). */
export function routeOptionStrings(mode: RouteOptionMode = OPEN_JEV_ROUTE_OPTION_MODE): string[] {
  return ROUTE_TOOLS.map((t) => (mode === 'descriptions' ? `${t}: ${OPEN_JEV_ROUTE_OPTIONS[t]}` : t));
}

/** Total option tokens under a tokenizer (the engine refuses option sets over 200 tokens). */
export function routeOptionTokens(countTokens: (text: string) => number, mode: RouteOptionMode = OPEN_JEV_ROUTE_OPTION_MODE): number {
  return routeOptionStrings(mode).reduce((sum, s) => sum + countTokens(s), 0);
}
