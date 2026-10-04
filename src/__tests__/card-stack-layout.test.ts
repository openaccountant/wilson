import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CARD_COLUMN_GAP_PX,
  fitCardCount,
  morePendingLabel,
  placeholderPxFor,
  reconcileStack,
  releasePlaceholders,
  type StackEntry,
} from '../mcp/confirmation-card.js';

/**
 * Judge K3: a card that is clicked must not move while the pointer is on it. Removing an older card, or a column that
 * grows past the viewport, used to slide the column under the cursor. The layout rules are pure so they are tested here;
 * the DOM and React files only apply them.
 */

describe('placeholderPxFor', () => {
  test('a removal under the pointer leaves a placeholder of the card height', () => {
    expect(placeholderPxFor(true, 212)).toBe(212);
  });
  test('no placeholder when the pointer is elsewhere, or the card took no room', () => {
    expect(placeholderPxFor(false, 212)).toBeNull();
    expect(placeholderPxFor(true, 0)).toBeNull();
    expect(placeholderPxFor(true, Number.NaN)).toBeNull();
  });
});

describe('fitCardCount (cap instead of scroll)', () => {
  // oldest first: the oldest cards are the ones kept on screen
  test('everything fits: nothing hidden', () => {
    expect(fitCardCount([200, 200], 600, CARD_COLUMN_GAP_PX)).toBe(2);
  });
  test('stops at the last card that fits, counting the gaps', () => {
    // 200 + 8 + 200 = 408 fits 420; adding 8 + 200 = 616 does not.
    expect(fitCardCount([200, 200, 200], 420, CARD_COLUMN_GAP_PX)).toBe(2);
  });
  test('always shows at least one card, even one taller than the column', () => {
    expect(fitCardCount([900, 100], 500, CARD_COLUMN_GAP_PX)).toBe(1);
  });
  test('no cards, no count', () => {
    expect(fitCardCount([], 500, CARD_COLUMN_GAP_PX)).toBe(0);
  });
});

describe('morePendingLabel', () => {
  test('is null when nothing is hidden', () => {
    expect(morePendingLabel(0)).toBeNull();
  });
  test('says how many more are pending', () => {
    expect(morePendingLabel(1)).toBe('1 more pending');
    expect(morePendingLabel(7)).toBe('7 more pending');
  });
});

describe('reconcileStack (freeze while hovered)', () => {
  const live = (id: string): StackEntry => ({ id, placeholderPx: null });
  const heights: Record<string, number> = { a: 100, b: 120, c: 140 };
  const heightOf = (id: string) => heights[id] ?? 0;

  test('not hovered: a removed card is dropped and the rest close up', () => {
    const next = reconcileStack([live('a'), live('b'), live('c')], ['a', 'c'], false, heightOf);
    expect(next.map((e) => e.id)).toEqual(['a', 'c']);
  });

  test('hovered: the removed card becomes a fixed-height placeholder in the same slot', () => {
    const next = reconcileStack([live('a'), live('b'), live('c')], ['a', 'c'], true, heightOf);
    expect(next).toEqual([live('a'), { id: 'b', placeholderPx: 120 }, live('c')]);
  });

  test('a placeholder keeps its height across further updates while hovered', () => {
    const once = reconcileStack([live('a'), live('b'), live('c')], ['a', 'c'], true, heightOf);
    const twice = reconcileStack(once, ['a', 'c'], true, () => 0);
    expect(twice[1]).toEqual({ id: 'b', placeholderPx: 120 });
  });

  test('a new card is appended and never disturbs the existing slots', () => {
    const next = reconcileStack([live('a'), live('b')], ['a', 'b', 'c'], true, heightOf);
    expect(next.map((e) => e.id)).toEqual(['a', 'b', 'c']);
  });

  test('pointer leaves: every placeholder collapses', () => {
    const frozen = reconcileStack([live('a'), live('b'), live('c')], ['a', 'c'], true, heightOf);
    expect(releasePlaceholders(frozen)).toEqual([live('a'), live('c')]);
  });

  test('an update after the pointer left drops stale placeholders too', () => {
    const frozen = reconcileStack([live('a'), live('b'), live('c')], ['a', 'c'], true, heightOf);
    expect(reconcileStack(frozen, ['a', 'c'], false, heightOf).map((e) => e.id)).toEqual(['a', 'c']);
  });

  test('a card with no measurable height leaves no placeholder even while hovered', () => {
    expect(reconcileStack([live('a'), live('x')], ['a'], true, heightOf).map((e) => e.id)).toEqual(['a']);
  });
});

describe('source guards (the DOM and React files apply the model)', () => {
  const bridge = readFileSync(join(import.meta.dir, '../dashboard/webmcp-bridge.ts'), 'utf8');
  const list = readFileSync(join(import.meta.dir, '../dashboard/ui/src/components/agent/PendingApprovalsList.tsx'), 'utf8');

  test('the floating column never scrolls: it caps and says how many more are pending', () => {
    const hostLine = bridge.split('\n').find((l) => l.includes('position:fixed;bottom:16px;right:16px')) ?? '';
    expect(hostLine).toContain('overflow:hidden');
    expect(hostLine).not.toContain('overflow:auto');
    expect(bridge).toContain('fitCardCount(');
    expect(bridge).toContain('morePendingLabel(');
  });

  test('a removal under the pointer leaves a placeholder that collapses on pointerleave', () => {
    expect(bridge).toContain('placeholderPxFor(');
    expect(bridge).toContain("addEventListener('pointerleave'");
    expect(bridge).toContain(":hover')");
    // every removal path goes through the placeholder-aware helper, not a bare node.remove()
    const bare = bridge.split('\n').filter((l) => /\bnode\.remove\(\)|handle\.node\.remove\(\)/.test(l) && !l.includes('removeCardNode'));
    expect(bare).toEqual([]);
  });

  test('PendingApprovalsList freezes slots while the pointer is over it', () => {
    expect(list).toContain('reconcileStack(');
    expect(list).toContain('releasePlaceholders(');
    expect(list).toContain('onPointerLeave');
  });
});
