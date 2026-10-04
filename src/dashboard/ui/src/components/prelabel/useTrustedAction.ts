import { useCallback, useEffect, useMemo, useState, type MouseEvent } from 'react';
import { createTrustedAction, TRUSTED_ACTION_DELAY_MS } from './trusted-action-core';

/**
 * React binding for trusted-action-core. The returned `onClick` ignores a
 * scripted click (`isTrusted === false`) and any click earlier than 800 ms
 * after mount. `enabled` flips true when the delay ends, so the button can be
 * greyed out meanwhile. Logic lives in the core; this only wires the timer.
 */
export function useTrustedAction(action: () => void): { enabled: boolean; onClick: (ev: MouseEvent) => void } {
  const core = useMemo(() => createTrustedAction({ now: () => performance.now() }), []);
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    core.arm();
    setEnabled(false);
    const t = setTimeout(() => setEnabled(true), TRUSTED_ACTION_DELAY_MS);
    return () => {
      clearTimeout(t);
      core.disarm();
    };
  }, [core]);

  const onClick = useCallback(
    (ev: MouseEvent) => {
      if (core.accepts({ isTrusted: ev.nativeEvent.isTrusted })) action();
    },
    [core, action],
  );

  return { enabled, onClick };
}
