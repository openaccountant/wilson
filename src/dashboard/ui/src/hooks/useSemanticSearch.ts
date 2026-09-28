import { useState, useEffect } from 'react';
import { api } from '@/api';
import type { SemanticSearchResponse } from '@/types';

interface UseSemanticSearchResult {
  data: SemanticSearchResponse | null;
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

const DEBOUNCE_MS = 300;

/**
 * Debounced fetch for the Transactions semantic-search fallback.
 *
 * `path === null` means the fallback is inactive (substring matching is
 * handling the query) — nothing is fetched and `loading` settles to false.
 * While active, fetches are debounced so typing never fires per-keystroke
 * requests; the stale-response pattern from useApi (a `cancelled` flag in the
 * effect cleanup) drops out-of-order responses.
 */
export function useSemanticSearch(
  path: string | null,
  deps: unknown[] = []
): UseSemanticSearchResult {
  const [data, setData] = useState<SemanticSearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (path === null) {
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    const timer = setTimeout(() => {
      api<SemanticSearchResponse>(path)
        .then((result) => {
          if (!cancelled) {
            setData(result);
            setLoading(false);
          }
        })
        .catch((err) => {
          if (!cancelled) {
            setError(err instanceof Error ? err.message : String(err));
            setLoading(false);
          }
        });
    }, DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, tick, ...deps]);

  return { data, loading, error, refetch: () => setTick((t) => t + 1) };
}