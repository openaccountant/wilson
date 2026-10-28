import { useCallback, useEffect, useId, useLayoutEffect, useReducer, useRef, useState, type ReactNode } from 'react';
import { TOOLTIP_CLOSED, tooltipOpen, tooltipReduce } from '@/lib/tooltipState';

/**
 * Wraps an inline trigger with a real tooltip: opens instantly on hover and on
 * keyboard focus, toggles on tap (touch), closes on Escape or an outside
 * press. The trigger is focusable and points at the bubble with
 * aria-describedby, so the text reaches keyboard and screen-reader users and
 * shows up in recordings (a native `title` does none of these).
 *
 * The bubble is position:fixed from the trigger's rect so table-cell overflow
 * cannot clip it. Surface tokens match ChartTooltip.
 */
export function InfoTooltip({
  text,
  children,
  className = '',
  ...rest
}: {
  text: string;
  children: ReactNode;
  className?: string;
} & Record<`data-${string}`, string | undefined>) {
  const id = useId();
  const [state, dispatch] = useReducer(tooltipReduce, TOOLTIP_CLOSED);
  const open = tooltipOpen(state);
  const ref = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (!open || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    setPos({ left: r.left + r.width / 2, top: r.bottom + 6 });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) dispatch('outside');
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);

  // Mouse hover is handled by enter/leave; touch and pen taps by click. A
  // touch tap also fires emulated mouse events, so gate hover on pointerType.
  const lastType = useRef('mouse');
  const onPointerEnter = useCallback((e: React.PointerEvent) => {
    lastType.current = e.pointerType;
    if (e.pointerType === 'mouse') dispatch('hover-in');
  }, []);

  return (
    <span
      ref={ref}
      tabIndex={0}
      aria-describedby={id}
      className={`relative outline-none focus-visible:ring-1 focus-visible:ring-green ${className}`}
      onPointerEnter={onPointerEnter}
      onPointerLeave={(e) => e.pointerType === 'mouse' && dispatch('hover-out')}
      onPointerDown={(e) => {
        lastType.current = e.pointerType;
      }}
      onClick={() => lastType.current !== 'mouse' && dispatch('tap')}
      onFocus={() => dispatch('focus')}
      onBlur={() => dispatch('blur')}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && open) {
          e.stopPropagation();
          dispatch('escape');
        }
      }}
      {...rest}
    >
      {children}
      <span
        id={id}
        role="tooltip"
        hidden={!open}
        data-testid="info-tooltip"
        style={pos ? { left: pos.left, top: pos.top } : undefined}
        className="fixed z-50 -translate-x-1/2 w-64 whitespace-normal normal-case tracking-normal font-sans bg-surface border border-border rounded-md px-2.5 py-1.5 text-xs text-text-secondary shadow-lg"
      >
        {text}
      </span>
    </span>
  );
}
