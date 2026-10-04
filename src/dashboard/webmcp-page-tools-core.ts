/**
 * The pure half of the page tools the React dashboard registers (`open_tab`, `get_page_context`): what
 * `get_page_context` says and which tools `open_tab` reports. Browser-safe (no DOM, no node), bundled by
 * vite for React (alias `@webmcp-page-tools`) and imported directly by root tests.
 *
 * Everything an agent reads here is ids, counts and filter values: never a description or an amount (threat T23).
 * Text a person typed (the search box) is untrusted and goes through the same sanitizer as every other tool output.
 * A category filter is a category NAME, which the chat agent may have created itself: it goes through the same
 * label rules as every other category an agent reads (`safeCategoryLabel`).
 */
import { UNTRUSTED_NOTE, isSafeCategoryName, safeCategoryLabel, sanitizeUntrustedText } from '../mcp/text-hygiene.js';
import { AGENT_TAB_IDS, type TabId } from './webmcp-session.js';

export { AGENT_TAB_IDS, UNTRUSTED_NOTE };
import type { PageRegistry } from './webmcp-page-registry.js';
import type { ToolErrorResult } from './webmcp-tool-error.js';

/** `open_tab` lists at most this many tool names, so its answer cannot outgrow the 1,500-character bound. */
export const MAX_PAGE_CONTEXT_TOOLS = 30;

const SEARCH_MAX = 60;
const MAX_ROWS = 1_000_000;

/** What an agent is told when it asks for a tab it may not open. */
export const SETTINGS_TAB_REFUSAL = 'The Settings tab is not available to agents. Ask the user to open Settings themselves.';

/** What an agent is told when the user is in Settings: edits there (grants, policies, drafts) must not be pulled away. */
export const SETTINGS_LEAVE_REFUSAL = 'The user is in Settings. Ask them to leave it first.';

/**
 * Why `open_tab` must refuse to move from `current` to `target`, or undefined when it may. Settings is off
 * limits both ways: an agent cannot open it, and cannot navigate the user away from it (unsaved input, grant edits).
 */
export function navigateRefusal(current: string | undefined, target: string): string | undefined {
  if (target === 'settings') return SETTINGS_TAB_REFUSAL;
  if (current === 'settings') return SETTINGS_LEAVE_REFUSAL;
  return undefined;
}

/**
 * A refusal an agent can act on, as a RESULT. Chrome 154 replaces the text of any error a page tool handler throws with a
 * generic "Tool was executed but the invocation failed", so a handler never throws one: it returns this.
 */
export function pageError(code: string, message: string): ToolErrorResult {
  return { error: { code, message } };
}

/** `navigateRefusal` as an error result (`settings_refused` or `user_in_settings`), or undefined when navigation may go ahead. */
export function navigateRefusalResult(current: string | undefined, target: string): ToolErrorResult | undefined {
  const message = navigateRefusal(current, target);
  if (message === undefined) return undefined;
  return pageError(target === 'settings' ? 'settings_refused' : 'user_in_settings', message);
}

/** Why `open_tab` cannot use `value` as a tab (Settings, or not a tab at all), or undefined when it is one an agent may open. */
export function tabRefusalResult(value: unknown): ToolErrorResult | undefined {
  if (parseTab(value)) return undefined;
  if (value === 'settings') return pageError('settings_refused', SETTINGS_TAB_REFUSAL);
  return pageError('invalid_args', `tab must be one of: ${AGENT_TAB_IDS.join(', ')}`);
}

/** `value` as a tab id an agent may open, or undefined. */
export function parseTab(value: unknown): TabId | undefined {
  return typeof value === 'string' && (AGENT_TAB_IDS as readonly string[]).includes(value) ? (value as TabId) : undefined;
}

/** Resolves when `promise` settles or after `ms`, whichever comes first. Never rejects: a stuck wait must not hang a tool call. */
export function settleWithin(promise: Promise<unknown> | undefined, ms: number): Promise<void> {
  if (!promise) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    promise.then(
      () => { clearTimeout(timer); resolve(); },
      () => { clearTimeout(timer); resolve(); }
    );
  });
}

/** Text a person typed, as an agent may read it: hidden characters stripped, PII masked, clipped. */
export function clipPageText(value: string, max: number): string {
  return sanitizeUntrustedText(value, max);
}

/** What a tab publishes about itself: the parts of the context only the tab knows. */
export interface PageContextContribution {
  /** The tab's own filters. `null` clears the header's value of the same name. */
  filters?: { search?: string | null; category?: string | null };
  selection?: { transactionId?: number | null; reviewId?: number | null; interactionId?: number | null };
  /** Rows the tab lists right now. */
  visibleRows?: number;
}

export interface PageContextInput {
  tab: string;
  dateRange: { startDate: string; endDate: string };
  /** The header's filters (`AppState`). */
  accountId?: number | null;
  category?: string | null;
  entityId?: number | null;
  /** The categories the dashboard knows (`/api/categories`), to tell a system name from a custom one and to find a custom one's id. */
  categories?: ReadonlyArray<{ id: number; name: string; is_system: number }>;
  contribution?: PageContextContribution;
}

export interface PageContext {
  tab: string;
  dateRange: { start: string; end: string };
  filters: { accountId?: number; category?: string; entityId?: number; search?: string };
  selection: { transactionId?: number; reviewId?: number; interactionId?: number };
  visibleRows: number;
  /** The standard untrusted-data note: the filter values above are text a person (or an agent) typed. */
  note: string;
}

function id(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

/**
 * A category filter value as an agent may read it. A known system category is its own name; a known custom one goes
 * through `safeCategoryLabel` (plain name, else `#<id> (custom)`). A name that matches no known category has no id to
 * stand in for it, so it survives only if it is already a plain name, and is dropped otherwise.
 */
export function safeCategoryFilter(name: unknown, categories?: PageContextInput['categories']): string | undefined {
  if (typeof name !== 'string') return undefined;
  const trimmed = name.trim();
  if (trimmed === '') return undefined;
  const known = categories?.find((c) => c.name === trimmed);
  if (known) return clipPageText(safeCategoryLabel(known), 32);
  return isSafeCategoryName(trimmed) ? clipPageText(trimmed, 32) : undefined;
}

/** `get_page_context`'s answer. Bounded by construction: a handful of ids and two short strings. */
export function buildPageContext(input: PageContextInput): PageContext {
  const own = input.contribution?.filters;
  // The tab's own filter wins over the header's; an explicit null from the tab clears it.
  const categoryRaw = own && 'category' in own ? own.category : input.category;
  const category = safeCategoryFilter(categoryRaw, input.categories);
  const search = typeof own?.search === 'string' && own.search.trim() !== '' ? clipPageText(own.search, SEARCH_MAX) : undefined;
  const accountId = id(input.accountId);
  const entityId = id(input.entityId);
  const selection = input.contribution?.selection;
  const transactionId = id(selection?.transactionId);
  const reviewId = id(selection?.reviewId);
  const interactionId = id(selection?.interactionId);
  const rows = input.contribution?.visibleRows;

  return {
    tab: input.tab,
    dateRange: { start: input.dateRange.startDate, end: input.dateRange.endDate },
    filters: {
      ...(accountId !== undefined ? { accountId } : {}),
      ...(category ? { category } : {}),
      ...(entityId !== undefined ? { entityId } : {}),
      ...(search ? { search } : {}),
    },
    selection: {
      ...(transactionId !== undefined ? { transactionId } : {}),
      ...(reviewId !== undefined ? { reviewId } : {}),
      ...(interactionId !== undefined ? { interactionId } : {}),
    },
    visibleRows: typeof rows === 'number' && Number.isFinite(rows) && rows > 0 ? Math.min(Math.floor(rows), MAX_ROWS) : 0,
    note: UNTRUSTED_NOTE,
  };
}

/**
 * The tools an agent will have once `tab` shows: every live tool (imperative or declarative) that is global or
 * belongs to that tab. Only what the bridge published as live, so an ungranted tool is never named.
 */
export function availableToolsFor(registry: Pick<PageRegistry, 'liveTools' | 'toolInfo'>, tab: string): string[] {
  const names: string[] = [];
  for (const name of registry.liveTools()) {
    const surface = registry.toolInfo(name)?.surface;
    if (surface === undefined || surface === 'global' || surface.tab === tab) names.push(name);
  }
  return names.sort().slice(0, MAX_PAGE_CONTEXT_TOOLS);
}

/** The first and last day of the month `date` (YYYY-MM-DD) falls in, or undefined if it is not such a date. */
export function monthBoundsOf(date: unknown): { startDate: string; endDate: string } | undefined {
  if (typeof date !== 'string') return undefined;
  const match = /^(\d{4})-(\d{2})-\d{2}$/.exec(date);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) return undefined;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { startDate: `${match[1]}-${match[2]}-01`, endDate: `${match[1]}-${match[2]}-${String(lastDay).padStart(2, '0')}` };
}

/**
 * Whether `date` (YYYY-MM-DD) lies outside `range`. Only then may `open_transaction` move the app-wide range: a row that
 * is inside it, hidden by a filter, must not narrow the user's view (a year to one month). Undecidable is false.
 */
export function dateOutsideRange(date: unknown, range: { startDate: string; endDate: string }): boolean {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  return date < range.startDate || date > range.endDate;
}

/**
 * Poll `condition` until it is true (resolves true), the timeout passes or `signal` aborts (resolves false). A
 * condition that throws counts as not yet. The handlers use it to report what the screen actually shows, instead of
 * claiming a row is highlighted before React has rendered it.
 */
export function pollUntil(
  condition: () => boolean,
  signal: AbortSignal,
  options: { timeoutMs: number; intervalMs?: number }
): Promise<boolean> {
  const interval = options.intervalMs ?? 50;
  const deadline = Date.now() + options.timeoutMs;
  const check = (): boolean => {
    try {
      return condition();
    } catch {
      return false;
    }
  };
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (value: boolean) => {
      if (timer !== undefined) clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve(value);
    };
    const onAbort = () => finish(false);
    if (signal.aborted) return resolve(false);
    signal.addEventListener('abort', onAbort, { once: true });
    const step = () => {
      if (check()) return finish(true);
      if (Date.now() >= deadline) return finish(false);
      timer = setTimeout(step, interval);
    };
    step();
  });
}

/** Resolves true once the registry reports `tab` as the one showing (at once if it already does), false on timeout or abort. */
export function waitForActiveTab(registry: Pick<PageRegistry, 'activeTab' | 'subscribe'>, tab: string, signal: AbortSignal, timeoutMs: number): Promise<boolean> {
  if (registry.activeTab() === tab) return Promise.resolve(true);
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    let unsubscribe: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (value: boolean) => {
      unsubscribe?.();
      if (timer !== undefined) clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve(value);
    };
    const onAbort = () => finish(false);
    signal.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => finish(false), timeoutMs);
    unsubscribe = registry.subscribe(() => {
      if (registry.activeTab() === tab) finish(true);
    });
  });
}

// ── Agent action guard (J2, threat T16) ──────────────────────────────────────

/** How long the human action buttons of whatever an agent just moved stay disabled. */
export const AGENT_GUARD_MS = 800;

/** A rectangle, as `getBoundingClientRect()` reports it. */
export interface Box {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/** The part of `a` that is also inside `b` (an empty or inverted box when they do not overlap). */
export function visibleBounds(a: Box, b: Box): Box {
  return { top: Math.max(a.top, b.top), bottom: Math.min(a.bottom, b.bottom), left: Math.max(a.left, b.left), right: Math.min(a.right, b.right) };
}

/** Whether `el` lies entirely inside `view`. */
export function isInView(el: Box, view: Box): boolean {
  return el.top >= view.top && el.bottom <= view.bottom && el.left >= view.left && el.right <= view.right;
}

/** An agent may scroll a row only when it is not already fully visible: a visible row stays exactly where it is. */
export function shouldScrollForAgent(el: Box, view: Box): boolean {
  return !isInView(el, view);
}

/** The time (ms epoch) at which a guard started at `now` lifts. */
export function agentGuardUntil(now: number, ms: number = AGENT_GUARD_MS): number {
  return now + ms;
}

/** Whether a guard that lifts at `until` is still on at `now`. No guard (null/undefined) is off. */
export function isAgentGuarded(until: number | null | undefined, now: number): boolean {
  return typeof until === 'number' && now < until;
}
