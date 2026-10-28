/**
 * Pure open/closed state for the dashboard's hover/focus/tap tooltips. No
 * React, no DOM — Bun unit tests import this directly
 * (src/__tests__/dashboard-info-tooltip.test.ts).
 *
 * Three independent reasons keep a tooltip open: pointer hover, keyboard
 * focus, and a touch tap ("pinned"). Escape clears all three so it always
 * dismisses, even while the trigger keeps focus.
 */

export interface TooltipState {
  hover: boolean;
  focus: boolean;
  pinned: boolean;
}

export type TooltipEvent =
  | 'hover-in'
  | 'hover-out'
  | 'focus'
  | 'blur'
  | 'tap'
  | 'escape'
  | 'outside';

export const TOOLTIP_CLOSED: TooltipState = { hover: false, focus: false, pinned: false };

export function tooltipReduce(s: TooltipState, e: TooltipEvent): TooltipState {
  switch (e) {
    case 'hover-in':
      return { ...s, hover: true };
    case 'hover-out':
      return { ...s, hover: false };
    case 'focus':
      return { ...s, focus: true };
    case 'blur':
      // Leaving the trigger also unpins a tap-opened tooltip.
      return { ...s, focus: false, pinned: false };
    case 'tap':
      return { ...s, pinned: !s.pinned };
    case 'escape':
    case 'outside':
      return TOOLTIP_CLOSED;
  }
}

export function tooltipOpen(s: TooltipState): boolean {
  return s.hover || s.focus || s.pinned;
}
