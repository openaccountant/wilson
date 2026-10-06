import { useCallback, useSyncExternalStore } from 'react';
import {
  categoryColor,
  getCategoryPalette,
  subscribeCategoryPalette,
  type CategoryPalette,
} from './palette';
import { chartTokens } from './tokens';

/**
 * Returns a stable `colorFor(category)` lookup backed by the session palette
 * (primed in App from the all-time summary). Until it is primed every
 * category renders neutral rather than borrowing a rank-based color.
 */
export function useCategoryColor(): (category: string | null | undefined) => string {
  const palette = useSyncExternalStore(subscribeCategoryPalette, getCategoryPalette, getCategoryPalette);
  return useCallback(
    (category: string | null | undefined) => {
      const p: CategoryPalette = palette ?? { slots: new Map(), neutral: chartTokens().chartNeutral };
      return categoryColor(p, category);
    },
    [palette],
  );
}
