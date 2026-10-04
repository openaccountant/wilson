import { useEffect, useState } from 'react';
import { useApi } from '@/hooks/useApi';
import { agentErrorMessage, agentSessionInit, onAgentStateChanged } from '@/lib/agent-api';
import type { AgentState } from '@agent-access-model';

const POLL_MS = 5000;

/**
 * The one agent-access snapshot (`GET /api/mcp/state`), the same one the bridge's floating panel renders.
 * Refetched every 5 s while the page is visible, at once when the bridge or another tab says something
 * changed, and by `refresh()` after this surface changes something itself.
 */
export function useAgentState() {
  const { data, error, refetch } = useApi<AgentState>('/api/mcp/state', [], agentSessionInit());
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const poll = setInterval(() => {
      if (document.visibilityState === 'visible') {
        refetch();
        setNow(Date.now());
      }
    }, POLL_MS);
    const stop = onAgentStateChanged(refetch, 'settings');
    const onVisible = () => {
      if (document.visibilityState === 'visible') refetch();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(poll);
      stop();
      document.removeEventListener('visibilitychange', onVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { state: data, error: error ? agentErrorMessage(new Error(error)) : null, refresh: refetch, now };
}
