import { useEffect, useId, useState, type ReactNode } from 'react';
import { chartCardPhase, nextShowTable, tableToggleLabel, type ChartTableData } from './chartCardState';

export interface ChartCardProps {
  title: string;
  /** One-line plain-language reading of the chart; wired to aria-describedby. */
  takeaway?: ReactNode;
  loading: boolean;
  /** Whether there is (possibly stale) data to draw. */
  hasData: boolean;
  /** Fixed skeleton height (px) for the first load, so the layout doesn't jump. */
  height: number;
  /** Data behind the chart; enables the visible 'Table' toggle. */
  table?: ChartTableData;
  /** Rendered when settled with no data. */
  empty?: ReactNode;
  /** Extra header controls (right side, before the Table toggle). */
  headerRight?: ReactNode;
  /** Content under the plot that stays visible in table view too. */
  footer?: ReactNode;
  children?: ReactNode;
}

export function ChartCard({
  title,
  takeaway,
  loading,
  hasData,
  height,
  table,
  empty,
  headerRight,
  footer,
  children,
}: ChartCardProps) {
  const id = useId();
  const titleId = `${id}-title`;
  const descId = `${id}-desc`;
  const [showTable, setShowTable] = useState(false);
  const phase = chartCardPhase(loading, hasData);
  const contentId = `${id}-content`;
  const canTable = !!table && table.rows.length > 0 && phase !== 'skeleton' && phase !== 'empty';
  // Reset the toggle when the table can't be shown any more, so a later
  // refetch doesn't silently reopen a table nobody asked for.
  useEffect(() => {
    setShowTable((v) => nextShowTable(v, canTable));
  }, [canTable]);

  return (
    <div
      role="figure"
      aria-labelledby={titleId}
      aria-describedby={takeaway ? descId : undefined}
      aria-busy={loading || undefined}
      className="relative bg-surface-raised border border-border rounded-lg p-4 overflow-hidden"
    >
      {phase === 'stale' && (
        <div
          aria-hidden="true"
          className="absolute top-0 left-0 right-0 h-0.5 bg-green/70 animate-pulse motion-reduce:animate-none"
        />
      )}
      <div className="flex items-center justify-between gap-2 mb-2">
        <h3 id={titleId} className="text-xs text-text-secondary uppercase tracking-wide m-0">
          {title}
        </h3>
        <div className="flex items-center gap-2">
          {headerRight}
          {canTable && (
            <button
              type="button"
              aria-pressed={showTable}
              aria-label={tableToggleLabel(title)}
              aria-controls={contentId}
              onClick={() => setShowTable((v) => !v)}
              className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded border cursor-pointer transition-colors ${
                showTable
                  ? 'border-green/50 text-green bg-green/10'
                  : 'border-border text-text-muted bg-transparent hover:text-text'
              }`}
            >
              Table
            </button>
          )}
        </div>
      </div>
      {takeaway && (
        <p id={descId} className="text-xs text-text-muted mb-2 mt-0">
          {takeaway}
        </p>
      )}

      {phase === 'skeleton' ? (
        <div className="animate-pulse bg-border-muted rounded" style={{ height }} />
      ) : phase === 'empty' ? (
        empty ?? <p className="text-sm text-text-muted">No data.</p>
      ) : (
        <div id={contentId} className={`transition-opacity duration-200 ${phase === 'stale' ? 'opacity-60' : ''}`}>
          {showTable && canTable && table ? <ChartDataTable table={table} title={title} /> : children}
        </div>
      )}
      {phase !== 'skeleton' && footer}
    </div>
  );
}

function ChartDataTable({ table, title }: { table: ChartTableData; title: string }) {
  return (
    <div className="max-h-[260px] overflow-auto">
      <table className="w-full text-xs border-collapse">
        <caption className="sr-only">{table.caption ?? `${title} data`}</caption>
        <thead>
          <tr>
            {table.columns.map((col) => (
              <th
                key={col.label}
                scope="col"
                className={`sticky top-0 bg-surface-raised font-medium text-text-secondary py-1 px-1.5 border-b border-border ${
                  col.numeric ? 'text-right' : 'text-left'
                }`}
              >
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, ri) => (
            <tr key={ri} className="border-b border-border-muted last:border-0">
              {row.map((cell, ci) => (
                <td
                  key={ci}
                  className={`py-1 px-1.5 ${
                    table.columns[ci]?.numeric ? 'text-right tabular-nums text-text' : 'text-left text-text-secondary'
                  }`}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
