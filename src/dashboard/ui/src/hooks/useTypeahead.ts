import { useCallback, useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import {
  detectArgTrigger,
  detectTrigger,
  initialActiveIndex,
  isTypeaheadOpen,
  nextActiveIndex,
  optionDomId,
  type ArgTrigger,
  type Trigger,
} from '@/lib/typeahead';
import type { TypeaheadItem } from '@/components/Typeahead';

/**
 * Typeahead state machine for a text field (the chat composer textarea).
 * Trigger detection and filtering are pure (lib/typeahead.ts); this hook owns
 * open/active/dismissed state, keyboard handling and the combobox ARIA props.
 *
 * onKeyDown returns true when it consumed the key — the caller must then
 * skip its own handling (Enter-to-send runs only when this returned false).
 */

export type ActiveTrigger = Trigger | ArgTrigger;
export type AcceptMode = 'insert' | 'execute';

export interface UseTypeaheadOptions<T extends TypeaheadItem> {
  value: string;
  caret: number;
  listboxId: string;
  getItems: (trigger: ActiveTrigger) => { items: T[]; hidden: number };
  /** Lets a bare "@" query continue across one space while it still matches. */
  hasMatches?: (query: string) => boolean;
  /** Mention tokens already inserted by the menu — they never reopen it. */
  acceptedTokens?: readonly string[];
  /**
   * Keep the menu closed for this trigger without dismissing it (e.g. the
   * mention limit is reached) — Enter then sends; the caller explains why.
   */
  blocked?: (trigger: ActiveTrigger) => boolean;
  onAccept: (item: T, trigger: ActiveTrigger, mode: AcceptMode) => void;
}

function triggerKey(t: ActiveTrigger | null): string | null {
  return t ? `${t.kind}:${t.start}` : null;
}

export function useTypeahead<T extends TypeaheadItem>({
  value,
  caret,
  listboxId,
  getItems,
  hasMatches,
  acceptedTokens,
  blocked,
  onAccept,
}: UseTypeaheadOptions<T>) {
  const [focused, setFocused] = useState(false);
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);

  const trigger = useMemo<ActiveTrigger | null>(
    () => detectTrigger(value, caret, hasMatches, acceptedTokens) ?? detectArgTrigger(value, caret),
    [value, caret, hasMatches, acceptedTokens],
  );
  const key = triggerKey(trigger);

  const { items, hidden } = useMemo(
    () => (trigger ? getItems(trigger) : { items: [] as T[], hidden: 0 }),
    [trigger, getItems],
  );

  // A dismissed list stays closed only for that same token.
  useEffect(() => {
    if (dismissedKey && dismissedKey !== key) setDismissedKey(null);
  }, [key, dismissedKey]);

  // The active option belongs to one token+query; a new token or query starts
  // over at initialActiveIndex (top match, or none for argument lists). Derived
  // during render, so a keypress can never see the previous query's index.
  const queryKey = trigger ? `${key}:${trigger.query}` : null;
  const [active, setActive] = useState<{ queryKey: string | null; index: number }>({ queryKey: null, index: 0 });
  const activeIndex = active.queryKey === queryKey ? active.index : initialActiveIndex(trigger);
  const setActiveIndex = useCallback(
    (next: number | ((current: number) => number)) =>
      setActive((prev) => {
        const current = prev.queryKey === queryKey ? prev.index : initialActiveIndex(trigger);
        return { queryKey, index: typeof next === 'function' ? next(current) : next };
      }),
    [queryKey, trigger],
  );

  const open = isTypeaheadOpen({
    focused,
    trigger,
    dismissed: dismissedKey !== null && dismissedKey === key,
    blocked: trigger !== null && blocked !== undefined && blocked(trigger),
    itemCount: items.length,
  });

  const safeIndex = items.length === 0 || activeIndex < 0 ? -1 : Math.min(activeIndex, items.length - 1);

  const dismiss = useCallback(() => setDismissedKey(key), [key]);

  const accept = useCallback(
    (index: number, mode: AcceptMode = 'execute') => {
      const item = items[index];
      if (!item || item.disabled || !trigger) return;
      onAccept(item, trigger, mode);
    },
    [items, trigger, onAccept],
  );

  const move = (delta: number, wrap: boolean) => {
    if (items.length === 0) return;
    setActiveIndex((i) => nextActiveIndex(i, delta, items.length, wrap));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLElement>): boolean => {
    if (!open || e.nativeEvent.isComposing) return false;
    const ctrlOnly = e.ctrlKey && !e.metaKey && !e.altKey;

    switch (e.key) {
      case 'ArrowDown':
        move(1, true);
        return true;
      case 'ArrowUp':
        move(-1, true);
        return true;
      case 'PageDown':
        move(5, false);
        return true;
      case 'PageUp':
        move(-5, false);
        return true;
      case 'Home':
        if (items.length === 0) return false;
        setActiveIndex(0);
        return true;
      case 'End':
        if (items.length === 0) return false;
        setActiveIndex(items.length - 1);
        return true;
      case 'Escape':
        dismiss();
        return true;
      case 'Tab':
        if (e.shiftKey || items.length === 0) return false;
        // Nothing active (argument list) → Tab completes the top match.
        accept(safeIndex < 0 ? 0 : safeIndex, 'insert');
        return true;
      case 'Enter':
        if (e.shiftKey) {
          // Close and let the textarea insert the newline natively.
          dismiss();
          return false;
        }
        // No matches, or an argument list nobody has picked from yet → Enter
        // falls through to the composer's normal send.
        if (safeIndex < 0) return false;
        accept(safeIndex, 'execute');
        return true;
      default:
        if (ctrlOnly && (e.key === 'n' || e.key === 'N')) {
          move(1, true);
          return true;
        }
        if (ctrlOnly && (e.key === 'p' || e.key === 'P')) {
          move(-1, true);
          return true;
        }
        return false;
    }
  };

  const activeItem = open && safeIndex >= 0 ? items[safeIndex] : undefined;

  const comboboxProps = {
    role: 'combobox' as const,
    'aria-autocomplete': 'list' as const,
    'aria-expanded': open,
    'aria-controls': listboxId,
    'aria-activedescendant': activeItem ? optionDomId(listboxId, safeIndex) : undefined,
  };

  return {
    open,
    trigger,
    items,
    hidden,
    activeIndex: safeIndex,
    setActiveIndex,
    comboboxProps,
    onKeyDown,
    accept,
    dismiss,
    onFocus: () => setFocused(true),
    onBlur: () => setFocused(false),
  };
}
