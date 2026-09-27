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

export function useApi<T>(path: string, deps: unknown[] = []): UseApiResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setOffline(false);

    api<T>(path)
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