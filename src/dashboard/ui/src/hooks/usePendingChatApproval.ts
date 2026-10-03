import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/api';
import {
  CHAT_APPROVAL_POLL_MS,
  pickPendingChatOperation,
  type ChatOperationLike,
} from '@/lib/chatApproval';

export type ChatApprovalDecision = 'approve' | 'reject';

/**
 * While `active` (a server /api/chat request is in flight), polls the shared
 * confirmation queue for a chat-originated approval and exposes it plus a
 * `respond` action. Polling errors are swallowed — this must never break chat.
 */
export function usePendingChatApproval(active: boolean) {
  const [operation, setOperation] = useState<ChatOperationLike | null>(null);
  const [responding, setResponding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dismissed = useRef(new Set<string>());

  useEffect(() => {
    if (!active) {
      setOperation(null);
      setError(null);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const res = await api<{ operations?: ChatOperationLike[] }>('/api/mcp/operations');
        if (!cancelled) {
          const next = pickPendingChatOperation(res?.operations, dismissed.current);
          // Keep the same object while the id is unchanged → no re-render churn.
          setOperation((prev) => (prev?.id === next?.id ? prev : next));
        }
      } catch {
        // Swallow: offline, auth, or server hiccup — the chat request decides.
      }
      if (!cancelled) timer = setTimeout(poll, CHAT_APPROVAL_POLL_MS);
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [active]);

  const respond = useCallback(
    async (decision: ChatApprovalDecision) => {
      const op = operation;
      if (!op || responding) return;
      setResponding(true);
      setError(null);
      try {
        await api(`/api/mcp/operations/${encodeURIComponent(op.id)}/${decision}`, { method: 'POST' });
        dismissed.current.add(op.id);
        setOperation((prev) => (prev?.id === op.id ? null : prev));
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not send your answer');
      } finally {
        setResponding(false);
      }
    },
    [operation, responding],
  );

  return { operation, responding, error, respond };
}
