import { useEffect, useRef, useState } from 'react';
import { holdProgress } from '@confirmation-card';

/**
 * Approve is the card's hardest control: it enables after 800 ms, reacts only to a trusted (real) pointer or key
 * event, and must be held for 600 ms with a visible fill. The server also refuses an approval younger than 1 s.
 */
export function HoldToApprove({
  label,
  holdMs,
  enableAfterMs,
  tone,
  onConfirmed,
}: {
  label: string;
  holdMs: number;
  enableAfterMs: number;
  tone: 'green' | 'amber';
  onConfirmed: () => void;
}) {
  const [armed, setArmed] = useState(false);
  const [progress, setProgress] = useState(0);
  const [note, setNote] = useState('');
  const hold = useRef<{ startedAt: number; timer: ReturnType<typeof setTimeout> | null } | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setArmed(true), enableAfterMs);
    return () => clearTimeout(t);
  }, [enableAfterMs]);

  useEffect(
    () => () => {
      if (hold.current?.timer) clearTimeout(hold.current.timer);
    },
    [],
  );

  function stop() {
    if (hold.current?.timer) clearTimeout(hold.current.timer);
    hold.current = null;
    setProgress(0);
  }

  function step(startedAt: number) {
    const p = holdProgress(startedAt, Date.now(), holdMs);
    setProgress(p);
    if (p >= 1) {
      hold.current = null;
      onConfirmed();
      return;
    }
    if (hold.current) hold.current.timer = setTimeout(() => step(startedAt), 30);
  }

  function start(native: Event) {
    if (!armed || hold.current) return;
    if (!native.isTrusted) {
      setNote('Approval needs a real click or key press.');
      return;
    }
    setNote('');
    hold.current = { startedAt: Date.now(), timer: null };
    step(hold.current.startedAt);
  }

  const color = tone === 'amber' ? 'border-yellow text-yellow' : 'border-green text-green';
  const fill = tone === 'amber' ? 'bg-yellow/20' : 'bg-green/20';

  return (
    <div className="flex-1">
      <button
        disabled={!armed}
        onPointerDown={(e) => start(e.nativeEvent)}
        onPointerUp={stop}
        onPointerLeave={stop}
        onPointerCancel={stop}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && !e.repeat && start(e.nativeEvent)}
        onKeyUp={stop}
        className={`relative overflow-hidden w-full px-3 py-2 rounded border bg-transparent text-xs font-semibold cursor-pointer disabled:opacity-50 disabled:cursor-default ${color}`}
      >
        <span className={`absolute inset-y-0 left-0 ${fill}`} style={{ width: `${Math.round(progress * 100)}%` }} />
        <span className="relative">{!armed ? 'Read the card…' : progress > 0 ? 'Keep holding…' : label}</span>
      </button>
      {note && <div className="text-xs text-yellow mt-1">{note}</div>}
    </div>
  );
}
