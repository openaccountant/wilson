/**
 * Browser-history side of the URL hash state: read the live location, write
 * canonical hashes with push/replace, and notify subscribers.
 *
 * Kept out of the React hook (and free of the `@/` alias) so bun tests can
 * drive it against a fake `window`.
 */
import {
  parseHash,
  pruneUnknownIds,
  serializeHash,
  stripProfileScoped,
  withTab,
  type KnownProfileIds,
  type UrlState,
} from './urlState';
import { pushedHistoryState } from './drill';

export type NavigateMode = 'push' | 'replace';
export type UrlUpdate = UrlState | ((current: UrlState) => UrlState);

/**
 * history.pushState/replaceState don't fire hashchange, so writes announce
 * themselves on this event; subscribers also listen to hashchange (typed
 * URLs, legacy `location.hash =`) and popstate (Back/Forward).
 */
export const URL_STATE_EVENT = 'wilson:url-state';

export function subscribeUrl(onChange: () => void): () => void {
  window.addEventListener('hashchange', onChange);
  window.addEventListener('popstate', onChange);
  window.addEventListener(URL_STATE_EVENT, onChange);
  return () => {
    window.removeEventListener('hashchange', onChange);
    window.removeEventListener('popstate', onChange);
    window.removeEventListener(URL_STATE_EVENT, onChange);
  };
}

/** The raw hash — a primitive snapshot for useSyncExternalStore. */
export function getHashSnapshot(): string {
  return window.location.hash;
}

/** The current URL state, parsed fresh from the live location (never cached). */
export function readUrlState(): UrlState {
  return parseHash(window.location.hash);
}

function urlWithHash(hash: string): string {
  return `${window.location.pathname}${window.location.search}${hash}`;
}

/**
 * Write a hash and notify subscribers. `state` (when given) becomes the
 * entry's history.state; otherwise the current entry's state carries over.
 */
export function writeHash(hash: string, mode: NavigateMode, state?: unknown): void {
  const next = state === undefined ? window.history.state : state;
  if (mode === 'push') window.history.pushState(next, '', urlWithHash(hash));
  else window.history.replaceState(next, '', urlWithHash(hash));
  window.dispatchEvent(new Event(URL_STATE_EVENT));
}

/**
 * Navigate to a new URL state. Updaters receive the state parsed from the
 * live location at call time, so callers never act on a stale closure. A
 * no-op when the canonical hash wouldn't change, which keeps history clean
 * and makes StrictMode's doubled effects harmless.
 */
export function navigateUrl(
  update: UrlUpdate,
  opts: { mode?: NavigateMode; pushState?: (prev: unknown) => unknown } = {},
): void {
  const current = readUrlState();
  const next = typeof update === 'function' ? update(current) : update;
  const hash = serializeHash(next);
  if (hash === window.location.hash) return;
  // A push that only canonicalizes the current entry would make Back look
  // broken (two entries, same view); treat it as a replace.
  const mode = opts.mode === 'push' && hash !== serializeHash(current) ? 'push' : 'replace';
  // `pushState` derives a PUSHED entry's history.state (e.g. the drill's
  // drawer marker); replaces keep the entry's own state.
  // Every other push starts clean of the drawer marker, which belongs to one
  // entry only.
  const prev = window.history.state;
  writeHash(hash, mode, mode === 'push' ? (opts.pushState ? opts.pushState(prev) : pushedHistoryState(prev, null)) : undefined);
}

/** Switch tabs (a new history entry), keeping the global date/filter keys. */
export function navigateToTab(tab: string): void {
  navigateUrl((s) => withTab(s, tab), { mode: 'push' });
}

/**
 * Drop account/entity ids the current profile doesn't have, in place
 * (replaceState — never a new entry). Runs on load and whenever the URL or the
 * profile's lists change, so it covers every history entry, including ones
 * pushed before a profile switch that reloadForProfileSwitch's strip (which
 * only rewrites the current entry) can't reach.
 */
export function dropUnknownProfileIds(known: KnownProfileIds): void {
  const current = readUrlState();
  const next = pruneUnknownIds(current, known);
  if (next === current) return;
  navigateUrl(next, { mode: 'replace' });
}

/**
 * Reload after a profile switch. Account/entity/category/day and drill
 * (merchant/txn/by) values belong to the old profile's database, so drop them
 * first — with replaceState, so the old-profile URL isn't one Back press away.
 */
export function reloadForProfileSwitch(): void {
  const hash = serializeHash(stripProfileScoped(readUrlState()));
  if (window.location.hash && hash !== window.location.hash) {
    window.history.replaceState(window.history.state, '', urlWithHash(hash));
  }
  window.location.reload();
}
