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
      // A tap on an open tooltip closes it whatever kept it open (a focus
      // that came with the tap included); on a closed one it pins it open.
      return tooltipOpen(s) ? TOOLTIP_CLOSED : { ...s, pinned: true };
    case 'escape':
    case 'outside':
      return TOOLTIP_CLOSED;
  }
}

export function tooltipOpen(s: TooltipState): boolean {
  return s.hover || s.focus || s.pinned;
}

export const TOOLTIP_WIDTH = 256;
export const TOOLTIP_GAP = 6;
export const TOOLTIP_MARGIN = 8;
/** Grace period so the pointer can cross the gap onto the bubble (WCAG 1.4.13). */
export const TOOLTIP_CLOSE_DELAY_MS = 150;

export interface TooltipPlacement {
  left: number;
  top: number;
  side: 'below' | 'above';
}

/**
 * Viewport-relative position for a position:fixed bubble. Prefers below the
 * trigger, flips above when it does not fit below and fits better above, and
 * clamps horizontally (and vertically as a last resort) inside the viewport.
 * `left` is the bubble's left edge, `top` its top edge.
 */
export function placeTooltip(
  trigger: { left: number; right: number; top: number; bottom: number },
  bubble: { width: number; height: number },
  viewport: { width: number; height: number },
): TooltipPlacement {
  const m = TOOLTIP_MARGIN;
  const centre = (trigger.left + trigger.right) / 2;
  const maxLeft = Math.max(m, viewport.width - bubble.width - m);
  const left = Math.min(Math.max(centre - bubble.width / 2, m), maxLeft);

  const below = trigger.bottom + TOOLTIP_GAP;
  const fitsBelow = below + bubble.height + m <= viewport.height;
  const aboveTop = trigger.top - TOOLTIP_GAP - bubble.height;
  const fitsAbove = aboveTop >= m;
  const side: 'below' | 'above' = fitsBelow || !fitsAbove ? 'below' : 'above';
  let top = side === 'below' ? below : aboveTop;
  top = Math.max(m, Math.min(top, viewport.height - bubble.height - m));
  return { left, top, side };
}
