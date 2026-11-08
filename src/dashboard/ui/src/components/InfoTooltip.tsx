import { useCallback, useEffect, useId, useLayoutEffect, useReducer, useRef, useState, type ReactNode } from 'react';
import { TOOLTIP_CLOSED, TOOLTIP_CLOSE_DELAY_MS, TOOLTIP_WIDTH, placeTooltip, tooltipOpen, tooltipReduce } from '@/lib/tooltipState';

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
  const bubbleRef = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const touching = useRef(false);

  const cancelClose = useCallback(() => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = null;
  }, []);
  const hoverIn = useCallback(() => {
    cancelClose();
    dispatch('hover-in');
  }, [cancelClose]);
  // Delayed so the pointer can cross the gap onto the bubble; entering the
  // bubble (a DOM child of the trigger) re-fires pointerenter and cancels it.
  const hoverOut = useCallback(() => {
    cancelClose();
    closeTimer.current = setTimeout(() => dispatch('hover-out'), TOOLTIP_CLOSE_DELAY_MS);
  }, [cancelClose]);
  useEffect(() => cancelClose, [cancelClose]);

  // Place from the trigger's live rect; redo on scroll (capture, so scrolling
  // the Review list's overflow container counts) and resize while open.
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      if (!ref.current) return;
      const b = bubbleRef.current;
      const p = placeTooltip(
        ref.current.getBoundingClientRect(),
        { width: TOOLTIP_WIDTH, height: b?.offsetHeight ?? 0 },
        { width: window.innerWidth, height: window.innerHeight },
      );
      setPos((prev) => (prev && prev.left === p.left && prev.top === p.top ? prev : { left: p.left, top: p.top }));
    };
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [open, text]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) dispatch('outside');
    };
    // Escape must dismiss a hover-opened tooltip too, where focus is elsewhere.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') dispatch('escape');
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Mouse hover is handled by enter/leave; touch and pen taps by click. A
  // touch tap also fires emulated mouse events, so gate hover on pointerType.
  const lastType = useRef('mouse');
  const onPointerEnter = useCallback((e: React.PointerEvent) => {
    lastType.current = e.pointerType;
    if (e.pointerType === 'mouse') hoverIn();
  }, [hoverIn]);

  return (
    <span
      ref={ref}
      tabIndex={0}
      aria-describedby={id}
      className={`relative outline-none focus-visible:ring-1 focus-visible:ring-green ${className}`}
      onPointerEnter={onPointerEnter}
      onPointerLeave={(e) => e.pointerType === 'mouse' && hoverOut()}
      onPointerDown={(e) => {
        lastType.current = e.pointerType;
        touching.current = e.pointerType !== 'mouse';
      }}
      onClick={() => {
        touching.current = false;
        if (lastType.current !== 'mouse') dispatch('tap');
      }}
      // A touch tap focuses the span too; that focus must not hold it open
      // after a second tap, so it is ignored (the tap itself pins it).
      onFocus={() => !touching.current && dispatch('focus')}
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
        ref={bubbleRef}
        role="tooltip"
        hidden={!open}
        data-testid="info-tooltip"
        style={{ ...(pos ? { left: pos.left, top: pos.top } : null), width: TOOLTIP_WIDTH }}
        className="fixed z-50 w-64 whitespace-normal normal-case tracking-normal font-sans bg-surface border border-border rounded-md px-2.5 py-1.5 text-xs text-text-secondary shadow-lg"
      >
        {text}
      </span>
    </span>
  );
}
