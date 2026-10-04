/**
 * Per-request tool selection for local (Transformers.js) models — design
 * 2026-10-03, approach E.
 *
 * MiniLM embeddings rank the tool cards; keyword groups and recent use boost
 * the ranking; the core tools are always in; a token packer decides how many
 * ranked tools fit. Every tool not selected is listed by name and stays
 * callable, and the selected set only grows within a run (growSelection).
 *
 * Pure: the embedder is injected, so tests use deterministic fake vectors.
 * Recall comes before precision (R2): an extra tool costs tokens, a missing
 * one means the model cannot do the task.
 */

import type { EmbedFn } from './tool-cards.js';

/**
 * Settings key: 'auto' (default) selects tools for Transformers.js models,
 * 'off' never does. 'always' is accepted and is 'auto' for now — only the
 * Transformers adapter renders the names-only index that keeps unselected
 * tools reachable, so other providers keep every tool.
 */
export const LOCAL_TOOL_SELECTION_KEY = 'localToolSelection';
export type LocalToolSelectionSetting = 'auto' | 'off' | 'always';

/** Whether a run on `providerId` gets per-request tool selection. */
export function shouldSelectTools(providerId: string, setting: unknown): boolean {
  if (setting === 'off') return false;
  return providerId === 'transformers';
}

/** Always sent with full schema: together they cover the plurality of questions (167 tokens). */
export const CORE_TOOLS: readonly string[] = ['transaction_search', 'spending_summary'];

/**
 * Defaults frozen on the dev set (never the held-out set). `kMin` ranked picks
 * are made regardless of the floor; `kMax` caps them; `toolBudget` caps the
 * schema tokens of the whole selected set (core, named and sticky tools are
 * always in, even past it; the keyword fallback is not packed). `skillCut` separated workflow requests (≥ 0.39)
 * from plain spending questions (≤ 0.28) in the doc's sample.
 */
export const SELECTION_DEFAULTS = {
  kMin: 3,
  kMax: 8,
  floor: 0.2,
  toolBudget: 1500,
  skillCut: 0.35,
  maxSkills: 3,
  keywordBoost: 0.15,
  stickyBoost: 0.1,
  prevWeight: 0.8,
};

export type SelectionOptions = typeof SELECTION_DEFAULTS;

/**
 * Keyword groups: a booster on top of the embeddings, and the whole selector
 * when no embedder is available. They scored 98% on the queries they were
 * written against and 60% on fresh phrasing (§2.3) — never a gate.
 */
export const KEYWORD_GROUPS: ReadonlyArray<readonly [RegExp, readonly string[]]> = [
  [/\b(import|load|csv|file|statement|sync|bank|plaid|coinbase|crypto|monarch|firefly|balances? from)\b/i, ['csv_import', 'monarch_import', 'firefly_import', 'plaid_sync', 'plaid_balances', 'plaid_recurring', 'coinbase_sync']],
  [/\b(categor\w*|label\w*|rules?|always|tag|sort)\b/i, ['categorize', 'category_manage', 'rule_manage', 'edit_transaction']],
  [/\b(change|edit|delete|remove|fix|link|update|rename|move|duplicate|transfer)\b/i, ['edit_transaction', 'delete_transaction', 'link_transactions']],
  [/\b(budgets?|goals?|save|saving|savings|alerts?|over)\b/i, ['budget_set', 'budget_check', 'goal_manage', 'alert_check', 'savings_rate']],
  [/\b(profit|p&l|reports?|export|spreadsheet|xlsx|pdf|income|made|make|earn|lower|higher|why)\b/i, ['profit_loss', 'profit_diff', 'generate_report', 'export_transactions']],
  [/\b(net worth|accounts?|balances?|mortgage|loan|assets?|debts?|brokerage|checking)\b/i, ['net_worth', 'account_manage', 'balance_update', 'mortgage_manage', 'link_transactions']],
  [/\b(tax\w*|deduct\w*|schedule c|write.?off|business|llc|entit\w*|1099|personal)\b/i, ['tax_flag', 'entity_manage', 'entity_classify']],
  [/\b(remember|forget|memor\w*|note)\b/i, ['memory_manage']],
  [/\b(weird|unusual|suspicious|double|duplicate|subscriptions?|recurring|anomal\w*)\b/i, ['anomaly_detect', 'plaid_recurring']],
  [/\b(irs|current .* rate|news|law|look up|search the web)\b/i, ['web_search']],
  [/\b(audit|summary|workflow|prep|plan|runway|zero.based|year.end|help me)\b/i, ['skill', 'chain_full_audit', 'chain_year_end_summary', 'chain_import_and_categorize']],
];

/** Tools that usually come next: the "search → act" two-step small models can actually do. */
export const TOOL_AFFINITY: Readonly<Record<string, readonly string[]>> = {
  transaction_search: ['edit_transaction', 'delete_transaction'],
  csv_import: ['categorize'],
  plaid_sync: ['categorize'],
  coinbase_sync: ['categorize'],
  anomaly_detect: ['delete_transaction'],
  tax_flag: ['export_transactions'],
  profit_loss: ['profit_diff'],
};

export interface ToolCandidate {
  name: string;
  /** Embedded text (tool-cards.ts toolCardText). */
  card: string;
  /** Prompt tokens of the tool's compact schema. */
  schemaTokens: number;
}

export interface SkillCandidate {
  name: string;
  card: string;
}

export interface SelectToolsInput {
  query: string;
  /** The previous user message, used when the current one is short or anaphoric. */
  prevQuery?: string | null;
  /** The full registry, in registry order. */
  tools: ToolCandidate[];
  skills?: SkillCandidate[];
  /** Tools used in the last completed turns. */
  stickyTools?: readonly string[];
  /** Null (or a throw) falls back to core + keyword groups + sticky (R3). */
  embed?: EmbedFn | null;
  options?: Partial<SelectionOptions>;
}

export interface ToolSelection {
  /** Selected tool names (full schema), in priority order: core, named, sticky, skill, ranked, grown. */
  tools: string[];
  /** Every other registered tool, by name only, in registry order. */
  indexed: string[];
  /** Skills shown with their description. */
  skills: string[];
  /** Why each selected tool or skill is in. */
  reasons: Record<string, string>;
  tokens: { tools: number };
  /** True when the embedder was unavailable and keyword groups were used. */
  fallback: boolean;
}

const ANAPHORA = /\b(that|it|those|same|again|too|instead|also)\b/i;
const SHORT_MESSAGE_WORDS = 8;

/**
 * What selection embeds: the current message, plus the previous user message
 * when the current one is short (≤ 8 words) or anaphoric — "do the same for
 * August" must inherit the last turn's tools.
 */
export function selectionTexts(query: string, prevQuery?: string | null): { current: string; previous: string | null } {
  const current = query.trim();
  const words = current.split(/\s+/).filter(Boolean).length;
  const usePrev = !!prevQuery?.trim() && (words <= SHORT_MESSAGE_WORDS || ANAPHORA.test(current));
  return { current, previous: usePrev ? prevQuery!.trim() : null };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Whether `text` names `name` (`csv_import`, or with spaces/hyphens as words: "csv import"). */
function mentions(text: string, name: string): boolean {
  const spaced = name.replace(/[_-]+/g, ' ');
  const re = new RegExp(`(^|[^\\w-])(${escapeRegExp(name)}|${escapeRegExp(spaced)})(?![\\w-])`, 'i');
  return re.test(text);
}

/** Registered tool names that appear as whole words in `text` (skill instructions), in order of `names`. */
export function toolsNamedIn(text: string, names: readonly string[]): string[] {
  return names.filter((name) => new RegExp(`(^|[^\\w])${escapeRegExp(name)}(?!\\w)`).test(text));
}

function keywordTools(text: string): Set<string> {
  const out = new Set<string>();
  for (const [re, tools] of KEYWORD_GROUPS) if (re.test(text)) tools.forEach((t) => out.add(t));
  return out;
}

function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/** Build the selection result from an ordered selected list. */
function finish(
  selected: string[],
  reasons: Record<string, string>,
  skills: string[],
  tools: ToolCandidate[],
  fallback: boolean,
): ToolSelection {
  const cost = new Map(tools.map((t) => [t.name, t.schemaTokens]));
  const chosen = new Set(selected);
  return {
    tools: selected,
    indexed: tools.filter((t) => !chosen.has(t.name)).map((t) => t.name),
    skills,
    reasons,
    tokens: { tools: selected.reduce((n, t) => n + (cost.get(t) ?? 0), 0) },
    fallback,
  };
}

/** Select the tools (and skills) whose full schema a local model sees for this request. */
export async function selectTools(input: SelectToolsInput): Promise<ToolSelection> {
  const opts = { ...SELECTION_DEFAULTS, ...input.options };
  const { tools } = input;
  const skills = input.skills ?? [];
  const registered = new Set(tools.map((t) => t.name));
  const cost = new Map(tools.map((t) => [t.name, t.schemaTokens]));
  const { current, previous } = selectionTexts(input.query, input.prevQuery);
  const mentionText = previous ? `${current}\n${previous}` : current;

  const selected: string[] = [];
  const reasons: Record<string, string> = {};
  let used = 0;
  const add = (name: string, reason: string) => {
    if (!registered.has(name) || reasons[name] !== undefined) return;
    selected.push(name);
    reasons[name] = reason;
    used += cost.get(name) ?? 0;
  };

  for (const name of CORE_TOOLS) add(name, 'core');
  for (const t of tools) if (mentions(current, t.name)) add(t.name, 'named');
  const sticky = new Set(input.stickyTools ?? []);
  for (const t of tools) if (sticky.has(t.name)) add(t.name, 'used recently');

  const namedSkills = skills.filter((s) => mentions(current, s.name)).map((s) => s.name);
  const boosted = keywordTools(mentionText);

  // Embeddings. Any failure (no model offline, corrupt cache) degrades to the
  // keyword groups, never to an error (R3).
  let toolScores: number[] | null = null;
  let skillScores: number[] | null = null;
  if (input.embed) {
    try {
      const cards = await input.embed([...tools.map((t) => t.card), ...skills.map((s) => s.card)]);
      const [cur, prev] = await input.embed(previous ? [current, previous] : [current]);
      const score = (card: Float32Array) =>
        prev ? Math.max(dot(cur, card), opts.prevWeight * dot(prev, card)) : dot(cur, card);
      toolScores = tools.map((_, i) => score(cards[i]));
      skillScores = skills.map((_, i) => score(cards[tools.length + i]));
    } catch {
      toolScores = null;
      skillScores = null;
    }
  }

  // Skills: named ones, then the best few that clear the cut.
  const pickedSkills = [...namedSkills];
  if (skillScores) {
    skills
      .map((s, i) => ({ name: s.name, score: skillScores![i] }))
      .filter((s) => s.score >= opts.skillCut && !pickedSkills.includes(s.name))
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
      .slice(0, Math.max(0, opts.maxSkills - pickedSkills.length))
      .forEach((s) => pickedSkills.push(s.name));
  }
  for (const s of pickedSkills) reasons[s] = namedSkills.includes(s) ? 'named' : 'embedding';
  if (pickedSkills.length > 0) add('skill', 'skill selected');

  if (!toolScores) {
    // Every matched group, unpacked: the rules are the only signal left, and
    // the prompt planner still trims unused tools if the call runs over budget.
    for (const t of tools) if (boosted.has(t.name)) add(t.name, 'keyword');
    return finish(selected, reasons, pickedSkills, tools, true);
  }

  const ranked = tools
    .map((t, i) => {
      const kw = boosted.has(t.name);
      return { t, kw, sim: toolScores![i], score: toolScores![i] + (kw ? opts.keywordBoost : 0) + (sticky.has(t.name) ? opts.stickyBoost : 0) };
    })
    .filter((r) => reasons[r.t.name] === undefined)
    .sort((a, b) => b.score - a.score || a.t.name.localeCompare(b.t.name));

  let picks = 0;
  for (const r of ranked) {
    if (picks >= opts.kMax) break;
    if (r.score < opts.floor && picks >= opts.kMin) break;
    if (used + r.t.schemaTokens > opts.toolBudget) continue;
    add(r.t.name, `${r.kw ? 'keyword, ' : ''}embedding ${r.sim.toFixed(2)}`);
    picks++;
  }

  return finish(selected, reasons, pickedSkills, tools, false);
}

/**
 * The `k` tools whose cards best match `text` (skill instructions: only a few
 * SKILL.md files name their tools), skipping `exclude`. [] when embedding fails.
 */
export async function rankToolsForText(
  text: string,
  tools: ToolCandidate[],
  embed: EmbedFn,
  k: number,
  exclude: ReadonlySet<string> = new Set(),
): Promise<string[]> {
  try {
    const cards = await embed(tools.map((t) => t.card));
    const [q] = await embed([text]);
    return tools
      .map((t, i) => ({ name: t.name, score: dot(q, cards[i]) }))
      .filter((r) => !exclude.has(r.name))
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
      .slice(0, k)
      .map((r) => r.name);
  } catch {
    return [];
  }
}

/**
 * Grow a run's selection (R5: monotonic — nothing is ever removed). Tools the
 * model called always join; their affinities and skill-referenced tools join
 * while the selected set stays within the tool budget.
 */
export function growSelection(
  selection: ToolSelection,
  add: { called?: readonly string[]; skillTools?: readonly string[] },
  tools: ToolCandidate[],
  options: Partial<Pick<SelectionOptions, 'toolBudget'>> = {},
): { selection: ToolSelection; added: string[] } {
  const toolBudget = options.toolBudget ?? SELECTION_DEFAULTS.toolBudget;
  const registered = new Set(tools.map((t) => t.name));
  const cost = new Map(tools.map((t) => [t.name, t.schemaTokens]));
  const selected = [...selection.tools];
  const reasons = { ...selection.reasons };
  const added: string[] = [];
  let used = selection.tokens.tools;
  const join = (name: string, reason: string, budgeted: boolean) => {
    if (!registered.has(name) || selected.includes(name)) return;
    if (budgeted && used + (cost.get(name) ?? 0) > toolBudget) return;
    selected.push(name);
    reasons[name] = reason;
    used += cost.get(name) ?? 0;
    added.push(name);
  };

  const called = add.called ?? [];
  for (const name of called) join(name, 'called', false);
  for (const name of called) for (const next of TOOL_AFFINITY[name] ?? []) join(next, `after ${name}`, true);
  for (const name of add.skillTools ?? []) join(name, 'skill', true);

  if (added.length === 0) return { selection, added };
  return { selection: finish(selected, reasons, selection.skills, tools, selection.fallback), added };
}
