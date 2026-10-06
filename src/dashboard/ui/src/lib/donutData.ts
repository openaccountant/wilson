/**
 * Spending-by-category donut data (pure).
 *
 * Only spend rows (total < 0) are plotted, as positive magnitudes. Rows whose
 * label collapses to the same display name (null, '' and 'Uncategorized' all
 * read 'Uncategorized') are merged so slices and legend keys are unique.
 */
export interface DonutSourceRow {
  category: string | null;
  total: number;
  count?: number;
}

export interface DonutSlice {
  name: string;
  value: number;
  count: number;
}

export function donutLabel(category: string | null | undefined): string {
  const label = (category ?? '').trim();
  return label === '' ? 'Uncategorized' : label;
}

export function buildDonutData(rows: readonly DonutSourceRow[]): { slices: DonutSlice[]; total: number } {
  const byName = new Map<string, DonutSlice>();
  for (const row of rows) {
    if (!(row.total < 0)) continue;
    const name = donutLabel(row.category);
    const slice = byName.get(name) ?? { name, value: 0, count: 0 };
    slice.value += Math.abs(row.total);
    slice.count += row.count ?? 0;
    byName.set(name, slice);
  }
  const slices = [...byName.values()].sort((a, b) => b.value - a.value || a.name.localeCompare(b.name));
  const total = slices.reduce((s, d) => s + d.value, 0);
  return { slices, total };
}
