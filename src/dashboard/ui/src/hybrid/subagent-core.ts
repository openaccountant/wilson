/**
 * Browser subagent core: a pure, bounded state machine that answers read-only
 * finance questions from the on-device mirror, or hands the turn to the server
 * agent (specs/browser-subagent.md sections 5, 6 and 8).
 *
 *   GATE -> PRECHECK -> ROUTE -> FILL_ARGS -> EXECUTE -> COMPOSE -> VERIFY
 *
 * PRECISION-FIRST (specs/DECISIONS.md "Round 2"): a read is answered locally only
 * when the keyword router has EXACTLY ONE match. Zero or several matches hand off
 * to the server. The on-device model never chooses a tool (no router tiebreak, no
 * next-action step): it only composes an answer from the tool result.
 *
 * Everything here is pure TypeScript with injected dependencies (`generate`,
 * `toolRead`, `status`, a clock and an abort signal), so it runs unchanged in
 * the model worker and under bun:test with fakes. Hard guarantees:
 *
 *  - `runSubagent` ALWAYS resolves to a SubagentOutcome and never rejects: a
 *    throwing or hanging dependency becomes a handoff (`error` / `deadline`),
 *    an abort becomes `cancelled`. This is the hybrid contract: every local
 *    failure is a silent server fallback.
 *  - The gate is two-sided [C4]: a question routes to a read tool only if it is
 *    READ-SHAPED and contains no mutation verb. A false gate costs a server
 *    round trip; a missed gate answers a change request with a confident read.
 *  - Mutations are never executed here (the worker has no write path at all);
 *    they become a `proposal` hint for the server agent.
 *  - Tool arguments are never written by the model (subagent-args.ts).
 *  - A composed answer is accepted only if every figure in it is grounded in the
 *    tool results (`isGrounded`), and it never contains a link, image or HTML [C10].
 */

import type { MirrorPortStatus } from '../store/mirror-port-protocol.js';
import type { ReadToolName, ToolReadResult } from '../store/mirror-tools.js';
import {
  HANDOFF_CAPS,
  type HandoffAgentReadToolName,
  type HandoffProposalToolName,
  type LocalHandoffV1,
} from '../../../../dashboard/local-handoff-format.js';
import {
  CURRENT_MESSAGE_MARKER,
  NO_THINK_SWITCH,
  buildLocalUserMessage,
  classifyLocalOutput,
  stripThinking,
} from './core.js';
import { fillArgs } from './subagent-args.js';
import { isEmptyResult } from './subagent-empty.js';
import { detectComparisonIntent } from './subagent-intent.js';
import { renderTemplate } from './subagent-templates.js';
import { OPEN_JEV_ROUTE_CUT, decideRoute, type RouteHandoffWhy } from './openjev-route.js';
import {
  SUBAGENT_MAX_STEPS_HARD,
  DEFAULT_SUBAGENT_LIMITS,
  isRouteHint,
  type PriorLocalTurn,
  type RouteHint,
  type StepEvent,
  type SubagentHandoffReason,
  type SubagentLimits,
  type SubagentOutcome,
  type ToolStepRecord,
} from './worker-protocol.js';

// ── Constants ────────────────────────────────────────────────────────────────

/** The five READ tools, in catalog order (kept local so this module imports no mirror runtime code). */
export const READ_TOOLS: readonly ReadToolName[] = ['transaction_search', 'spending_summary', 'profit_loss', 'net_worth', 'forecast'];

/** Agent-registry names the subagent may propose (spec C1). Asserted against src/tools/registry.ts by a test. */
export const PROPOSAL_TOOLS = ['edit_transaction', 'delete_transaction', 'tax_flag', 'categorize'] as const;

/** A mirror older than this must be re-synced by the main thread before a run (spec C8). */
export const MIRROR_MAX_AGE_MS = 120_000;

/**
 * Compose prompt budget (system + user). Slice 1 measured prefill at about
 * 1 ms per char and a hard WebGPU failure near 6,000 chars, so the subagent
 * stays well under 3,000.
 */
export const COMPOSE_PROMPT_BUDGET = 3_000;

const MIN_SUMMARY_PROMPT_CHARS = 200;

// ── GATE ─────────────────────────────────────────────────────────────────────

export interface Proposal {
  tool: HandoffProposalToolName | 'other';
  userWords: string;
}

export type GateVerdict =
  | { kind: 'route' }
  | { kind: 'mutation-intent'; proposal: Proposal }
  | { kind: 'non-data' };

/** Verbs that ask for a change. Deliberately excludes cancel/make/etc. that gold READ questions use. */
const MUTATION_VERB = new RegExp(
  '\\b(?:re-?categori[sz]e|categori[sz]e|change|edit|update|delete|remove|rename|split|merge|un-?flag|flag|mark|tag|import|upload|undo|add|create|set|' +
    'move|assign|reassign|reclassify|put|fix|exclude|hide|unhide|approve|reject|link|unlink|overwrite|get rid of)\\b',
  'i'
);

/** Imperatives that are requests for an action even when we have no tool for them. */
const ACTION_HINT = /\b(?:cancel|stop|pause|close|unsubscribe|sign up|submit|schedule|send|transfer|pay)\b/i;

/** Polite lead-ins that do not change what the question is. */
const LEAD_IN = /^(?:(?:please|pls|hey|hi|hello|ok|okay|so|and|also|now|wilson)[,!.]?\s+)+/i;

/**
 * Read-shaped openings: wh-words, auxiliaries ("did I ..."), request verbs
 * ("show", "list", ...), estimate/forecast verbs, and a few noun-phrase
 * report names ("income vs expenses", "P&L"). The allowlist side of the gate.
 */
const READ_START = new RegExp(
  '^(?:' +
    [
      "what(?:'s|s)?", 'how', 'when', 'where', 'which', 'who', 'why',
      'did', 'do (?:i|we|my|our)', 'does (?:my|the|this|it|any)', 'am', 'is', 'are', 'was', 'were', 'have', 'has',
      'show', 'list', 'find', 'search', 'give me', 'tell me', 'pull up', 'compare', 'break down', 'summari[sz]e',
      'estimate', 'project', 'forecast', 'predict',
      '(?:can|could) you (?:show|tell|list|find|give|pull)',
      'will (?:i|my|we|our|the|this|it|there)', 'would (?:i|my|we|it|the)', 'if (?:i|we|my)',
      // Round 3: more read openings that are never a change request on their own.
      'can (?:i|we) afford', 'look ?up', 'any(?:thing)?', 'every(?:thing)?', 'all (?:my|our|the)', 'based on', 'if (?:things|this|that|spending|current)',
      'income (?:vs|versus|minus|and expenses)', 'profit', 'p&l', 'net worth', 'balance sheet', 'spending', 'expenses', 'total',
    ].join('|') +
    ')\\b',
  'i'
);

/** Questions that are about the world or the assistant, not the user's data. */
const NON_DATA = [
  /^(?:hi|hello|hey|thanks|thank you|good (?:morning|afternoon|evening|night)|lol|lmao|nice|cool|great|yo|sup)\b/i,
  /\bwhat can you do\b/i,
  /\bexplain\b/i,
  /\bwhat(?:'s| is) an? \b/i,
  /\bhelp me (?:write|draft)\b/i,
  /\b(?:write|draft) an? (?:email|letter|note)\b/i,
];

/**
 * Round 3 terse path. A short noun-phrase question ("hulu charges?", "q3 spending", "networth") has no
 * wh-word or request verb, so READ_START rejects it. It is read-shaped when it names something to look
 * up (READ_VOCAB) and shows no sign of a statement or instruction (CHANGE_CUE). Both are tested only
 * AFTER the hard checks (mutation verb, action hint, non-data), so they can only ADD routes.
 */
const READ_VOCAB = new RegExp(
  '\\b(?:' +
    [
      'charges?', 'payments?', 'pmts?', 'purchases?', 'transactions?', 'txns?', 'orders?', 'trips?', 'visits?', 'rides?',
      'deposits?', 'paychecks?', 'fees?', 'transfers?', 'premiums?', 'copays?', 'tickets?', 'bills?',
      'spend(?:ing)?', 'spent', 'expenses?', 'outgoings?', 'outflows?', 'income', 'earn(?:ed|ings?)', 'revenues?',
      'profits?', 'loss(?:es)?', 'p&l', 'pnl', 'cash(?: ?flow)?', 'savings?', 'balances?',
      'net ?worth', 'nw', 'assets?', 'liabilit(?:y|ies)', 'debts?',
      'for(?:e|)cast(?:s|ed)?', 'projections?', 'projected', 'estimates?', 'scenarios?',
      'categor(?:y|ies)', 'cats?', 'breakdown', 'totals?', 'bucks',
    ].join('|') +
    ')\\b',
  'i'
);

/** Declarative or imperative wording that describes a change, not a lookup (terse path only). */
const CHANGE_CUE = new RegExp(
  '\\b(?:should|shouldn\'?t|ought|needs?|needed|belongs?|supposed|actually|instead|wrong|incorrect|mistake|going forward|from now on|' +
    'count(?:s|ed)? as|go away|toss|drop|dupe|duplicates?|rid|make|made|turn|use|file(?:d)?|want|wants|wanna|' +
    'goes? (?:to|under|in)|as|into|is|was|were|are|be|been|not|isn\'?t|wasn\'?t|it\'?s|that\'?s)\\b',
  'i'
);

/**
 * Round 4. Read openers that are NOT a wh-word or request verb (quantifiers and noun-phrase report
 * names). Unlike "show" or "what", they start a statement as easily as a question ("All my Starbucks
 * should be Dining"), so READ_START alone must not route them: CHANGE_CUE is checked as well. Round 3
 * added these openers without the check, which let verb-less recategorizations reach the read tools.
 */
const GUARDED_OPENER = /^(?:any(?:thing)?|every(?:thing)?|all (?:my|our|the)|spending|expenses|total)\b/i;

/**
 * Round 4 follow-up. The openers that are a question word, an auxiliary or an imperative read verb
 * ("what", "did I", "show", "compare", "will", ...). A sentence that starts this way is a question or a
 * request to look something up, so change wording later in it ("what should I cut") does not make it a
 * change request. EVERY other READ_START opener (report names such as profit, p&l, net worth, balance
 * sheet, income vs, spending; forecast verbs; "based on"; "if i/we/my/things/..."; quantifiers) can start
 * a statement as easily as a question, so it is checked for change wording.
 */
const QUESTION_OPENER = new RegExp(
  '^(?:' +
    [
      "what(?:'s|s)?", 'how', 'when', 'where', 'which', 'who', 'why',
      'did', 'do (?:i|we|my|our)', 'does (?:my|the|this|it|any)', 'am', 'is', 'are', 'was', 'were', 'have', 'has',
      'show', 'list', 'find', 'search', 'give me', 'tell me', 'pull up', 'compare', 'break down', 'summari[sz]e',
      '(?:can|could) you (?:show|tell|list|find|give|pull)',
      'will (?:i|my|we|our|the|this|it|there)', 'would (?:i|my|we|it|the)', 'can (?:i|we) afford', 'look ?up',
    ].join('|') +
    ')\\b',
  'i'
);

/**
 * CHANGE_CUE without the copulas and prepositions ("is", "was", "be", "as", "into", "not", ...). Those
 * words are ordinary in a read ("if spending stays flat what is my savings in December", "net worth as
 * of June"), so on the non-quantifier openers only wording that actually asks for a change counts.
 */
const STRONG_CHANGE_CUE = new RegExp(
  '\\b(?:should|shouldn\'?t|ought|needs?|needed|belongs?|supposed|actually|instead|wrong|incorrect|mistake|going forward|from now on|' +
    'count(?:s|ed)? as|go away|toss|drop|dupe|duplicates?|rid|make|made|turn|use|file(?:d)?|want|wants|wanna|' +
    'leave out|leave off|goes? (?:to|under|in))\\b',
  'i'
);

/** True when a READ_START opener is really the start of a change request, so it must not route. */
function readOpenerIsChange(body: string): boolean {
  if (GUARDED_OPENER.test(body)) return CHANGE_CUE.test(body);
  if (QUESTION_OPENER.test(body)) return false;
  return STRONG_CHANGE_CUE.test(body);
}

/** Longest bare phrase (words) accepted with no vocabulary hit, e.g. a lone merchant name. */
const BARE_MAX_WORDS = 3;
/** Longest vocabulary-bearing phrase (words) accepted on the terse path. */
const TERSE_MAX_WORDS = 14;

function isTerseRead(body: string): boolean {
  if (CHANGE_CUE.test(body)) return false;
  const words = body.split(/\s+/).filter(Boolean).length;
  if (READ_VOCAB.test(body)) return words <= TERSE_MAX_WORDS;
  return words <= BARE_MAX_WORDS && /[\p{L}\p{N}]/u.test(body) && /^[\p{L}\p{N}&*'.\-\s?!$]+$/u.test(body);
}

/**
 * Two-sided gate [C4]. PURE and total: a function of the question text only
 * (no model, config or mirror call), so the client can run it on the main
 * thread before it downloads or loads anything.
 *
 *  1. empty                         -> non-data
 *  2. contains a mutation verb      -> mutation-intent (+ proposal hint)
 *  3. not read-shaped (allowlist)   -> mutation-intent when it asks for an
 *                                      action, else non-data
 *  4. matches a non-data pattern    -> non-data
 *  5. otherwise                     -> route
 *
 * Round 3: step 3 also accepts the terse path (isTerseRead) so "hulu charges?" or "q3 spending" qualify.
 */
export function gateQuestion(question: string): GateVerdict {
  const q = String(question ?? '').trim();
  if (!q) return { kind: 'non-data' };
  if (MUTATION_VERB.test(q)) return { kind: 'mutation-intent', proposal: proposeMutation(q) };
  const body = q.replace(LEAD_IN, '');
  if (READ_START.test(body) && !readOpenerIsChange(body)) return NON_DATA.some((re) => re.test(body)) ? { kind: 'non-data' } : { kind: 'route' };
  if (ACTION_HINT.test(q)) return { kind: 'mutation-intent', proposal: proposeMutation(q) };
  if (NON_DATA.some((re) => re.test(q) || re.test(body))) return { kind: 'non-data' };
  return isTerseRead(body) ? { kind: 'route' } : { kind: 'non-data' };
}

/**
 * What the server agent should consider doing, in AGENT tool names [C1].
 * Order matters: unrelated requests ('other') first, then bulk categorize,
 * tax flagging, deletion, and finally single-row edits.
 */
export function proposeMutation(question: string): Proposal {
  const q = String(question ?? '');
  const userWords = q.slice(0, HANDOFF_CAPS.userWordsChars);
  const lower = q.toLowerCase();
  let tool: Proposal['tool'] = 'other';
  if (/\b(?:import|upload|budget|goal|rule|account|entity|categories|statement)\b/.test(lower)) {
    tool = 'other';
  } else if (/\b(?:uncategori[sz]ed|auto-?categori[sz]e|categori[sz]e (?:all|everything|my))\b/.test(lower)) {
    tool = 'categorize';
  } else if (/\b(?:flag|unflag|un-flag|deductible|write-?off)\b/.test(lower)) {
    tool = 'tax_flag';
  } else if (/\b(?:delete|remove|get rid of)\b/.test(lower)) {
    tool = 'delete_transaction';
  } else if (/\b(?:re-?categori[sz]e|categori[sz]e|move|assign|reassign|reclassify|put|fix|edit|change|update|rename|set|mark|tag|correct)\b/.test(lower)) {
    tool = 'edit_transaction';
  }
  return { tool, userWords };
}

// ── ROUTER ───────────────────────────────────────────────────────────────────

/**
 * Keyword rules per tool. Written against the spike gold set with the set
 * visible, so their hit rates are optimistic; the held-out evaluation (slice 8)
 * is the real measure. Round 2: rules are NOT to be tuned against any held-out
 * file; a single hit is the only way to a local answer (see keywordRoute).
 */
const ROUTE_RULES: Record<ReadToolName, RegExp> = {
  net_worth: /\bnet worth\b|\bbalance sheet\b|\bassets\b.*\b(liabilities|debts)\b|\bworth more\b/i,
  forecast: /\bforecast\b|\bproject(ion)?\b|\bwhat if\b|\bif i (cancel|cut|drop|stop)\b|\bwill (i|my)\b|\bin (\w+) months\b|\bat my current pace\b|\bif i keep\b/i,
  profit_loss: /\bprofit\b|\bp&l\b|\bincome (vs\.?|versus|minus) expenses?\b|\bmake versus spend\b|\bcome out ahead\b/i,
  spending_summary: /\bby category\b|\bper category\b|\bcategor(y|ies)\b|\bwhere did my money go\b|\bspending\b/i,
  transaction_search: /\b(show|find|list|search|pull up)\b|\bwhen did i\b|\bcharged\b|\btransactions?\b|\bpayments?\b|\btotal to\b/i,
};

/**
 * Every tool whose keyword rule matches, in catalog order. PRECISION-FIRST: exactly one
 * match = answer locally with that tool; zero or several = hand off to the server. The
 * on-device model never breaks a tie or fills a gap.
 */
export function keywordRoute(question: string): ReadToolName[] {
  const q = String(question ?? '');
  return READ_TOOLS.filter((tool) => ROUTE_RULES[tool].test(q));
}

export interface PromptPair {
  system: string;
  user: string;
}

// ── Step records and summaries ───────────────────────────────────────────────

/** A finished tool step inside the worker: the record the UI sees plus the data used for grounding. */
export interface ExecutedStep {
  tool: ReadToolName;
  args: Record<string, unknown>;
  ok: boolean;
  ms: number;
  rows?: number;
  summary: string;
  /** Row data: stays in the worker, never crosses postMessage. */
  data?: unknown;
}

function money(amount: number): string {
  return amount < 0 ? `-$${Math.abs(amount).toFixed(2)}` : `+$${amount.toFixed(2)}`;
}

function capText(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

/** Strip C0/C1 control characters (keeps \n and \t). */
function stripControl(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '');
}

/** Make untrusted text unable to forge the framing markers ("[Current message ...]") in a prompt. */
function neutralise(text: string): string {
  return stripControl(String(text ?? '')).replace(/\[/g, '(').replace(/\]/g, ')');
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

interface SearchRowLike {
  id?: unknown;
  date?: unknown;
  description?: unknown;
  amount?: unknown;
  category?: unknown;
}

/**
 * The text a step contributes to the compose prompt and to the handoff
 * (spec 8.3). For transaction_search it is RE-PROJECTED from the rows: at most
 * 25 rows, only id / date / description (<= 80) / amount / category, so notes,
 * account digits and external ids can never leave via a summary even if the
 * mirror's own summary were richer. Other tools use the mirror's summary.
 * Always <= 1,200 chars.
 */
export function projectStepSummary(step: ExecutedStep): string {
  const cap = HANDOFF_CAPS.summaryChars;
  const data = step.data;
  if (step.tool === 'transaction_search' && isRecord(data) && Array.isArray(data.transactions) && typeof data.count === 'number') {
    const count = data.count;
    if (count === 0) return 'No transactions found matching your query.';
    const rows = (data.transactions as SearchRowLike[]).filter(isRecord) as SearchRowLike[];
    const head = `Found ${count} transaction${count === 1 ? '' : 's'}.`;
    const total = rows.reduce((sum, r) => sum + (typeof r.amount === 'number' ? r.amount : 0), 0);
    const tail = (omitted: number) => `(+${omitted} more) Total of listed rows: ${money(total)}`;
    const lines: string[] = [];
    let used = head.length + 1;
    for (const r of rows.slice(0, HANDOFF_CAPS.searchRows)) {
      const desc = stripControl(String(r.description ?? ''));
      const shown = desc.length > HANDOFF_CAPS.searchDescriptionChars ? `${desc.slice(0, HANDOFF_CAPS.searchDescriptionChars - 1)}…` : desc;
      const amount = typeof r.amount === 'number' ? money(r.amount) : '?';
      const category = typeof r.category === 'string' && r.category ? r.category : 'Uncategorized';
      const line = `#${String(r.id ?? '?')} ${String(r.date ?? '?')} ${amount} ${category} ${shown}`;
      if (used + line.length + 1 + tail(count).length + 1 > cap) break;
      lines.push(line);
      used += line.length + 1;
    }
    const omitted = count - lines.length;
    return capText([head, ...lines, ...(omitted > 0 ? [tail(omitted)] : [])].join('\n'), cap);
  }
  return capText(stripControl(String(step.summary ?? '')), cap);
}

function toRecord(step: ExecutedStep): ToolStepRecord {
  const rec: ToolStepRecord = { tool: step.tool, args: step.args, ok: step.ok, ms: step.ms, summary: projectStepSummary(step) };
  if (step.rows !== undefined) rec.rows = step.rows;
  return rec;
}

// ── Prompts ──────────────────────────────────────────────────────────────────

const LOOKUP_START = '[On-device lookup results]';
const LOOKUP_END = '[End of lookup results]';

export const COMPOSE_SYSTEM_TEMPLATE = `You are Open Accountant's local browser assistant. Today is {date}.
The user's message contains results of lookups on their own transaction data. They are your only data source.

Rules:
- Answer ONLY from those results. Use the exact amounts shown. Never invent, estimate, or extrapolate figures.
- Never write links, images, HTML or markdown links.
- Do not attempt tool calls; you have no tools.
- If the results do not answer the question, reply with exactly NEED_MORE_DATA and nothing else.
- Keep answers short. Use $ amounts.`;

function frameResults(steps: ExecutedStep[], perSummaryChars: number): string {
  const blocks = steps.map((s) => `### ${s.tool} ${neutralise(JSON.stringify(s.args))}\n${capText(neutralise(projectStepSummary(s)), perSummaryChars)}`);
  return [LOOKUP_START, ...blocks, LOOKUP_END, CURRENT_MESSAGE_MARKER].join('\n');
}

/** Compose prompt: framed tool summaries trimmed so system + user stays within the budget. */
export function buildComposePrompt(question: string, steps: ExecutedStep[], today: string, budget: number = COMPOSE_PROMPT_BUDGET): PromptPair {
  const system = COMPOSE_SYSTEM_TEMPLATE.replace('{date}', today);
  const q = neutralise(question);
  const fixed = system.length + q.length + 160 + steps.length * 80;
  const per = Math.max(MIN_SUMMARY_PROMPT_CHARS, Math.min(HANDOFF_CAPS.summaryChars, Math.floor((budget - fixed) / Math.max(1, steps.length))));
  return { system, user: buildLocalUserMessage(frameResults(steps, per), q) };
}

// ── VERIFY: grounding ────────────────────────────────────────────────────────

export interface GroundingStep {
  tool: string;
  data: unknown;
  /** The summary text the composer was shown; its figures count as grounded too. */
  summary?: string;
}

interface NumberToken {
  value: number;
  decimals: number;
  kind: 'money' | 'percent';
}

const NUMBER_RE = /(?<![A-Za-z0-9.#])-?(\$?)(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?(%?)(?![A-Za-z0-9])/g;

function isYearLike(n: number): boolean {
  return Number.isInteger(n) && n >= 1900 && n <= 2100;
}

/** Money amounts and percentages in an answer. Counts, days, years and #ids are not figures. */
function figuresIn(text: string): NumberToken[] {
  const out: NumberToken[] = [];
  for (const m of text.matchAll(NUMBER_RE)) {
    const dollar = m[1] === '$';
    const intPart = m[2].replace(/,/g, '');
    const frac = m[3] ?? '';
    const pct = m[4] === '%';
    const value = parseFloat(intPart + frac);
    if (!Number.isFinite(value)) continue;
    const decimals = frac ? frac.length - 1 : 0;
    if (pct) out.push({ value, decimals, kind: 'percent' });
    else if (dollar || frac || (value >= 1000 && !isYearLike(value))) out.push({ value, decimals, kind: 'money' });
  }
  return out;
}

const MAX_SCAN_LEAVES = 5_000;
const MAX_SCAN_DEPTH = 8;
const DERIVE_POOL = 60;

/** Collect every number in `data`: numeric leaves and numbers inside string leaves, as absolute values. */
function collectNumbers(data: unknown, into: number[], seen: WeakSet<object>, budget: { left: number }, depth = 0, key = ''): void {
  if (budget.left <= 0 || depth > MAX_SCAN_DEPTH) return;
  if (typeof data === 'number') {
    budget.left--;
    if (Number.isFinite(data) && key !== 'id') into.push(Math.abs(data));
    return;
  }
  if (typeof data === 'string') {
    budget.left--;
    pushTextNumbers(data, into);
    return;
  }
  if (typeof data !== 'object' || data === null) return;
  if (seen.has(data)) return;
  seen.add(data);
  if (Array.isArray(data)) {
    for (const v of data) collectNumbers(v, into, seen, budget, depth + 1, key);
    return;
  }
  for (const [k, v] of Object.entries(data)) collectNumbers(v, into, seen, budget, depth + 1, k);
}

function pushTextNumbers(text: string, into: number[]): void {
  const stripped = text.replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' ');
  for (const m of stripped.matchAll(/(?<![A-Za-z0-9.#])(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?(?![A-Za-z0-9])/g)) {
    const v = parseFloat(m[1].replace(/,/g, '') + (m[2] ?? ''));
    if (Number.isFinite(v) && !(isYearLike(v) && !m[2])) into.push(v);
  }
}

function matchesFigure(v: number, x: number, decimals: number): boolean {
  if (decimals >= 2) return Math.abs(v - x) <= 0.01 + 1e-9;
  const scale = 10 ** decimals;
  const rounded = Math.round((v + 1e-9) * scale) / scale;
  const truncated = Math.trunc((v + 1e-9) * scale) / scale;
  return Math.abs(rounded - x) < 1e-9 || Math.abs(truncated - x) < 1e-9;
}

/** The anti-hallucination rules that apply to any answer, whatever the data. [C10] */
export function hasForbiddenMarkup(answer: string): boolean {
  return (
    /https?:\/\//i.test(answer) ||
    /\bwww\./i.test(answer) ||
    answer.includes('](') ||
    answer.includes('![') ||
    /<[A-Za-z/!]/.test(answer)
  );
}

/**
 * VERIFY (spec 5.2 and C10). True only if:
 *  - the answer has no URL, markdown link/image or raw HTML; and
 *  - every money amount and percentage in it matches a number in the tool data
 *    (numeric leaves and numbers inside string leaves, sign-insensitive, within a
 *    cent; a whole-dollar answer may round or truncate), or a difference / ratio
 *    / percent change derived from two such numbers.
 * Counts, dates, years and #ids are not figures and are not checked. Never throws.
 */
export function isGrounded(answer: string, steps: GroundingStep[]): boolean {
  try {
    const text = String(answer ?? '');
    if (hasForbiddenMarkup(text)) return false;
    const figures = figuresIn(text);
    if (figures.length === 0) return true;

    const pool: number[] = [];
    const seen = new WeakSet<object>();
    const budget = { left: MAX_SCAN_LEAVES };
    for (const s of steps) {
      collectNumbers(s.data, pool, seen, budget);
      if (typeof s.summary === 'string') pushTextNumbers(s.summary, pool);
    }

    let derived: { diffs: number[]; ratios: number[]; changes: number[] } | null = null;
    const derive = () => {
      if (derived) return derived;
      const uniq = [...new Set(pool.map((n) => Math.round(n * 1e6) / 1e6))].slice(0, DERIVE_POOL);
      const diffs: number[] = [];
      const ratios: number[] = [];
      const changes: number[] = [];
      for (let i = 0; i < uniq.length; i++) {
        for (let j = 0; j < uniq.length; j++) {
          if (i === j) continue;
          const a = uniq[i];
          const b = uniq[j];
          if (i < j) diffs.push(Math.abs(a - b));
          if (b !== 0) {
            ratios.push((a / b) * 100);
            changes.push((Math.abs(a - b) / b) * 100);
          }
        }
      }
      derived = { diffs, ratios, changes };
      return derived;
    };

    for (const f of figures) {
      const x = Math.abs(f.value);
      if (pool.some((v) => matchesFigure(v, x, f.decimals))) continue;
      const d = derive();
      const candidates = f.kind === 'money' ? d.diffs : [...d.ratios, ...d.changes];
      if (candidates.some((v) => matchesFigure(v, x, f.decimals))) continue;
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

// ── VERIFY: claims and substance ─────────────────────────────────────────────

export type AnswerClaimProblem = 'negative-claim' | 'no-reference';

/**
 * Claims that something is absent or did not happen ("No results found.",
 * "No, I did not get charged twice", "you haven't..."). Deliberately broad:
 * a wrong "no" is the worst answer a 0.6B composer gives, and a hand-off is
 * cheap. Matched on lowercased text with markdown and curly quotes removed.
 */
const NEGATIVE_CLAIMS: readonly RegExp[] = [
  /^(?:no|nope|nah|negative)\s*(?:[,.!;:]|$)/,
  /\bnot\s+at\s+all\b/,
  /\bno\s+(?:\w+\s+){0,2}?(?:results?|transactions?|charges?|matches|matching|records?|payments?|entries|activity|data|items?|purchases?|duplicates?|expenses?|income|spending|subscriptions?|rides?|bills?|deposits?|trips?|orders?)\b/,
  /\b(?:nothing|none)\b/,
  /\b(?:zero|0)\s+(?:\w+\s+)?(?:transactions?|results?|charges?|matches|records?|payments?)\b/,
  /\b(?:was|were|is|are)(?:\s+not|n't)\s+found\b|\bnot\s+found\b/,
  /\b(?:did|do|does|have|has|had|was|were|is|are|will|would|could|can|should)\s+not\b/,
  /\b\w+n't\b/,
  /\bcannot\b/,
  /\bnever\b/,
];

function normaliseClaimText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[*`~_]+/g, '')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function isNegativeClaim(answer: string): boolean {
  const t = normaliseClaimText(answer);
  return NEGATIVE_CLAIMS.some((re) => re.test(t));
}

function numberOf(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** True when a tool result carries nothing: no rows, or no non-zero number anywhere. */
function stepIsEmpty(step: GroundingStep): boolean {
  const d = step.data;
  if (d === undefined || d === null) return true;
  if (isRecord(d)) {
    if (numberOf(d.count) === 0) return true;
    if (Array.isArray(d.transactions) && d.transactions.length === 0 && numberOf(d.count) === undefined) return true;
  }
  const pool: number[] = [];
  collectNumbers(d, pool, new WeakSet<object>(), { left: MAX_SCAN_LEAVES });
  return pool.every((n) => n === 0);
}

const ENTITY_STOPWORDS = new Set([
  'total', 'totals', 'transaction', 'transactions', 'category', 'categories', 'other', 'uncategorized', 'unknown', 'purchase', 'purchases',
  'payment', 'payments', 'income', 'expense', 'expenses', 'spending', 'month', 'months', 'year', 'years', 'quarter', 'week', 'weeks', 'period',
  'previous', 'current', 'last', 'this', 'next', 'found', 'with', 'from', 'that', 'what', 'your', 'have', 'been', 'were', 'will', 'there', 'their',
  'january', 'february', 'march', 'april', 'june', 'july', 'august', 'september', 'october', 'november', 'december',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'asset', 'assets', 'liability', 'liabilities', 'true', 'false', 'null',
  'default', 'profit', 'loss', 'net', 'worth', 'cash', 'balance',
]);

function wordsOf(text: string): string[] {
  return (text.toLowerCase().match(/[a-z][a-z&'-]{2,}/g) ?? []).map((w) => w.replace(/^'+|'+$/g, '')).filter((w) => w.length >= 4);
}

const stem = (w: string): string => (w.length > 4 && w.endsWith('s') ? w.slice(0, -1) : w);

/** Merchant, category, account and label words from the tool data (string values only, not keys). */
function collectEntities(data: unknown, into: Set<string>, seen: WeakSet<object>, budget: { left: number }, depth = 0, key = ''): void {
  if (budget.left <= 0 || depth > MAX_SCAN_DEPTH) return;
  if (typeof data === 'string') {
    budget.left--;
    if (key === 'formatted' || key === 'summary' || data.length > 80 || /^\d{4}-\d{2}-\d{2}/.test(data)) return;
    for (const w of wordsOf(data)) if (!ENTITY_STOPWORDS.has(w) && !ENTITY_STOPWORDS.has(stem(w))) into.add(stem(w));
    return;
  }
  if (typeof data !== 'object' || data === null || seen.has(data)) return;
  seen.add(data);
  if (Array.isArray(data)) {
    for (const v of data) collectEntities(v, into, seen, budget, depth + 1, key);
    return;
  }
  for (const [k, v] of Object.entries(data)) collectEntities(v, into, seen, budget, depth + 1, k);
}

/** Row counts the answer may legitimately quote ("2 transactions found."). */
function collectCounts(step: GroundingStep, into: Set<number>): void {
  const d = step.data;
  if (!isRecord(d)) return;
  const c = numberOf(d.count);
  if (c !== undefined) into.add(c);
  if (Array.isArray(d.transactions)) into.add(d.transactions.length);
}

function referencesResult(answer: string, steps: GroundingStep[]): boolean {
  if (figuresIn(answer).length > 0) return true; // the figure's value is checked by isGrounded
  const counts = new Set<number>();
  const entities = new Set<string>();
  const seen = new WeakSet<object>();
  const budget = { left: MAX_SCAN_LEAVES };
  for (const s of steps) {
    collectCounts(s, counts);
    collectEntities(s.data, entities, seen, budget);
  }
  const withoutDates = answer.replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' ');
  for (const m of withoutDates.matchAll(/(?<![A-Za-z0-9.#$-])(\d{1,5})(?![A-Za-z0-9.%])/g)) {
    const n = Number(m[1]);
    if (!isYearLike(n) && counts.has(n) && n > 0) return true;
  }
  return wordsOf(answer).some((w) => entities.has(stem(w)));
}

/**
 * VERIFY, second half (slice-8 answer-quality defects). `isGrounded` checks the
 * figures an answer contains; it cannot check an answer that has none. So:
 *  - a negative / "no results" claim is allowed only when every tool result is
 *    actually empty ('negative-claim'); and
 *  - unless the results are empty, the answer must reference them: a figure,
 *    the row count, or a merchant / category / account name from the data
 *    ('no-reference').
 * Returns null when the answer passes. Never throws (a throw reads as a problem).
 */
export function answerClaimProblem(answer: string, steps: GroundingStep[]): AnswerClaimProblem | null {
  try {
    const text = String(answer ?? '');
    const allEmpty = steps.length === 0 || steps.every(stepIsEmpty);
    if (allEmpty) return null;
    if (isNegativeClaim(text)) return 'negative-claim';
    if (!referencesResult(text, steps)) return 'no-reference';
    return null;
  } catch {
    return 'no-reference';
  }
}

// ── Handoff payload ──────────────────────────────────────────────────────────

export interface HandoffBuildInput {
  reason: SubagentHandoffReason;
  steps: ExecutedStep[];
  mirrorSyncedAt: string | null;
  suggestedCall?: { tool: HandoffAgentReadToolName; args: Record<string, unknown> };
  proposal?: Proposal;
  localNote?: string;
  priorLocalTurns?: PriorLocalTurn[];
}

function sizeOf(h: LocalHandoffV1): number {
  return JSON.stringify(h).length;
}

/**
 * Build the bounded `LocalHandoffV1` (spec 8.1 / 8.3). Caps: at most 4 steps,
 * summaries <= 1,200 chars (search rows re-projected), proposal words <= 300,
 * note <= 400 and only for `ungrounded`, <= 3 prior turns (q <= 300, a <= 600,
 * most recent kept), and the whole serialised payload <= 8,000 chars. Over the
 * total cap the drop order is: oldest prior turn, then the note, then summaries
 * (longest first), then whole steps from the end.
 */
export function buildHandoff(input: HandoffBuildInput): LocalHandoffV1 {
  const h: LocalHandoffV1 = {
    v: 1,
    reason: input.reason,
    mirror: { syncedAt: input.mirrorSyncedAt },
    steps: input.steps.slice(0, HANDOFF_CAPS.maxSteps).map((s) => ({
      tool: s.tool,
      args: s.args,
      ok: s.ok,
      summary: projectStepSummary(s),
    })),
  };

  const call = input.suggestedCall;
  if (call && call.tool !== ('forecast' as string) && (READ_TOOLS as readonly string[]).includes(call.tool)) {
    h.suggestedCall = { tool: call.tool, args: call.args };
  }
  if (input.proposal) {
    h.proposal = { tool: input.proposal.tool, userWords: input.proposal.userWords.slice(0, HANDOFF_CAPS.userWordsChars) };
  }
  if (input.reason === 'ungrounded' && input.localNote) {
    h.localNote = input.localNote.slice(0, HANDOFF_CAPS.localNoteChars);
  }
  const turns = (input.priorLocalTurns ?? []).slice(-HANDOFF_CAPS.priorTurns).map((t) => ({
    q: String(t.q ?? '').slice(0, HANDOFF_CAPS.priorQuestionChars),
    a: String(t.a ?? '').slice(0, HANDOFF_CAPS.priorAnswerChars),
  }));
  if (turns.length > 0) h.priorLocalTurns = turns;

  const cap = HANDOFF_CAPS.maxSerializedChars;
  // 1. oldest prior turn first
  while (sizeOf(h) > cap && h.priorLocalTurns && h.priorLocalTurns.length > 0) {
    h.priorLocalTurns.shift();
    if (h.priorLocalTurns.length === 0) delete h.priorLocalTurns;
  }
  // 2. the local note
  if (sizeOf(h) > cap) delete h.localNote;
  // 3. trim summaries, longest first
  while (sizeOf(h) > cap) {
    let longest = -1;
    for (let i = 0; i < h.steps.length; i++) {
      if (h.steps[i].summary.length > 0 && (longest === -1 || h.steps[i].summary.length > h.steps[longest].summary.length)) longest = i;
    }
    if (longest === -1) break;
    const s = h.steps[longest];
    s.summary = s.summary.length <= 200 ? '' : capText(s.summary, s.summary.length - 200);
  }
  // 4. whole steps from the end (only reachable with absurd args)
  while (sizeOf(h) > cap && h.steps.length > 0) h.steps.pop();
  // 5. last resort
  if (sizeOf(h) > cap) {
    delete h.suggestedCall;
    delete h.proposal;
  }
  return h;
}

// ── Mirror precheck ──────────────────────────────────────────────────────────

/** Is the mirror's last sync recent enough to answer from? The main thread syncs first if not. */
export function isMirrorFresh(lastSyncedAt: string | null | undefined, nowMs: number, maxAgeMs: number = MIRROR_MAX_AGE_MS): boolean {
  if (!lastSyncedAt) return false;
  const t = Date.parse(lastSyncedAt);
  if (!Number.isFinite(t)) return false;
  return nowMs - t <= maxAgeMs;
}

/**
 * Seeded and bound to the profile the main thread expects.
 * 'bundle' = unusable mirror, fall back to bundle mode (not a handoff);
 * 'stale' = the mirror holds a different profile than the server's active one.
 */
export function precheckMirror(status: MirrorPortStatus, expectedProfile: string): { kind: 'ok' } | { kind: 'bundle' } | { kind: 'stale' } {
  if (!status.seeded) return { kind: 'bundle' };
  if (status.profile === null || status.profile !== expectedProfile) return { kind: 'stale' };
  return { kind: 'ok' };
}

// ── The loop ─────────────────────────────────────────────────────────────────

export interface GenerateRequest {
  /**
   * Only `compose` is issued since Round 2 (the model never routes). `router` and `next` stay in the
   * union so the worker protocol and older callers keep type-checking; core never emits them (tested).
   */
  kind: 'router' | 'next' | 'compose';
  system: string;
  user: string;
  maxNewTokens: number;
  /** Greedy decoding is the caller's contract (do_sample: false). The signal interrupts generation. */
  signal?: AbortSignal;
}

export interface SubagentDeps {
  generate(req: GenerateRequest): Promise<string>;
  /** One scoped mirror read. The real implementation posts to the tool port. */
  toolRead(req: { tool: ReadToolName; args: Record<string, unknown>; nowIso: string }): Promise<ToolReadResult>;
  /** The port's `status` request. */
  status(): Promise<MirrorPortStatus>;
  /** Epoch ms. Injected so deadlines are testable. */
  now(): number;
  signal?: AbortSignal;
  /** UI chips. Exceptions are swallowed. */
  emit?(event: StepEvent): void;
  /**
   * TEST SEAM ONLY: replaces the frozen OPEN_JEV_ROUTE_CUT a route hint must match. The worker runner builds
   * its deps itself and never sets this, so nothing on the wire can change the cut.
   */
  routeCut?: number | null;
}

export interface SubagentInput {
  query: string;
  nowIso: string;
  /** The server's active profile, fetched by the main thread for this run. */
  expectedProfile: string;
  priorLocalTurns: PriorLocalTurn[];
  limits: SubagentLimits;
  /** Round 4: the main thread's open-jev pick for 0 / 2+ keyword hits. Re-checked here (resolveRoute). */
  routeHint?: RouteHint;
}

type Guarded<T> =
  | { k: 'ok'; v: T }
  | { k: 'threw'; e: unknown }
  | { k: 'timeout' }
  | { k: 'deadline' }
  | { k: 'cancelled' };

interface Ctx {
  deps: SubagentDeps;
  input: SubagentInput;
  limits: SubagentLimits;
  maxSteps: number;
  deadlineAt: number;
  steps: ExecutedStep[];
  mirrorSyncedAt: string | null;
  categories: string[];
  nowDate: Date;
}

function finiteOr(n: unknown, dflt: number, min: number): number {
  return typeof n === 'number' && Number.isFinite(n) && n >= min ? n : dflt;
}

function safeNow(deps: SubagentDeps): number {
  try {
    const t = deps.now();
    return Number.isFinite(t) ? t : Date.now();
  } catch {
    return Date.now();
  }
}

/**
 * Run one dependency call under the run's cancel signal, the whole-run
 * deadline and (optionally) a per-call timeout. Never rejects.
 */
function guarded<T>(ctx: Ctx, fn: () => Promise<T> | T, perCallMs?: number): Promise<Guarded<T>> {
  return new Promise<Guarded<T>>((resolve) => {
    const signal = ctx.deps.signal;
    if (signal?.aborted) return resolve({ k: 'cancelled' });
    const remaining = ctx.deadlineAt - safeNow(ctx.deps);
    if (remaining <= 0) return resolve({ k: 'deadline' });

    let done = false;
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    const onAbort = () => finish({ k: 'cancelled' });
    const finish = (r: Guarded<T>) => {
      if (done) return;
      done = true;
      for (const t of timers) clearTimeout(t);
      signal?.removeEventListener('abort', onAbort);
      resolve(r);
    };

    timers.push(setTimeout(() => finish({ k: 'deadline' }), remaining));
    if (perCallMs !== undefined && perCallMs < remaining) timers.push(setTimeout(() => finish({ k: 'timeout' }), Math.max(0, perCallMs)));
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      Promise.resolve(fn()).then(
        (v) => finish({ k: 'ok', v }),
        (e) => finish({ k: 'threw', e })
      );
    } catch (e) {
      finish({ k: 'threw', e });
    }
  });
}

function emit(ctx: Ctx, event: StepEvent): void {
  try {
    ctx.deps.emit?.(event);
  } catch {
    // UI listeners must never break a run
  }
}

function handoffOutcome(
  ctx: Ctx,
  reason: SubagentHandoffReason,
  extra: Partial<Pick<HandoffBuildInput, 'suggestedCall' | 'proposal' | 'localNote'>> = {}
): SubagentOutcome {
  let handoff: LocalHandoffV1;
  try {
    handoff = buildHandoff({
      reason,
      steps: ctx.steps,
      mirrorSyncedAt: ctx.mirrorSyncedAt,
      priorLocalTurns: ctx.input.priorLocalTurns,
      ...extra,
    });
  } catch {
    handoff = { v: 1, reason, mirror: { syncedAt: null }, steps: [] };
  }
  return { kind: 'handoff', reason, handoff };
}

function textOf(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function isToolReadResult(v: unknown): v is ToolReadResult {
  return isRecord(v) && typeof v.servable === 'boolean';
}

function isStatus(v: unknown): v is MirrorPortStatus {
  return isRecord(v) && typeof v.seeded === 'boolean' && (v.profile === null || typeof v.profile === 'string');
}

/** A guarded call that did not return a value maps to the run's terminal outcome. */
function terminal<T>(ctx: Ctx, g: Guarded<T>, onThrew: SubagentHandoffReason = 'error'): SubagentOutcome | null {
  switch (g.k) {
    case 'ok':
      return null;
    case 'cancelled':
      return { kind: 'cancelled' };
    case 'deadline':
      return handoffOutcome(ctx, 'deadline');
    case 'timeout':
    case 'threw':
      return handoffOutcome(ctx, onThrew);
  }
}

function resultCount(data: unknown): number | undefined {
  return isRecord(data) && typeof data.count === 'number' ? data.count : undefined;
}

const WHY_TO_REASON: Record<string, SubagentHandoffReason> = {
  'not-seeded': 'mirror-unavailable',
  'missing-tables': 'tool-unavailable',
  'unsupported-args': 'tool-unavailable',
  licensed: 'tool-unavailable',
};

/**
 * FILL_ARGS -> EXECUTE for the ONE tool the keyword router matched. There is no loop:
 * the on-device model never picks a second tool (precision-first, Round 2). Returns an
 * outcome when the run must end here, or null to continue to COMPOSE.
 */
async function execute(ctx: Ctx, tool: ReadToolName): Promise<SubagentOutcome | null> {
  const { deps, input, limits } = ctx;

  // FILL_ARGS
  const fill = fillArgs(tool, input.query, ctx.nowDate, ctx.categories);
  if (!fill.ok) return handoffOutcome(ctx, 'args-unfillable');
  const args = fill.args;

  // EXECUTE
  const started = safeNow(deps);
  const g = await guarded(ctx, () => deps.toolRead({ tool, args, nowIso: input.nowIso }), limits.stepTimeoutMs);
  const ms = Math.max(0, safeNow(deps) - started);

  if (g.k === 'cancelled') return { kind: 'cancelled' };
  if (g.k === 'deadline') return handoffOutcome(ctx, 'deadline');
  if (g.k === 'timeout' || g.k === 'threw' || !isToolReadResult(g.v)) {
    const why = g.k === 'timeout' ? 'tool timed out' : 'tool call failed';
    ctx.steps.push({ tool, args, ok: false, ms, summary: why });
    emit(ctx, { kind: 'tool', tool, ms, ok: false, args });
    return handoffOutcome(ctx, 'error');
  }
  const read = g.v;

  if (!read.servable) {
    emit(ctx, { kind: 'tool', tool, ms, ok: false, args });
    const reason = WHY_TO_REASON[read.why] ?? 'tool-unavailable';
    // [C2] The dashboard agent has no forecast tool: never suggest one.
    const suggestedCall =
      reason === 'tool-unavailable' && tool !== 'forecast' ? { tool: tool as HandoffAgentReadToolName, args } : undefined;
    return handoffOutcome(ctx, reason, suggestedCall ? { suggestedCall } : {});
  }

  // [C7] the step must have run against the profile this run expects.
  if (read.profile !== input.expectedProfile) {
    emit(ctx, { kind: 'tool', tool, ms, ok: false, args });
    return handoffOutcome(ctx, 'mirror-stale');
  }

  const rows = tool === 'transaction_search' ? resultCount(read.data) : undefined;
  const step: ExecutedStep = { tool, args, ok: true, ms, summary: textOf(read.summary), data: read.data };
  if (rows !== undefined) step.rows = rows;
  ctx.steps.push(step);
  emit(ctx, rows !== undefined ? { kind: 'tool', tool, ms, ok: true, rows, args } : { kind: 'tool', tool, ms, ok: true, args });

  // [C3] / Round 3: an empty or all-zero result carries no figures worth stating, so the grounding check
  // would pass a confident "you have no such charges" or a bare "$0.00". Never answer locally from nothing.
  if (isEmptyResult(tool, read.data)) return handoffOutcome(ctx, 'empty-result');

  return null;
}

/**
 * COMPOSE + VERIFY, template mode (the default, Round 3): the answer is written from the tool result by a
 * deterministic template. No model call. The text still passes the markup check before it ships (row text
 * such as a merchant name is untrusted and could carry a link).
 */
function composeFromTemplate(ctx: Ctx, tool: ReadToolName, today: string): SubagentOutcome {
  const step = ctx.steps[ctx.steps.length - 1];
  const text = step ? renderTemplate(tool, step.data, { today }) : null;
  if (text === null) return handoffOutcome(ctx, 'no-answer');
  // Figures are computed from the data by the template itself (a row sum is not a figure isGrounded can
  // find), so only the markup rule [C10] is checked here; the model path keeps the full grounding check.
  if (hasForbiddenMarkup(text)) return handoffOutcome(ctx, 'ungrounded');
  return { kind: 'answer', text, steps: ctx.steps.map(toRecord) };
}

async function runInner(deps: SubagentDeps, input: SubagentInput): Promise<SubagentOutcome> {
  const limits: SubagentLimits = {
    maxSteps: DEFAULT_SUBAGENT_LIMITS.maxSteps,
    routerMaxNewTokens: finiteOr(input.limits?.routerMaxNewTokens, DEFAULT_SUBAGENT_LIMITS.routerMaxNewTokens, 1),
    composeMaxNewTokens: finiteOr(input.limits?.composeMaxNewTokens, DEFAULT_SUBAGENT_LIMITS.composeMaxNewTokens, 1),
    stepTimeoutMs: finiteOr(input.limits?.stepTimeoutMs, DEFAULT_SUBAGENT_LIMITS.stepTimeoutMs, 0),
    runDeadlineMs: finiteOr(input.limits?.runDeadlineMs, DEFAULT_SUBAGENT_LIMITS.runDeadlineMs, 0),
    compose: input.limits?.compose === 'model' ? 'model' : 'template',
  };
  const requestedSteps = finiteOr(input.limits?.maxSteps, DEFAULT_SUBAGENT_LIMITS.maxSteps, 0);
  const maxSteps = Math.min(SUBAGENT_MAX_STEPS_HARD, Math.max(1, Math.floor(requestedSteps)));

  limits.maxSteps = maxSteps;

  const parsedNow = new Date(input.nowIso);
  const ctx: Ctx = {
    deps,
    input,
    limits,
    maxSteps,
    deadlineAt: safeNow(deps) + limits.runDeadlineMs,
    steps: [],
    mirrorSyncedAt: null,
    categories: [],
    nowDate: Number.isNaN(parsedNow.getTime()) ? new Date(safeNow(deps)) : parsedNow,
  };
  const query = String(input.query ?? '');

  if (deps.signal?.aborted) return { kind: 'cancelled' };

  // GATE (pure; a gated question never reaches the model, the port or the clock-bound steps)
  const gate = gateQuestion(query);
  emit(ctx, { kind: 'gate', verdict: gate.kind });
  if (gate.kind === 'mutation-intent') return handoffOutcome(ctx, 'mutation-intent', { proposal: gate.proposal });
  if (gate.kind === 'non-data') return handoffOutcome(ctx, 'non-data');

  // PRECHECK
  const st = await guarded(ctx, () => deps.status(), limits.stepTimeoutMs);
  if (st.k === 'cancelled') return { kind: 'cancelled' };
  if (st.k === 'deadline') return handoffOutcome(ctx, 'deadline');
  if (st.k !== 'ok' || !isStatus(st.v)) return handoffOutcome(ctx, 'mirror-unavailable');
  const status = st.v;
  ctx.mirrorSyncedAt = typeof status.lastSyncedAt === 'string' ? status.lastSyncedAt : null;
  ctx.categories = Array.isArray(status.categories) ? status.categories.filter((c): c is string => typeof c === 'string') : [];
  const pre = precheckMirror(status, input.expectedProfile);
  if (pre.kind === 'bundle') return { kind: 'bundle-fallback' };
  if (pre.kind === 'stale') return handoffOutcome(ctx, 'mirror-stale');

  // SHAPE (Round 3): what-if, comparison, trend and multi-period phrasing needs more than one read call,
  // which a single-call answer cannot express. Hand off before any tool read.
  if (detectComparisonIntent(query) !== null) {
    emit(ctx, { kind: 'route', tool: 'none', via: 'keyword' });
    return handoffOutcome(ctx, 'router-none');
  }

  // ROUTE (precision-first): exactly one keyword match answers locally. Zero or several matches
  // hand off to the server, unless (Round 4) the main thread's open-jev hint survives the re-check
  // in resolveRoute. The on-device generative model is never asked to choose, break a tie or say "none".
  const hits = keywordRoute(query);
  const route = resolveRoute(hits, input.routeHint, deps.routeCut === undefined ? OPEN_JEV_ROUTE_CUT : deps.routeCut);
  emit(ctx, route.event);
  if (route.tool === null) return handoffOutcome(ctx, 'router-none');
  const tool: ReadToolName = route.tool;

  // FILL_ARGS -> EXECUTE (one tool)
  const early = await execute(ctx, tool);
  if (early) return early;

  // COMPOSE
  emit(ctx, { kind: 'compose' });
  const today = ctx.nowDate.toISOString().slice(0, 10);
  if (limits.compose !== 'model') return composeFromTemplate(ctx, tool, today);
  const prompt = buildComposePrompt(query, ctx.steps, today);
  const gen = await guarded(ctx, () =>
    deps.generate({ kind: 'compose', system: prompt.system, user: prompt.user, maxNewTokens: limits.composeMaxNewTokens, signal: deps.signal })
  );
  const t = terminal(ctx, gen);
  if (t) return t;
  const raw = textOf((gen as { v: unknown }).v);

  // VERIFY
  const verdict = classifyLocalOutput(raw);
  if (verdict.kind === 'handoff') return handoffOutcome(ctx, verdict.reason);
  const grounding: GroundingStep[] = ctx.steps.map((s) => ({ tool: s.tool, data: s.data, summary: projectStepSummary(s) }));
  if (!isGrounded(verdict.text, grounding)) return handoffOutcome(ctx, 'ungrounded', { localNote: verdict.text });
  // A figure-free answer passes isGrounded vacuously: block false "no results" claims and answers that
  // say nothing about the results. The rejected text is not forwarded (it is known to be unreliable).
  if (answerClaimProblem(verdict.text, grounding) !== null) return handoffOutcome(ctx, 'ungrounded');

  return { kind: 'answer', text: verdict.text, steps: ctx.steps.map(toRecord) };
}

/**
 * ROUTE with the Round-4 open-jev hint (specs/browser-subagent-round4-openjev-router.md §4.3).
 * Exactly one keyword hit: that tool, and any hint is ignored. Otherwise a hint is honoured only when
 * it is well-formed, its hits equal the core's own, its cut equals the frozen cut, and decideRoute
 * accepts it (read tool, finite margin >= cut, and on a multi-hit a tool among the hits). Pure.
 */
function resolveRoute(
  hits: ReadToolName[],
  hint: RouteHint | undefined,
  frozenCut: number | null,
): { tool: ReadToolName | null; event: StepEvent } {
  if (hits.length === 1) return { tool: hits[0], event: { kind: 'route', tool: hits[0], via: 'keyword' } };
  if (hint === undefined) return { tool: null, event: { kind: 'route', tool: 'none', via: 'keyword' } };
  const reject = (why: RouteHandoffWhy | 'malformed' | 'hits-mismatch' | 'cut-mismatch') => {
    const event: StepEvent = { kind: 'route', tool: 'none', via: 'openjev', why };
    if (isRouteHint(hint)) {
      event.margin = hint.margin;
      event.cut = hint.cut;
    }
    return { tool: null, event };
  };
  if (!isRouteHint(hint)) return reject('malformed');
  if (hint.hits.length !== hits.length || hint.hits.some((h, i) => h !== hits[i])) return reject('hits-mismatch');
  if (frozenCut === null || hint.cut !== frozenCut) return reject(frozenCut === null ? 'disabled' : 'cut-mismatch');
  const decision = decideRoute(hits, { tool: hint.tool, p1: Number.NaN, p2: Number.NaN, margin: hint.margin }, frozenCut);
  if ('handoff' in decision) return reject(decision.why);
  return { tool: decision.tool, event: { kind: 'route', tool: decision.tool, via: 'openjev', margin: hint.margin, cut: frozenCut } };
}

/**
 * Run one subagent turn. ALWAYS resolves; never rejects. Outcomes:
 *  - `answer`          grounded text composed from on-device lookups;
 *  - `handoff`         the server agent should answer (with a bounded payload);
 *  - `bundle-fallback` the mirror is unusable: run today's bundle mode instead;
 *  - `cancelled`       the user or a newer run cancelled: send nothing.
 */
export async function runSubagent(deps: SubagentDeps, input: SubagentInput): Promise<SubagentOutcome> {
  try {
    return await runInner(deps, input);
  } catch {
    try {
      return {
        kind: 'handoff',
        reason: 'error',
        handoff: buildHandoff({ reason: 'error', steps: [], mirrorSyncedAt: null, priorLocalTurns: input?.priorLocalTurns ?? [] }),
      };
    } catch {
      return { kind: 'handoff', reason: 'error', handoff: { v: 1, reason: 'error', mirror: { syncedAt: null }, steps: [] } };
    }
  }
}
