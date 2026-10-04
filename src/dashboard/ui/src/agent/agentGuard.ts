import { useCallback, useEffect, useRef, useState } from 'react';
import { AGENT_GUARD_MS, shouldScrollForAgent, type Box } from '@webmcp-page-tools';

/**
 * Agent-driven moves (a preselect, a scroll, a tab change) must never put a one-click action under the pointer
 * (threat T16): a person who is about to click somewhere else would hit Confirm or Apply on a row the agent just
 * brought there. Two parts, both driven by the pure rules in webmcp-page-tools-core:
 *
 *  - `scrollForAgent` scrolls only when the row is not already fully visible, and only as far as needed.
 *  - `armPageGuard` (whole page) and `useAgentGuard` (one component) switch human actions off for AGENT_GUARD_MS.
 */

const ACTIONABLE = 'button, [role="button"], input[type="submit"], input[type="checkbox"], input[type="radio"], select, summary';

/** The part of the screen a row can be seen in: its nearest scrolling ancestor, cut to the window. */
function visibleRegion(el: Element): Box {
  const win: Box = { top: 0, bottom: window.innerHeight, left: 0, right: window.innerWidth };
  let region = win;
  for (let node = el.parentElement; node; node = node.parentElement) {
    const overflowY = getComputedStyle(node).overflowY;
    if (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'hidden') {
      const r = node.getBoundingClientRect();
      region = { top: Math.max(region.top, r.top), bottom: Math.min(region.bottom, r.bottom), left: Math.max(region.left, r.left), right: Math.min(region.right, r.right) };
    }
  }
  return region;
}

/** Bring `el` into view the least that works: no scroll when it is already fully visible, never centred under the pointer. */
export function scrollForAgent(el: Element | null | undefined): boolean {
  if (!el) return false;
  if (!shouldScrollForAgent(el.getBoundingClientRect(), visibleRegion(el))) return false;
  el.scrollIntoView({ block: 'nearest' });
  return true;
}

let pageGuardTimer: ReturnType<typeof setTimeout> | undefined;
let pageGuardBlock: ((e: Event) => void) | undefined;

function liftPageGuard(): void {
  if (pageGuardTimer !== undefined) clearTimeout(pageGuardTimer);
  pageGuardTimer = undefined;
  if (pageGuardBlock) document.removeEventListener('click', pageGuardBlock, true);
  pageGuardBlock = undefined;
  document.body.removeAttribute('data-agent-guard');
}

/**
 * For AGENT_GUARD_MS the whole page ignores clicks on actionable controls inside <main> (capture phase, so a keyboard
 * Enter or Space, which also arrives as a click, is stopped too), and `body[data-agent-guard]` styles them as paused.
 * Re-arming restarts the window.
 */
export function armPageGuard(): void {
  liftPageGuard();
  document.body.setAttribute('data-agent-guard', '');
  pageGuardBlock = (e: Event) => {
    const target = e.target instanceof Element ? e.target.closest(ACTIONABLE) : null;
    if (target?.closest('main')) {
      e.preventDefault();
      e.stopPropagation();
    }
  };
  document.addEventListener('click', pageGuardBlock, true);
  pageGuardTimer = setTimeout(liftPageGuard, AGENT_GUARD_MS);
}

/**
 * A component's own guard: `guarded` is true for AGENT_GUARD_MS after `armGuard()`, so it can disable exactly the
 * buttons an agent just moved to and show why.
 */
export function useAgentGuard(): { guarded: boolean; armGuard: () => void } {
  const [guarded, setGuarded] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const armGuard = useCallback(() => {
    if (timer.current !== undefined) clearTimeout(timer.current);
    setGuarded(true);
    timer.current = setTimeout(() => setGuarded(false), AGENT_GUARD_MS);
  }, []);
  useEffect(() => () => { if (timer.current !== undefined) clearTimeout(timer.current); }, []);
  return { guarded, armGuard };
}
