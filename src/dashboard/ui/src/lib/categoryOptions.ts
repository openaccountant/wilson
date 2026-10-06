/**
 * Header category filter options (pure, unit-tested).
 *
 * Built from GET /api/category-options — every category label present in
 * transactions, including non-spend ones (Transfer, Credit Card, Payment,
 * Income) and one 'Uncategorized' bucket. NOT from /api/summary: the summary
 * applies the dashboard SPEND rule, so non-spend categories would vanish as
 * filter options.
 *
 * No `@/` imports and no `window`, so bun tests can load it from the repo root.
 */

/**
 * Sorted, de-duplicated option list. A deep-linked `selected` category is
 * always present so the dropdown shows it as selected even before (or
 * without) the options listing it.
 */
export function categoryFilterOptions(options: readonly string[] | null | undefined, selected: string | null): string[] {
  const names = new Set((options ?? []).filter((c) => typeof c === 'string' && c !== ''));
  if (selected) names.add(selected);
  return [...names].sort();
}
