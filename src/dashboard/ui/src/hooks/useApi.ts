import { useState, useEffect } from 'react';
import { api } from '@/api';
import { isRequiresConnectionError } from '@/store/offline-writes';

interface UseApiResult<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  /** True when the last fetch failed because the server is unreachable and the mirror cannot serve the path. */
  offline: boolean;
  refetch: () => void;
}

/**
 * Fetch `path` (re-fetching when it or `deps` change). A `null` path skips the
 * request entirely — for queries that only make sense once some input exists.
 *
 * `init` is passed to every request (headers, mostly). It is read when the effect runs, not tracked as a
 * dependency: change `path` or `deps` to refetch.
 */
export function useApi<T>(path: string | null, deps: unknown[] = [], init?: RequestInit): UseApiResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setOffline(false);
    if (path === null) {
      setData(null);
      setLoading(false);
      return;
    }
    setLoading(true);

    api<T>(path, init)
      .then((result) => {
        if (!cancelled) {
          setData(result);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          // The seam's explicit signal: this path needs the server (either a
          // write, or an unmirrored read like the alerts engine).
          setOffline(isRequiresConnectionError(err));
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, tick, ...deps]);

  return { data, loading, error, offline, refetch: () => setTick((t) => t + 1) };
}