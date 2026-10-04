import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { rovingIndex } from '@/lib/drill';

/**
 * Roving tabindex for a list of focusable items: one tab stop, Up/Down (or
 * Left/Right for a horizontal group), Home/End. Alt+Arrow is left alone so
 * the drill's Alt+Up "up one level" shortcut can bubble.
 */
export function useRovingList(count: number, orientation: 'vertical' | 'horizontal' = 'vertical') {
  const [active, setActive] = useState(0);
  const refs = useRef<Array<HTMLElement | null>>([]);

  useEffect(() => {
    if (active > 0 && active >= count) setActive(Math.max(0, count - 1));
  }, [active, count]);

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLElement>, index: number) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      let key = e.key;
      if (orientation === 'horizontal') {
        if (key === 'ArrowLeft') key = 'ArrowUp';
        else if (key === 'ArrowRight') key = 'ArrowDown';
        else if (key === 'ArrowUp' || key === 'ArrowDown') return;
      } else if (key === 'ArrowLeft' || key === 'ArrowRight') {
        return;
      }
      const next = rovingIndex(key, index, count);
      if (next == null) return;
      e.preventDefault();
      setActive(next);
      refs.current[next]?.focus();
    },
    [count, orientation],
  );

  const itemProps = useCallback(
    (index: number, extraRef?: (el: HTMLElement | null) => void) => ({
      tabIndex: index === Math.min(active, Math.max(0, count - 1)) ? 0 : -1,
      ref: (el: HTMLElement | null) => {
        refs.current[index] = el;
        extraRef?.(el);
      },
      onKeyDown: (e: KeyboardEvent<HTMLElement>) => onKeyDown(e, index),
      onFocus: () => setActive(index),
    }),
    [active, count, onKeyDown],
  );

  return { itemProps, setActive };
}
