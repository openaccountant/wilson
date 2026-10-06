import { useEffect, useState } from 'react';
import { api } from '@/api';
import { CATEGORIZE_PROGRESS_POLL_MS, type CategorizeProgressLike } from '@/lib/categorizeProgress';

/**
 * While `active` (a /categorize request is in flight), polls the server for
 * the run's batch progress. Polling errors are swallowed — this must never
 * break chat; it stops (and clears) as soon as the request settles.
 */
export function useCategorizeProgress(active: boolean): CategorizeProgressLike | null {
  const [progress, setProgress] = useState<CategorizeProgressLike | null>(null);

  useEffect(() => {
    if (!active) {
      setProgress(null);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const res = await api<{ progress?: CategorizeProgressLike | null }>('/api/chat/progress');
        if (!cancelled) setProgress(res?.progress ?? null);
      } catch {
        // Swallow: offline, auth, or server hiccup — the chat request decides.
      }
      if (!cancelled) timer = setTimeout(poll, CATEGORIZE_PROGRESS_POLL_MS);
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [active]);

  return progress;
}
