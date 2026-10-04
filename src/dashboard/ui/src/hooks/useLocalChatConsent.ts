import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/api';
import type { LocalChatConfigResponse } from '@/hybrid/client';
import {
  hasLocalChatOptIn,
  localChatPanelKind,
  setLocalChatOptIn,
  type LocalChatPanelKind,
} from '@/hybrid/consent';

/**
 * On-device chat consent, mirroring the open-jev pre-labeler: the server's
 * `localChatEnabled` setting (admin-only when auth is on, off by default) plus
 * this browser's "Download once" opt-in (consent.ts). ChatTab attempts a local
 * answer only while `isActive()` is true.
 */
export interface UseLocalChatConsentResult {
  kind: LocalChatPanelKind;
  config: LocalChatConfigResponse | null;
  /** Always-current "may attempt local", for send closures where `kind` can be stale. */
  isActive(): boolean;
  /** Admin: PUT localChatEnabled=true. Never rejects; a failure sets `error`. */
  turnOn(): Promise<void>;
  /** This browser agrees to the one-time download. */
  consent(): void;
  /** Admin: off for the profile; anyone: off in this browser. Never rejects. */
  turnOff(): Promise<void>;
  busy: boolean;
  error: string | null;
}

function hasWebGpu(): boolean {
  try {
    return typeof navigator !== 'undefined' && 'gpu' in navigator && Boolean((navigator as { gpu?: unknown }).gpu);
  } catch {
    return false;
  }
}

function describeError(err: unknown, action: 'on' | 'off'): string {
  const text = err instanceof Error ? err.message : '';
  const status = /^API (\d{3})\b/.exec(text)?.[1];
  if (status === '403') {
    if (/origin_required|origin_denied/.test(text)) {
      return 'The change was refused because it did not come from the dashboard page itself. Open the dashboard at its own address and try again.';
    }
    return `Only an admin can turn on-device chat ${action}.`;
  }
  return `Could not turn on-device chat ${action}${status ? ` (server answered ${status})` : ''}. Try again.`;
}

export function useLocalChatConsent(canAct: boolean, onRevoke?: () => void): UseLocalChatConsentResult {
  const [config, setConfig] = useState<LocalChatConfigResponse | null>(null);
  const [optedIn, setOptedIn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const adopt = useCallback((cfg: LocalChatConfigResponse | null) => {
    setConfig(cfg);
    setOptedIn(cfg ? hasLocalChatOptIn(cfg.repo) : false);
  }, []);

  useEffect(() => {
    let alive = true;
    api<LocalChatConfigResponse>('/api/config/local-chat')
      .then((cfg) => alive && adopt(cfg))
      .catch(() => alive && adopt(null));
    return () => {
      alive = false;
    };
  }, [adopt]);

  const kind = localChatPanelKind({ config, optedIn, canAct, webgpu: hasWebGpu() });
  const activeRef = useRef(false);
  activeRef.current = kind === 'on';

  const put = useCallback(
    async (enabled: boolean): Promise<boolean> => {
      setBusy(true);
      setError(null);
      try {
        adopt(await api<LocalChatConfigResponse>('/api/config/local-chat', { method: 'PUT', body: JSON.stringify({ enabled }) }));
        return true;
      } catch (err) {
        setError(describeError(err, enabled ? 'on' : 'off'));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [adopt],
  );

  const turnOn = useCallback(async () => {
    await put(true);
  }, [put]);

  const consent = useCallback(() => {
    if (!config) return;
    setLocalChatOptIn(config.repo, true);
    setOptedIn(hasLocalChatOptIn(config.repo));
  }, [config]);

  const turnOff = useCallback(async () => {
    // Local attempts stop first, whatever the server answers.
    if (config) setLocalChatOptIn(config.repo, false);
    setOptedIn(false);
    activeRef.current = false;
    onRevoke?.();
    if (canAct) await put(false);
  }, [config, canAct, put, onRevoke]);

  const isActive = useCallback(() => activeRef.current, []);

  return { kind, config, isActive, turnOn, consent, turnOff, busy, error };
}
