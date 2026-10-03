import { money, pct } from '@/format';
import { buildTooltipRows, type TooltipPayloadEntry, type TooltipRowOptions, type TooltipRow } from './tooltipRows';

/**
 * Shared chart tooltip. Each row reads: value first in strong ink, then the
 * series / category name beside a short colored line key, then '% of total'
 * and/or count when provided. Text always wears text tokens — color lives
 * only in the line key.
 *
 * Use as recharts content: `<Tooltip content={<ChartTooltip ... />} />`.
 */
export interface ChartTooltipProps extends TooltipRowOptions {
  // Injected by recharts:
  active?: boolean;
  payload?: readonly TooltipPayloadEntry[];
  label?: unknown;
  // Ours:
  valueFormat?: (n: number) => string;
  /** Header line (e.g. the date); return null to hide. Defaults to the label. */
  labelFormat?: (label: unknown) => string | null;
  /** Rows to render instead of mapping recharts' payload. */
  rows?: TooltipRow[];
}

export function ChartTooltip({
  active,
  payload,
  label,
  valueFormat = money,
  labelFormat,
  rows: explicitRows,
  ...rowOpts
}: ChartTooltipProps) {
  if (!active) return null;
  const rows = explicitRows ?? buildTooltipRows(payload, rowOpts);
  if (rows.length === 0) return null;
  const header = labelFormat ? labelFormat(label) : label == null || label === '' ? null : String(label);

  return (
    <div className="bg-surface border border-border rounded-md px-2.5 py-1.5 text-xs shadow-lg min-w-[120px]">
      {header && <div className="text-text-secondary mb-1">{header}</div>}
      <div className="space-y-1">
        {rows.map((row) => (
          <div key={row.key}>
            <div className="text-text font-semibold tabular-nums">
              {row.value === null ? '—' : valueFormat(row.value)}
            </div>
            <div className="flex items-center gap-1.5 text-text-secondary">
              {row.color && (
                <span
                  aria-hidden="true"
                  className="inline-block w-3 h-[3px] rounded-full shrink-0"
                  style={{ background: row.color }}
                />
              )}
              <span className="truncate">{row.name}</span>
            </div>
            {(row.share !== undefined || row.count !== undefined) && (
              <div className="text-text-muted tabular-nums">
                {row.share !== undefined && `${pct(row.share, 1)} of total`}
                {row.share !== undefined && row.count !== undefined && ' · '}
                {row.count !== undefined && `${row.count} ${row.count === 1 ? 'txn' : 'txns'}`}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
