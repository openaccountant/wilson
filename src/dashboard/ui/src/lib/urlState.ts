/**
 * Dashboard URL hash state — pure parse/serialize, no DOM access.
 *
 * Format: `#<tab>?k=v&k=v` (a query string *inside* the fragment, so the
 * server never sees it and a reload/bookmark restores the view).
 *
 * Canonical form:
 *   - keys are written in KEY_ORDER, then any unknown keys in the order they
 *     were read (unknown keys round-trip untouched so newer links survive an
 *     older build);
 *   - defaults are omitted (preset=month, no start/end, no filters) — so a
 *     bookmarked "this month" is just `#overview` and stays live;
 *   - values are `encodeURIComponent`-encoded;
 *   - `end` is only meaningful (and only written) for preset=custom.
 *
 * Legacy links (`#settings`, `#/settings`, empty hash) parse to a tab with
 * every key at its default. An unknown tab falls back to `overview`.
 *
 * This module is imported by bun tests from the repo root, so it must not
 * use the UI's `@/` path alias or touch `window`.
 */

// The one tab list lives in webmcp-session.ts (itself import-free). A relative path, not an alias, so bun tests
// resolve it too.
import { TAB_IDS } from '../../../webmcp-session.js';
export { TAB_IDS };

export type UrlTab = (typeof TAB_IDS)[number];

export const PRESETS = ['month', 'quarter', 'ytd', 'year', 'prev-year', 'custom'] as const;
export type UrlPreset = (typeof PRESETS)[number];

export const COMPARE_MODES = ['prev', 'yoy'] as const;
export type UrlCompare = (typeof COMPARE_MODES)[number];

export interface UrlState {
  tab: UrlTab;
  /** Date preset. `month` is the default and is omitted from the URL. */
  preset: UrlPreset;
  /**
   * YYYY-MM-DD. For custom: the range start. For month/quarter/year: an
   * anchor inside the period (null = the current period, kept live). Ignored
   * for ytd / prev-year, which are always relative to today.
   */
  start: string | null;
  /** YYYY-MM-DD, custom only. */
  end: string | null;
  account: number | null;
  entity: number | null;
  cat: string | null;
  /** Overview day-detail dialog (YYYY-MM-DD). */
  day: string | null;
  cmp: UrlCompare | null;
  // ── Reserved for Batch 2 (parsed + preserved, unused by this build) ──
  by: string | null;
  merchant: string | null;
  txn: string | null;
  q: string | null;
  /** Chat tab: the active chat session id (a server-issued UUID). */
  session: string | null;
  /** Unknown keys, preserved verbatim (decoded) in first-seen order. */
  extra: Array<[string, string]>;
}

/** Canonical serialization order for known keys. */
export const KEY_ORDER = [
  'preset',
  'start',
  'end',
  'account',
  'entity',
  'cat',
  'day',
  'cmp',
  'by',
  'merchant',
  'txn',
  'q',
  'session',
] as const;

type KnownKey = (typeof KEY_ORDER)[number];

/**
 * Keys that describe the *view* across every tab (date range + header
 * filters + comparison). They survive tab switches. Everything else known
 * (`day`, and the Batch 2 drill-down keys) is tab-scoped and dropped when the
 * tab changes. Unknown keys are kept — we can't know their scope.
 */
export const GLOBAL_KEYS: readonly KnownKey[] = ['preset', 'start', 'end', 'account', 'entity', 'cat', 'cmp'];

/**
 * Keys whose values only mean something inside one profile's database: ids,
 * labels and the drill's merchant key / transaction id / grouping.
 */
export const PROFILE_SCOPED_KEYS: readonly KnownKey[] = ['account', 'entity', 'cat', 'day', 'merchant', 'txn', 'by', 'session'];

export const DEFAULT_URL_STATE: UrlState = Object.freeze({
  tab: 'overview',
  preset: 'month',
  start: null,
  end: null,
  account: null,
  entity: null,
  cat: null,
  day: null,
  cmp: null,
  by: null,
  merchant: null,
  txn: null,
  q: null,
  session: null,
  extra: [],
}) as UrlState;

export function defaultUrlState(tab: UrlTab = 'overview'): UrlState {
  return { ...DEFAULT_URL_STATE, tab, extra: [] };
}

const KNOWN_KEYS = new Set<string>(KEY_ORDER);

export function isTab(v: string): v is UrlTab {
  return (TAB_IDS as readonly string[]).includes(v);
}

function isPreset(v: string): v is UrlPreset {
  return (PRESETS as readonly string[]).includes(v);
}

function isCompare(v: string): v is UrlCompare {
  return (COMPARE_MODES as readonly string[]).includes(v);
}

/** Strict YYYY-MM-DD that names a real calendar day. */
export function isIsoDate(v: string | null | undefined): v is string {
  if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const [y, m, d] = v.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

/** Chat session ids are UUIDs; accept any URL-safe token, nothing that could escape a path. */
export function isSessionId(v: string | null | undefined): v is string {
  return !!v && /^[A-Za-z0-9_-]{1,64}$/.test(v);
}

function parseId(v: string): number | null {
  if (!/^\d+$/.test(v)) return null;
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : null;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    // Malformed escape (e.g. a lone '%'): keep the raw text rather than
    // dropping the whole link.
    return s;
  }
}

/**
 * Parse a location hash (with or without the leading '#'). Never throws;
 * invalid values fall back to their defaults.
 */
export function parseHash(hash: string): UrlState {
  let raw = hash.startsWith('#') ? hash.slice(1) : hash;
  // The pre-React dashboard used '#/tab'.
  if (raw.startsWith('/')) raw = raw.slice(1);

  const qIdx = raw.indexOf('?');
  const tabPart = safeDecode(qIdx === -1 ? raw : raw.slice(0, qIdx)).trim().toLowerCase();
  const query = qIdx === -1 ? '' : raw.slice(qIdx + 1);

  const state = defaultUrlState(isTab(tabPart) ? tabPart : 'overview');
  const seen = new Set<string>();

  for (const pair of query.split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const key = safeDecode(eq === -1 ? pair : pair.slice(0, eq));
    const value = eq === -1 ? '' : safeDecode(pair.slice(eq + 1));
    if (!key) continue;

    if (!KNOWN_KEYS.has(key)) {
      if (!state.extra.some(([k]) => k === key)) state.extra.push([key, value]);
      continue;
    }
    // First occurrence wins for known keys (matches URLSearchParams.get).
    if (seen.has(key)) continue;
    seen.add(key);
    applyKnown(state, key as KnownKey, value);
  }

  return normalize(state);
}

function applyKnown(state: UrlState, key: KnownKey, value: string): void {
  switch (key) {
    case 'preset':
      if (isPreset(value)) state.preset = value;
      return;
    case 'start':
      if (isIsoDate(value)) state.start = value;
      return;
    case 'end':
      if (isIsoDate(value)) state.end = value;
      return;
    case 'account':
      state.account = parseId(value);
      return;
    case 'entity':
      state.entity = parseId(value);
      return;
    case 'day':
      if (isIsoDate(value)) state.day = value;
      return;
    case 'cmp':
      if (isCompare(value)) state.cmp = value;
      return;
    case 'session':
      if (isSessionId(value)) state.session = value;
      return;
    case 'cat':
    case 'by':
    case 'merchant':
    case 'txn':
    case 'q':
      state[key] = value === '' ? null : value;
      return;
  }
}

/**
 * Enforce the date invariants:
 *   - custom needs both ends (a lone one becomes a single-day range; neither
 *     falls back to the current month), swapped if reversed;
 *   - non-custom presets never carry `end`; ytd / prev-year never carry
 *     `start` (they are always relative to today).
 */
export function normalize(state: UrlState): UrlState {
  const s = { ...state, extra: [...state.extra] };
  if (s.preset === 'custom') {
    if (!s.start && !s.end) {
      s.preset = 'month';
    } else {
      s.start ??= s.end;
      s.end ??= s.start;
      if (s.start! > s.end!) [s.start, s.end] = [s.end, s.start];
    }
  } else {
    s.end = null;
    if (s.preset === 'ytd' || s.preset === 'prev-year') s.start = null;
  }
  return s;
}

function stringValue(state: UrlState, key: KnownKey): string | null {
  const v = state[key];
  if (v == null) return null;
  if (key === 'preset' && v === 'month') return null;
  if (typeof v === 'string' && v === '') return null;
  return String(v);
}

/** Serialize to the canonical `#tab?k=v` form (always starts with '#'). */
export function serializeHash(input: UrlState): string {
  const state = normalize(input);
  const parts: string[] = [];
  for (const key of KEY_ORDER) {
    const v = stringValue(state, key);
    if (v != null) parts.push(`${key}=${encodeURIComponent(v)}`);
  }
  for (const [k, v] of state.extra) {
    if (KNOWN_KEYS.has(k) || !k) continue;
    parts.push(v === '' ? encodeURIComponent(k) : `${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  }
  const tab = isTab(state.tab) ? state.tab : 'overview';
  return parts.length ? `#${tab}?${parts.join('&')}` : `#${tab}`;
}

/** Switch tabs, keeping global keys (and unknown keys), dropping tab-scoped ones. */
export function withTab(state: UrlState, tab: string): UrlState {
  const next = defaultUrlState(isTab(tab) ? tab : 'overview');
  for (const key of GLOBAL_KEYS) (next as unknown as Record<string, unknown>)[key] = state[key];
  next.extra = [...state.extra];
  return normalize(next);
}

/** Set (or clear, with null) the chat session id. An invalid id clears it. */
export function withSession(state: UrlState, id: string | null): UrlState {
  return { ...state, extra: [...state.extra], session: isSessionId(id) ? id : null };
}

/** Drop keys that reference rows in the current profile's database. */
export function stripProfileScoped(state: UrlState): UrlState {
  const next = { ...state, extra: [...state.extra] };
  for (const key of PROFILE_SCOPED_KEYS) (next as unknown as Record<string, unknown>)[key] = null;
  return next;
}

/** The current profile's known ids; `null` = not loaded (never prunes that key). */
export interface KnownProfileIds {
  accounts: readonly number[] | null;
  entities: readonly number[] | null;
}

/**
 * Drop `account` / `entity` values that don't exist in the current profile.
 * Robust to any history entry: an entry pushed before a profile switch still
 * carries the old profile's ids, and Back restores it without a reload. A key
 * whose list is `null` (still loading, or the fetch failed) is left alone.
 * Returns the SAME object when nothing changes.
 */
export function pruneUnknownIds(state: UrlState, known: KnownProfileIds): UrlState {
  const dropAccount = state.account != null && known.accounts != null && !known.accounts.includes(state.account);
  const dropEntity = state.entity != null && known.entities != null && !known.entities.includes(state.entity);
  if (!dropAccount && !dropEntity) return state;
  return {
    ...state,
    extra: [...state.extra],
    account: dropAccount ? null : state.account,
    entity: dropEntity ? null : state.entity,
  };
}
