/**
 * Pure mapping from a recharts tooltip payload to the rows ChartTooltip draws.
 * Kept free of React so it can be unit-tested with bun.
 */

/** The subset of a recharts tooltip payload entry we read. */
export interface TooltipPayloadEntry {
  value?: unknown;
  name?: unknown;
  dataKey?: unknown;
  color?: string;
  fill?: string;
  stroke?: string;
  payload?: Record<string, unknown> & { fill?: string; count?: unknown };
}

export interface TooltipRow {
  key: string;
  value: number | null;
  name: string;
  color?: string;
  /** Share of total in percent units (0-100), when a total is known. */
  share?: number;
  count?: number;
}

export interface TooltipRowOptions {
  /** Display name for a series; defaults to the entry's name / dataKey. */
  nameFor?: (dataKey: string, name: string) => string;
  /** Total used for '% of total'; omit to hide the share. */
  total?: number;
  /** Datum field holding a transaction count (e.g. 'count'). */
  countKey?: string;
  /** Override color lookup (e.g. stable category palette). */
  colorFor?: (name: string, entry: TooltipPayloadEntry) => string | undefined;
  /** Drop entries whose dataKey is listed (helper series like stacked bases). */
  hideKeys?: readonly string[];
}

function toNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

export function buildTooltipRows(
  payload: readonly TooltipPayloadEntry[] | undefined,
  opts: TooltipRowOptions = {},
): TooltipRow[] {
  if (!payload) return [];
  const rows: TooltipRow[] = [];
  const seen = new Set<string>();
  for (const entry of payload) {
    const dataKey = entry.dataKey == null ? '' : String(entry.dataKey);
    if (opts.hideKeys?.includes(dataKey)) continue;
    const rawName = entry.name == null || entry.name === '' ? dataKey : String(entry.name);
    const name = opts.nameFor ? opts.nameFor(dataKey, rawName) : rawName;
    const key = `${dataKey}|${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const value = toNumber(entry.value);
    const color =
      opts.colorFor?.(rawName, entry) ?? entry.payload?.fill ?? entry.color ?? entry.fill ?? entry.stroke;
    const row: TooltipRow = { key, value, name, color };
    if (opts.total && opts.total > 0 && value !== null) row.share = (Math.abs(value) / opts.total) * 100;
    if (opts.countKey) {
      const c = toNumber(entry.payload?.[opts.countKey]);
      if (c !== null) row.count = c;
    }
    rows.push(row);
  }
  return rows;
}
