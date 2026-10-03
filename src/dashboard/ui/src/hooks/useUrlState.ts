import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { parseHash, serializeHash } from '@/lib/urlState';
import { getHashSnapshot, navigateUrl, subscribeUrl, writeHash } from '@/lib/urlHistory';

export {
  dropUnknownProfileIds,
  navigateToTab,
  navigateUrl,
  readUrlState,
  reloadForProfileSwitch,
  type NavigateMode,
  type UrlUpdate,
} from '@/lib/urlHistory';

const getServerSnapshot = () => '';

// Hash we last canonicalized to; if the browser re-encodes our canonical form
// differently we must not fight it in a loop.
let lastCanonicalized: string | null = null;

/**
 * The dashboard's URL hash state (lib/urlState.ts). Re-renders on hashchange,
 * popstate and our own push/replace writes. `navigate` is a stable module
 * function — updaters read the live URL, so there are no stale closures.
 *
 * History model (deliberate design):
 *   - Filter tweaks (date preset/range, account, category, entity, cmp)
 *     REPLACE the current entry — `{ mode: 'replace' }` — so fiddling with
 *     filters never floods history.
 *   - Tab switches PUSH a new entry (navigateToTab), carrying the global keys.
 *   - So Back restores the previous TAB with the filters it had when you left
 *     it — not each intermediate filter value. Filters changed after a tab
 *     switch belong to the new entry only.
 *   - Profile-scoped ids (account/entity) are validated against the current
 *     profile's lists on every load and URL change (dropUnknownProfileIds), so
 *     an entry from before a profile switch can't apply another profile's ids.
 */
export function useUrlState() {
  // The raw hash string is the snapshot: a primitive, so React re-renders
  // only when the URL actually changes.
  const hash = useSyncExternalStore(subscribeUrl, getHashSnapshot, getServerSnapshot);
  const state = useMemo(() => parseHash(hash), [hash]);

  // Rewrite a non-canonical hash in place (reversed custom range, legacy
  // '#/tab', junk values) so what's bookmarked is what's shown. An empty hash
  // is left alone. Idempotent, so StrictMode's doubled effect is a no-op.
  useEffect(() => {
    if (!hash || hash === lastCanonicalized) return;
    const canonical = serializeHash(state);
    if (canonical !== hash) {
      writeHash(canonical, 'replace');
      lastCanonicalized = window.location.hash;
    }
  }, [hash, state]);

  return { state, navigate: navigateUrl };
}
