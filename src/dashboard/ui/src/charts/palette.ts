/**
 * Stable category colors.
 *
 * Color follows the entity, never its rank in the current view: a category
 * keeps the same hue whatever the date range or filter. Slots are assigned by
 * ALL-TIME spend rank (from the unfiltered all-time /api/summary App already
 * fetches): the top 7 spend categories take slots 1-7, everything else —
 * plus Uncategorized / unclassified — folds to a neutral grey. The first
 * non-empty build is memoized for the session, so later refetches (new
 * imports, etc.) never repaint a chart mid-session. Deliberately NOT a hash:
 * hashing collides and gives no guarantee the biggest categories get the
 * most distinguishable hues.
 */
import { chartTokens, seriesSlots } from './tokens';
import { isNeutralLabel } from '../lib/neutralLabels';

export interface SummaryLike {
  category: string | null;
  total: number;
}

export const PALETTE_SLOT_COUNT = 7;

/**
 * Not spend even when stored negative (income rows can carry negative amounts
 * under 'Income'), so it must not steal a spend slot.
 */
const NON_SPEND_LABELS = new Set(['income']);

/**
 * Category labels that never earn a hue (no identity worth encoding): the
 * shared neutral list (lib/neutralLabels.ts) — Uncategorized / catch-alls and
 * payment-method labels — so the drill's grey labels never consume a slot.
 */
export function isNeutralCategory(category: string | null | undefined): boolean {
  return isNeutralLabel(category);
}

export interface CategoryPalette {
  /** category label → color for ranked categories only */
  slots: ReadonlyMap<string, string>;
  neutral: string;
}

/** Pure: rank categories by all-time spend and assign slot colors. */
export function buildCategoryPalette(
  summary: readonly SummaryLike[],
  slotColors: readonly string[],
  neutral: string,
): CategoryPalette {
  const spendByCategory = new Map<string, number>();
  for (const row of summary) {
    const label = (row.category ?? '').trim();
    if (isNeutralCategory(label) || NON_SPEND_LABELS.has(label.toLowerCase())) continue;
    if (!(row.total < 0)) continue;
    spendByCategory.set(label, (spendByCategory.get(label) ?? 0) + Math.abs(row.total));
  }
  const ranked = [...spendByCategory.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  );
  const slots = new Map<string, string>();
  ranked.slice(0, Math.min(PALETTE_SLOT_COUNT, slotColors.length)).forEach(([label], i) => {
    slots.set(label, slotColors[i]);
  });
  return { slots, neutral };
}

export function categoryColor(palette: CategoryPalette, category: string | null | undefined): string {
  const label = (category ?? '').trim();
  return palette.slots.get(label) ?? palette.neutral;
}

// ---------------------------------------------------------------------------
// Session memo (external store so React charts re-render once it is primed).
// ---------------------------------------------------------------------------

let sessionPalette: CategoryPalette | null = null;
const listeners = new Set<() => void>();

/**
 * Prime the session palette from the all-time summary. First non-empty call
 * wins; later calls are no-ops so colors never shift mid-session.
 */
export function primeCategoryPalette(
  summary: readonly SummaryLike[] | null | undefined,
  slotColors: readonly string[] = seriesSlots(),
  neutral: string = chartTokens().chartNeutral,
): CategoryPalette | null {
  if (sessionPalette || !summary || summary.length === 0) return sessionPalette;
  sessionPalette = buildCategoryPalette(summary, slotColors, neutral);
  for (const l of listeners) l();
  return sessionPalette;
}

export function getCategoryPalette(): CategoryPalette | null {
  return sessionPalette;
}

export function subscribeCategoryPalette(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Test seam only. */
export function resetCategoryPaletteForTests(): void {
  sessionPalette = null;
}
