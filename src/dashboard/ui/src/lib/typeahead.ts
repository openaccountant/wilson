/**
 * Pure typeahead logic for the dashboard chat composer: "/" commands and
 * "@" mentions. No React, no DOM — Bun unit tests import this module directly
 * (src/__tests__/dashboard-typeahead.test.ts), same pattern as demo/core.ts.
 */

import { HANDOFF_DETECT_STRUCTURAL, MENTION_BLOCK_PREFIX, splitInjectedContext } from '../../../local-handoff-format.js';

// ── Trigger detection ──────────────────────────────────────────────────────

export type TriggerKind = '/' | '@';

export interface Trigger {
  kind: TriggerKind;
  /** Index of the trigger character ('/' or '@'). */
  start: number;
  /** Always the caret. */
  end: number;
  /** Text after the trigger (after `@[` for the bracket form) up to the caret. */
  query: string;
  /** True when only whitespace precedes the trigger. */
  leading: boolean;
  /** `@[Multi word` form. */
  bracket?: boolean;
}

/** Bare-'@' queries close once they exceed this many chars. */
export const MAX_MENTION_QUERY = 48;

const WS = /\s/;

function tokenStartBefore(text: string, caret: number, alsoParen: boolean): number {
  let i = caret;
  while (i > 0) {
    const ch = text[i - 1];
    if (WS.test(ch) || (alsoParen && ch === '(')) break;
    i--;
  }
  return i;
}

function isMentionBoundary(text: string, index: number): boolean {
  if (index === 0) return true;
  const ch = text[index - 1];
  return WS.test(ch) || ch === '(';
}

/**
 * True when the caret sits at the END of a token: nothing but whitespace (or
 * a closing paren) follows it. A caret at or inside a token never opens a menu.
 */
function caretAtTokenEnd(text: string, caret: number): boolean {
  if (caret >= text.length) return true;
  const ch = text[caret];
  return WS.test(ch) || ch === ')';
}

/**
 * Detect an open "/" or "@" token ending at the caret.
 *
 * - The caret must be past the trigger character and at the end of the token
 *   (the query is always the whole token up to the caret).
 * - "/" only triggers at the start of the message (after optional
 *   whitespace): commands are whole messages, a mid-text "/" is just text.
 * - `hasMatches(query)` lets a bare `@` query continue across ONE space while
 *   the query still has at least one match ("@chase che"); without it, a space
 *   always closes the mention.
 * - `acceptedTokens` are mention tokens already inserted by the menu
 *   ("@Dining"): a token equal to one of them — or the one-space continuation
 *   after it — never reopens the menu, so Enter after accepting sends.
 */
export function detectTrigger(
  text: string,
  caret: number,
  hasMatches?: (query: string) => boolean,
  acceptedTokens: readonly string[] = [],
): Trigger | null {
  if (caret < 0 || caret > text.length) return null;
  if (!caretAtTokenEnd(text, caret)) return null;
  const before = text.slice(0, caret);
  const accepted = (token: string) => acceptedTokens.includes(token);

  // ── '@[' bracket form: may contain spaces, ends at ']' ──
  const lastBracket = before.lastIndexOf('@[');
  if (lastBracket !== -1 && isMentionBoundary(text, lastBracket)) {
    const inner = before.slice(lastBracket + 2);
    if (!inner.includes(']') && !inner.includes('\n') && inner.length <= 120) {
      return {
        kind: '@',
        start: lastBracket,
        end: caret,
        query: inner,
        leading: text.slice(0, lastBracket).trim() === '',
        bracket: true,
      };
    }
  }

  // ── '/' command token (leading position only) ──
  const slashStart = tokenStartBefore(text, caret, false);
  if (text[slashStart] === '/') {
    if (caret <= slashStart) return null;
    const query = before.slice(slashStart + 1);
    // "/usr/bin", "//" — paths, not commands.
    if (query.includes('/')) return null;
    // Mid-text "/" is plain text ("1/2", "and/or", "hey /sk").
    if (text.slice(0, slashStart).trim() !== '') return null;
    return { kind: '/', start: slashStart, end: caret, query, leading: true };
  }

  // ── bare '@' token ──
  const atStart = tokenStartBefore(text, caret, true);
  if (text[atStart] === '@') {
    if (caret <= atStart) return null;
    const query = before.slice(atStart + 1);
    if (query.includes('@') || query.length > MAX_MENTION_QUERY) return null;
    if (accepted(`@${query}`)) return null;
    return {
      kind: '@',
      start: atStart,
      end: caret,
      query,
      leading: text.slice(0, atStart).trim() === '',
    };
  }

  // ── '@word word' continuation across exactly one space ──
  if (hasMatches && atStart > 0 && text[atStart - 1] === ' ') {
    const prevEnd = atStart - 1;
    if (prevEnd > 0 && WS.test(text[prevEnd - 1])) return null; // two spaces
    const prevStart = tokenStartBefore(text, prevEnd, true);
    if (text[prevStart] !== '@' || text[prevStart + 1] === '[') return null;
    const first = text.slice(prevStart + 1, prevEnd);
    if (!first || first.includes('@')) return null;
    // The first word is a mention the menu already inserted → done.
    if (accepted(`@${first}`)) return null;
    const query = before.slice(prevStart + 1);
    if (query.length > MAX_MENTION_QUERY) return null;
    const probe = query.trimEnd();
    if (!hasMatches(probe)) return null;
    return {
      kind: '@',
      start: prevStart,
      end: caret,
      query,
      leading: text.slice(0, prevStart).trim() === '',
    };
  }

  return null;
}

/**
 * Second-stage argument completion for `/profile <name>`,
 * `/budget set <category> <amount>` and `/skill <name> [args]`.
 */
export type ArgSource = 'profiles' | 'categories' | 'skills';

export interface ArgTrigger {
  kind: 'arg';
  source: ArgSource;
  command: string;
  start: number;
  end: number;
  query: string;
}

const ARG_PREFIXES: Array<{ re: RegExp; source: ArgSource; command: string; spaces: boolean }> = [
  { re: /^\s*\/profile\s+/i, source: 'profiles', command: 'profile', spaces: false },
  { re: /^\s*\/budget\s+set\s+/i, source: 'categories', command: 'budget set', spaces: true },
  { re: /^\s*\/skill\s+/i, source: 'skills', command: 'skill', spaces: false },
];

export function detectArgTrigger(text: string, caret: number): ArgTrigger | null {
  if (caret < 0 || caret > text.length || !caretAtTokenEnd(text, caret)) return null;
  for (const p of ARG_PREFIXES) {
    const m = p.re.exec(text);
    if (!m) continue;
    const start = m[0].length;
    if (caret < start) return null;
    const query = text.slice(start, caret);
    if (query.includes('\n')) return null;
    if (!p.spaces && /\s/.test(query)) return null;
    // `/budget set Dining 200` — once the amount begins, the category is done.
    if (p.spaces && /\s\$?\d/.test(query)) return null;
    return { kind: 'arg', source: p.source, command: p.command, start, end: caret, query };
  }
  return null;
}

// ── Active option ──────────────────────────────────────────────────────────

/**
 * Active option index when a menu opens or its query changes. "/" and "@"
 * start on the top match. A second-stage argument list ("/profile ",
 * "/budget set ", "/skill ") opens with NO active option until the user types
 * or arrows: Enter then falls through to a normal send instead of picking
 * (and, for /profile, switching to) whatever happens to be first.
 */
export function initialActiveIndex(trigger: { kind: string; query: string } | null): number {
  // An empty query (bare '/' or an arg list) opens with nothing active so a
  // stray Enter can never run a command — '/new' is first and destructive.
  if (trigger && (trigger.kind === 'arg' || trigger.kind === '/') && trigger.query === '') return -1;
  return 0;
}

/** Arrow/Page navigation over `count` options from `current` (-1 = none active). */
export function nextActiveIndex(current: number, delta: number, count: number, wrap: boolean): number {
  if (count === 0) return -1;
  if (current < 0) return delta > 0 ? 0 : count - 1;
  const cur = Math.min(current, count - 1);
  const next = cur + delta;
  if (wrap) return (next + count) % count;
  return Math.max(0, Math.min(count - 1, next));
}

/**
 * Whether the popover is open. `blocked` closes it without dismissing (e.g.
 * the mention limit is reached): Enter then sends, and the composer shows why.
 * Argument completion with nothing to offer stays quiet; "/" and "@" show
 * "No matches".
 */
export function isTypeaheadOpen(s: {
  focused: boolean;
  trigger: { kind: string } | null;
  dismissed: boolean;
  blocked: boolean;
  itemCount: number;
}): boolean {
  if (!s.focused || !s.trigger || s.dismissed || s.blocked) return false;
  return s.itemCount > 0 || s.trigger.kind !== 'arg';
}

/**
 * DOM id of option `index` in a listbox (aria-activedescendant target).
 * Index-based: ids derived from labels collide for merchants that differ only
 * in punctuation ("AT&T" / "AT-T").
 */
export function optionDomId(listboxId: string, index: number): string {
  return `${listboxId}-opt-${index}`;
}

export const MENU_MIN_WIDTH = 280;
export const MENU_MAX_WIDTH = 576;
const MENU_GUTTER = 8;

/**
 * Fixed-position placement for the popover above its anchor (the composer
 * row): at least MENU_MIN_WIDTH wide even when the composer is squeezed by
 * the sessions sidebar (it may overlap the sidebar), never wider than the
 * viewport minus a gutter, and shifted left to stay on screen.
 */
export function menuPlacement(
  anchor: { left: number; top: number; width: number },
  viewport: { width: number; height: number },
): { left: number; bottom: number; width: number; maxHeight: number } {
  const room = Math.max(0, viewport.width - MENU_GUTTER * 2);
  const width = Math.min(room, MENU_MAX_WIDTH, Math.max(anchor.width, MENU_MIN_WIDTH));
  let left = anchor.left;
  if (left + width > viewport.width - MENU_GUTTER) left = viewport.width - MENU_GUTTER - width;
  left = Math.max(MENU_GUTTER, left);
  const bottom = viewport.height - anchor.top + MENU_GUTTER;
  // Title strip + footer ≈ 64px; keep the list on screen above the composer.
  const maxHeight = Math.max(96, Math.min(320, viewport.height * 0.45, anchor.top - MENU_GUTTER * 2 - 64));
  return { left, bottom, width, maxHeight };
}

// ── Fuzzy scoring ──────────────────────────────────────────────────────────

/** Half-open [start, end) ranges into the candidate, for match highlighting. */
export type Range = [number, number];

export interface FuzzyMatch {
  score: number;
  ranges: Range[];
}

const BOUNDARY = new Set([' ', '-', '_', '·', '/', '.', '(', '•']);

/**
 * Case-insensitive fuzzy score:
 *   exact 1000 · prefix 900-len · word-boundary prefix 700 ·
 *   substring 400-index · in-order subsequence 200-gaps*5. null = no match.
 */
export function fuzzyScore(query: string, candidate: string): FuzzyMatch | null {
  const q = query.toLowerCase();
  const c = candidate.toLowerCase();
  if (q.length === 0) return { score: 0, ranges: [] };
  if (q.length > c.length) return null;

  if (c === q) return { score: 1000, ranges: [[0, c.length]] };
  if (c.startsWith(q)) return { score: 900 - c.length, ranges: [[0, q.length]] };

  for (let i = 1; i <= c.length - q.length; i++) {
    if (BOUNDARY.has(c[i - 1]) && c.startsWith(q, i)) {
      return { score: 700, ranges: [[i, i + q.length]] };
    }
  }

  const idx = c.indexOf(q);
  if (idx !== -1) return { score: Math.max(201, 400 - idx), ranges: [[idx, idx + q.length]] };

  // In-order subsequence (greedy).
  const positions: number[] = [];
  let from = 0;
  for (const ch of q) {
    const at = c.indexOf(ch, from);
    if (at === -1) return null;
    positions.push(at);
    from = at + 1;
  }
  let gaps = 0;
  for (let i = 1; i < positions.length; i++) gaps += positions[i] - positions[i - 1] - 1;
  return { score: Math.max(1, 200 - gaps * 5), ranges: mergePositions(positions) };
}

function mergePositions(positions: number[]): Range[] {
  const ranges: Range[] = [];
  for (const p of positions) {
    const last = ranges[ranges.length - 1];
    if (last && last[1] === p) last[1] = p + 1;
    else ranges.push([p, p + 1]);
  }
  return ranges;
}

function mergeRanges(ranges: Range[]): Range[] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const out: Range[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}

/** Split `label` into plain / highlighted segments for rendering. */
export function highlightSegments(label: string, ranges: Range[] | undefined): Array<{ text: string; match: boolean }> {
  if (!ranges || ranges.length === 0) return [{ text: label, match: false }];
  const out: Array<{ text: string; match: boolean }> = [];
  let pos = 0;
  for (const [s, e] of mergeRanges(ranges)) {
    if (s > pos) out.push({ text: label.slice(pos, s), match: false });
    out.push({ text: label.slice(s, e), match: true });
    pos = e;
  }
  if (pos < label.length) out.push({ text: label.slice(pos), match: false });
  return out;
}

// ── Filter + group ─────────────────────────────────────────────────────────

export interface Candidate {
  id: string;
  group: string;
  label: string;
  /** Full-weight extra match targets (aliases, institution, last4, slug…). */
  keywords?: string[];
  /** Half-weight match targets (e.g. skill description words). */
  weakKeywords?: string[];
  /** Tie-break weight (merchant txn count, recency). Higher first. */
  weight?: number;
}

export type Scored<T> = T & { score: number; ranges: Range[] };

export interface FilterOptions<T extends Candidate> {
  /** Display order of groups (ties). Groups not listed sort last. */
  groupOrder: string[];
  perGroupCap?: number;
  totalCap?: number;
  /** Empty-query curation: items per group, overriding perGroupCap (missing = perGroupCap, 0 = hidden). */
  emptyLimits?: Record<string, number>;
  /** Empty-query items shown first in their own group (e.g. "Recent"). */
  pinned?: T[];
}

export interface FilterGroup<T> {
  group: string;
  items: Array<Scored<T>>;
}

export interface FilterResult<T> {
  groups: Array<FilterGroup<T>>;
  /** Flat, display-ordered list (what activeIndex indexes into). */
  items: Array<Scored<T>>;
  /** Matches not shown because of the caps. */
  hidden: number;
}

function scoreCandidate(query: string, item: Candidate): FuzzyMatch | null {
  const terms = query.trim().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return { score: 0, ranges: [] };

  // Whole query first (keeps "plaid che" highlighting contiguous).
  const whole = bestFor(query.trim(), item);
  if (whole) return whole;
  if (terms.length === 1) return null;

  // Multi-word: every term must hit the label or a keyword.
  let total = 0;
  const ranges: Range[] = [];
  for (const t of terms) {
    const m = bestFor(t, item);
    if (!m) return null;
    total += m.score;
    ranges.push(...m.ranges);
  }
  return { score: Math.round(total / terms.length) - 50, ranges: mergeRanges(ranges) };
}

function bestFor(q: string, item: Candidate): FuzzyMatch | null {
  let best: FuzzyMatch | null = fuzzyScore(q, item.label);
  for (const k of item.keywords ?? []) {
    const m = fuzzyScore(q, k);
    if (m && (!best || m.score > best.score)) best = { score: m.score, ranges: best?.ranges ?? [] };
  }
  for (const k of item.weakKeywords ?? []) {
    const m = fuzzyScore(q, k);
    if (m) {
      const half = Math.floor(m.score / 2);
      if (!best || half > best.score) best = { score: half, ranges: best?.ranges ?? [] };
    }
  }
  return best;
}

export function filterAndGroup<T extends Candidate>(
  candidates: T[],
  query: string,
  opts: FilterOptions<T>,
): FilterResult<T> {
  const perGroupCap = opts.perGroupCap ?? 8;
  const totalCap = opts.totalCap ?? 40;
  const orderOf = (g: string) => {
    const i = opts.groupOrder.indexOf(g);
    return i === -1 ? opts.groupOrder.length : i;
  };
  const empty = query.trim() === '';

  const scored: Array<Scored<T>> = [];
  const inputIndex = new Map<string, number>();
  candidates.forEach((c, i) => {
    const m = scoreCandidate(query, c);
    if (m) {
      scored.push({ ...c, score: m.score, ranges: m.ranges });
      inputIndex.set(c.id, i);
    }
  });

  // Empty query keeps the caller's curated order within a group (registry
  // order for commands, sort_order for categories) instead of A→Z.
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      orderOf(a.group) - orderOf(b.group) ||
      (b.weight ?? 0) - (a.weight ?? 0) ||
      (empty ? inputIndex.get(a.id)! - inputIndex.get(b.id)! : a.label.localeCompare(b.label)),
  );

  // Bucket by group, preserving score order within each.
  const buckets = new Map<string, Array<Scored<T>>>();
  for (const s of scored) {
    const list = buckets.get(s.group) ?? [];
    list.push(s);
    buckets.set(s.group, list);
  }

  // Groups ordered by their best score (empty query: fixed group order).
  const groupNames = [...buckets.keys()].sort((a, b) => {
    if (!empty) {
      const diff = buckets.get(b)![0].score - buckets.get(a)![0].score;
      if (diff !== 0) return diff;
    }
    return orderOf(a) - orderOf(b);
  });

  const groups: Array<FilterGroup<T>> = [];
  let shown = 0;
  let matched = 0;

  if (empty && opts.pinned && opts.pinned.length > 0) {
    const pinnedIds = new Set(opts.pinned.map((p) => p.id));
    const pinnedItems = opts.pinned.slice(0, perGroupCap).map((p) => ({ ...p, score: 0, ranges: [] as Range[] }));
    groups.push({ group: pinnedItems[0].group, items: pinnedItems });
    shown += pinnedItems.length;
    matched += pinnedItems.length;
    // Don't show a pinned entity twice.
    for (const [g, list] of buckets) buckets.set(g, list.filter((s) => !pinnedIds.has(s.id)));
  }

  for (const g of groupNames) {
    const list = buckets.get(g)!;
    let cap = perGroupCap;
    // Empty-query curation overrides the per-group cap ("all Actions").
    if (empty && opts.emptyLimits && g in opts.emptyLimits) cap = opts.emptyLimits[g];
    // Hidden-by-curation items don't count as "+N more" on an empty query.
    matched += empty ? Math.min(list.length, cap) : list.length;
    const room = Math.max(0, totalCap - shown);
    const take = list.slice(0, Math.min(cap, room));
    if (take.length > 0) {
      groups.push({ group: g, items: take });
      shown += take.length;
    }
  }

  return { groups, items: groups.flatMap((g) => g.items), hidden: Math.max(0, matched - shown) };
}

// ── Insertion ──────────────────────────────────────────────────────────────

const PLAIN_TOKEN = /^[\w.&'-]+$/;

/** `@Label` for simple labels, `@[Multi Word]` otherwise. `]` is stripped. */
export function formatMentionToken(label: string): string {
  const clean = label.replace(/[\]\n\r]/g, '').trim();
  return PLAIN_TOKEN.test(clean) ? `@${clean}` : `@[${clean}]`;
}

/**
 * Replace [start, end) of `text` with `insert` plus one trailing space
 * (reusing an existing space after the range). Returns the new text + caret.
 */
export function applySelection(
  text: string,
  range: { start: number; end: number },
  insert: string,
): { text: string; caret: number } {
  const head = text.slice(0, range.start);
  let tail = text.slice(range.end);
  if (tail.startsWith(' ')) tail = tail.slice(1);
  const next = `${head}${insert} ${tail}`;
  return { text: next, caret: head.length + insert.length + 1 };
}

export interface AccountLike {
  id: number;
  name: string;
  institution: string | null;
  account_number_last4: string | null;
}

/**
 * Mention labels for accounts. Names are not unique (several "Plaid
 * Checking"s), so colliding names become `Name · Institution ••last4`, with
 * `#id` as a last resort.
 */
export function accountMentionLabels(accounts: AccountLike[]): Map<number, string> {
  const counts = new Map<string, number>();
  for (const a of accounts) counts.set(a.name, (counts.get(a.name) ?? 0) + 1);

  const labels = new Map<number, string>();
  for (const a of accounts) {
    if ((counts.get(a.name) ?? 0) <= 1) {
      labels.set(a.id, a.name);
      continue;
    }
    const qual = [a.institution, a.account_number_last4 ? `••${a.account_number_last4}` : null]
      .filter(Boolean)
      .join(' ');
    labels.set(a.id, qual ? `${a.name} · ${qual}` : a.name);
  }
  // Still colliding (same institution, no last4) → append the id.
  const seen = new Map<string, number>();
  for (const l of labels.values()) seen.set(l, (seen.get(l) ?? 0) + 1);
  for (const [id, l] of labels) if ((seen.get(l) ?? 0) > 1) labels.set(id, `${l} #${id}`);
  return labels;
}

// ── Mentions bookkeeping ───────────────────────────────────────────────────

export type MentionType = 'account' | 'category' | 'merchant' | 'goal' | 'entity';

export interface MentionEntry {
  type: MentionType;
  id?: number;
  key?: string;
  label: string;
  token: string;
}

/** Drop mentions whose token no longer appears in the text; dedupe by token. */
export function pruneMentions<M extends { token: string }>(text: string, mentions: M[]): M[] {
  const seen = new Set<string>();
  const out: M[] = [];
  for (const m of mentions) {
    if (seen.has(m.token) || !containsToken(text, m.token)) continue;
    seen.add(m.token);
    out.push(m);
  }
  return out;
}

/** Token occurrence that is not just a prefix of a longer bare word. */
function containsToken(text: string, token: string): boolean {
  let from = 0;
  for (;;) {
    const i = text.indexOf(token, from);
    if (i === -1) return false;
    const after = text[i + token.length];
    if (token.endsWith(']') || after === undefined || !/[\w&'-]/.test(after)) return true;
    from = i + 1;
  }
}

/**
 * If the caret sits at the end of a known token, return that token's range so
 * Backspace can delete it atomically.
 */
export function tokenEndingAt(
  text: string,
  caret: number,
  tokens: string[],
): { start: number; end: number } | null {
  for (const t of tokens) {
    const start = caret - t.length;
    if (start >= 0 && text.slice(start, caret) === t && isMentionBoundary(text, start)) {
      return { start, end: caret };
    }
  }
  return null;
}

export type TextSegment =
  | { kind: 'text'; text: string }
  | { kind: 'mention'; text: string; label: string }
  | { kind: 'command'; text: string };

const MENTION_RE = /(^|[\s(])@(\[[^\]\n]{1,120}\]|[\w.&'-]+)/g;

/**
 * Split text into plain and mention segments. Only tokens whose label is in
 * `known` (exact match) become mentions — "@home" stays plain unless "home"
 * is a real label. A leading `/command` becomes a command segment.
 */
export function extractMentionTokens(text: string, known: Set<string>): TextSegment[] {
  const out: TextSegment[] = [];
  let body = text;
  const cmd = /^\/[a-z][\w-]*/i.exec(text);
  if (cmd) {
    out.push({ kind: 'command', text: cmd[0] });
    body = text.slice(cmd[0].length);
  }

  let pos = 0;
  const pushText = (s: string) => {
    if (!s) return;
    const last = out[out.length - 1];
    if (last && last.kind === 'text') last.text += s;
    else out.push({ kind: 'text', text: s });
  };

  MENTION_RE.lastIndex = 0;
  for (let m = MENTION_RE.exec(body); m; m = MENTION_RE.exec(body)) {
    const tokenStart = m.index + m[1].length;
    let raw = m[2];
    let label: string;
    if (raw.startsWith('[')) {
      label = raw.slice(1, -1);
    } else {
      // Trailing sentence punctuation isn't part of the label ("@Amazon.").
      label = raw;
      while (label && !known.has(label) && /[.'-]$/.test(label)) label = label.slice(0, -1);
      raw = label;
    }
    if (!known.has(label)) continue;
    pushText(body.slice(pos, tokenStart));
    const tokenText = `@${raw}`;
    out.push({ kind: 'mention', text: tokenText, label });
    pos = tokenStart + tokenText.length;
  }
  pushText(body.slice(pos));
  return out;
}

// ── Context block (server-resolved mentions persisted in the query) ────────

export const CONTEXT_BLOCK_HEADER = MENTION_BLOCK_PREFIX;

/**
 * Split a leading `[Referenced entities…]` block (up to the first blank line)
 * from the body. A leading on-device handoff block (either order, see
 * local-handoff-format.ts) is peeled too and dropped: it is never shown, and
 * `block` stays the mention block only so its lines can't leak into the labels.
 */
export function splitContextBlock(text: string): { block: string; body: string } {
  const parts = splitInjectedContext(text, HANDOFF_DETECT_STRUCTURAL);
  if (!parts.mention && !parts.handoff) return { block: '', body: text };
  const block = parts.mention.endsWith('\n\n') ? parts.mention.slice(0, -2) : parts.mention;
  return { block, body: parts.body };
}

export function stripContextBlock(text: string): string {
  return splitContextBlock(text).body;
}

/** Quoted labels from a context block's entity lines. */
export function contextBlockLabels(block: string): string[] {
  const out: string[] = [];
  for (const line of block.split('\n')) {
    const m = /^- \w+ .*?"([^"]+)"/.exec(line);
    if (m) out.push(m[1]);
  }
  return out;
}

/**
 * Mention entries from a context block, so a recalled history message keeps
 * its mentions. Tokens are rebuilt from the DB label (merchant: exact key);
 * callers prune entries whose token isn't in the text (e.g. an account whose
 * composer label was disambiguated).
 */
export function contextBlockMentions(block: string): MentionEntry[] {
  const out: MentionEntry[] = [];
  for (const line of block.split('\n')) {
    const m = /^- (account|category|merchant|goal|entity) (.*)$/.exec(line);
    if (!m) continue;
    const type = m[1] as MentionType;
    const rest = m[2];
    const label = /"([^"]+)"/.exec(rest)?.[1];
    if (!label) continue;
    if (type === 'merchant') {
      let key = label;
      const k = / key=("(?:[^"\\]|\\.)*")/.exec(rest);
      if (k) {
        try {
          key = JSON.parse(k[1]) as string;
        } catch {
          key = label;
        }
      }
      out.push({ type, key, label: key, token: formatMentionToken(key) });
      continue;
    }
    const id = Number(/\bid=(\d+)/.exec(rest)?.[1]);
    if (!Number.isInteger(id) || id <= 0) continue;
    out.push({ type, id, label, token: formatMentionToken(label) });
  }
  return out;
}

// ── Commands ───────────────────────────────────────────────────────────────

export interface ParsedCommand {
  name: string;
  rest: string;
}

/** `/name rest…` → {name (lowercased), rest (trimmed)}; null for non-slash text. */
export function parseCommand(text: string): ParsedCommand | null {
  const t = text.trimStart();
  if (!t.startsWith('/')) return null;
  const m = /^\/(\S*)\s*([\s\S]*)$/.exec(t);
  if (!m) return { name: '', rest: '' };
  return { name: m[1].toLowerCase(), rest: m[2].trim() };
}

// ── Recent mentions (localStorage; every access guarded) ───────────────────

export const RECENT_MENTIONS_KEY = 'wilson.recentMentions';
export const RECENT_MENTIONS_MAX = 5;

export interface RecentMention {
  type: MentionType;
  id?: number;
  key?: string;
  label: string;
}

export function mergeRecentMention(list: RecentMention[], m: RecentMention): RecentMention[] {
  const same = (a: RecentMention) => a.type === m.type && (a.id ?? a.key ?? a.label) === (m.id ?? m.key ?? m.label);
  return [m, ...list.filter((x) => !same(x))].slice(0, RECENT_MENTIONS_MAX);
}

export function readRecentMentions(storage: Pick<Storage, 'getItem'> | undefined): RecentMention[] {
  try {
    const raw = storage?.getItem(RECENT_MENTIONS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((x): x is RecentMention => !!x && typeof x === 'object' && typeof (x as RecentMention).label === 'string')
      .slice(0, RECENT_MENTIONS_MAX);
  } catch {
    return [];
  }
}

export function writeRecentMentions(storage: Pick<Storage, 'setItem'> | undefined, list: RecentMention[]): void {
  try {
    storage?.setItem(RECENT_MENTIONS_KEY, JSON.stringify(list.slice(0, RECENT_MENTIONS_MAX)));
  } catch {
    /* private mode / blocked storage — recents are a convenience only */
  }
}
