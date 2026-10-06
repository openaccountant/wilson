import { useState } from 'react';
import { useRovingList } from '@/hooks/useRovingList';
import { chartTokens } from '@/charts/tokens';
import { monthBarAria, monthTooltip, tooltipAnchor, type SeriesBar } from '@/lib/drill';
import { moneyCompact } from '@/format';

const PLOT_HEIGHT = 120;
/** Room above the tallest bar for its direct label. */
const PLOT_TOP_PAD = 14;

export interface SeriesModel {
  bars: SeriesBar[];
  average: number | null;
  max: number;
}

/**
 * Trailing-12-month spend bars, anchored to the coverage end (independent of
 * the header range). Every covered bar is full opacity; the active range is
 * one outlined band labelled 'Selected'. Months outside coverage are a SHORT
 * hatched 'no data' strip (never a tall bar); covered months with no spend sit
 * on a 1px baseline; the partial coverage-end month is outlined with a lighter
 * striped fill and left out of the dashed average. The tallest month carries
 * a direct value label. Each bar is a button (one roving tab stop,
 * Left/Right/Home/End) that narrows the header range to that month — a
 * pushed, undoable step.
 */
export function MonthBars({
  model,
  color,
  label,
  coverageEnd,
  onSelect,
}: {
  model: SeriesModel;
  color: string;
  label: string;
  coverageEnd?: string | null;
  onSelect: (period: string) => void;
}) {
  const { bars, average, max } = model;
  const { itemProps } = useRovingList(bars.length, 'horizontal');
  const [hover, setHover] = useState<number | null>(null);
  const t = chartTokens();
  const hatch = `repeating-linear-gradient(45deg, ${t.chartNeutralBar} 0 1.5px, ${t.chartUncovered} 1.5px 5px)`;
  const partialFill = `repeating-linear-gradient(135deg, color-mix(in srgb, ${color} 55%, transparent) 0 3px, transparent 3px 6px)`;

  if (bars.length === 0) return null;
  const n = bars.length;
  const avgPct = average != null && max > 0 ? (average / max) * 100 : null;
  const firstIn = bars.findIndex((b) => b.inRange);
  const lastIn = firstIn === -1 ? -1 : bars.length - 1 - [...bars].reverse().findIndex((b) => b.inRange);
  const hovered = hover != null ? bars[hover] : null;
  const anchor = hover != null ? tooltipAnchor(hover, n) : null;
  const tip = hovered ? monthTooltip(hovered, { coverageEnd }) : null;
  const tipStyle =
    hover == null || !anchor
      ? undefined
      : anchor.align === 'start'
        ? { left: `${(hover / n) * 100}%`, transform: 'translateY(-100%)' }
        : anchor.align === 'end'
          ? { left: `${((hover + 1) / n) * 100}%`, transform: 'translate(-100%, -100%)' }
          : { left: `${anchor.leftPct}%`, transform: 'translate(-50%, -100%)' };

  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-2 mb-1 flex-wrap">
        <span className="text-[11px] text-text-secondary uppercase tracking-wide">Last 12 months</span>
        <span className="flex items-center gap-3 text-[11px] text-text-secondary tabular-nums">
          {firstIn !== -1 && (
            <span className="flex items-center gap-1">
              <span aria-hidden="true" className="inline-block w-3 h-2.5 rounded-sm border border-green/70 bg-green/15" />
              selected
            </span>
          )}
          {average != null && (
            <span className="flex items-center gap-1">
              <span aria-hidden="true" className="inline-block w-3 border-t border-dashed border-text-secondary" />
              avg {moneyCompact(average)}/mo
            </span>
          )}
        </span>
      </div>
      <div className="relative">
        <div
          role="group"
          aria-label={label}
          className="relative flex items-end"
          style={{ height: PLOT_HEIGHT + PLOT_TOP_PAD, paddingTop: PLOT_TOP_PAD }}
        >
          {firstIn !== -1 && (
            // Unlabelled on purpose: the legend's 'selected' swatch and the bold
            // axis ticks name it, and an in-band label collided with the max-bar
            // value label whenever the tallest month was selected.
            <div
              aria-hidden="true"
              className="absolute top-0 bottom-0 rounded border border-green/70 bg-green/15 pointer-events-none"
              style={{ left: `${(firstIn / n) * 100}%`, width: `${((lastIn - firstIn + 1) / n) * 100}%` }}
            />
          )}
          <div className="relative flex items-end w-full" style={{ height: PLOT_HEIGHT }}>
            {avgPct != null && (
              <div
                aria-hidden="true"
                className="absolute left-0 right-0 border-t border-dashed border-text-secondary pointer-events-none z-10"
                style={{ bottom: `${avgPct}%` }}
              />
            )}
            {bars.map((b, i) => {
              const props = itemProps(i);
              const height = b.noData ? `${b.heightPct}%` : b.value ? `${b.heightPct}%` : '1px';
              return (
                <button
                  key={b.period}
                  type="button"
                  {...props}
                  aria-disabled={b.noData || undefined}
                  aria-label={monthBarAria(b)}
                  onClick={() => !b.noData && onSelect(b.period)}
                  onMouseEnter={() => setHover(i)}
                  onMouseLeave={() => setHover(null)}
                  onFocus={() => {
                    props.onFocus();
                    setHover(i);
                  }}
                  onBlur={() => setHover(null)}
                  className={`relative flex-1 h-full flex items-end px-[2px] border-none rounded-sm bg-transparent ${
                    b.noData ? 'cursor-default' : 'cursor-pointer hover:bg-white/5'
                  } focus:outline-none focus-visible:ring-1 focus-visible:ring-green/60`}
                >
                  {b.isMax && b.value != null && (
                    <span
                      aria-hidden="true"
                      className="absolute left-1/2 -translate-x-1/2 text-[10px] leading-none text-text tabular-nums whitespace-nowrap pointer-events-none"
                      style={{ bottom: `calc(${b.heightPct}% + 3px)` }}
                    >
                      {moneyCompact(b.value)}
                    </span>
                  )}
                  <span
                    aria-hidden="true"
                    className="chart-mark block w-full rounded-t-sm"
                    style={
                      b.noData
                        ? { height, background: hatch }
                        : b.partial
                          ? {
                              // Outlined + lighter striped fill: data stops
                              // before the month ends.
                              height,
                              background: partialFill,
                              border: `1.5px solid ${color}`,
                              borderBottomWidth: 0,
                              boxSizing: 'border-box',
                            }
                          : { height, background: color }
                    }
                  />
                </button>
              );
            })}
          </div>
        </div>
        {tip && tipStyle && (
          <div className="absolute top-0 pointer-events-none z-20" style={tipStyle}>
            <div className="bg-surface border border-border rounded-md px-2.5 py-1.5 text-xs shadow-lg min-w-[132px] mb-1 whitespace-nowrap">
              <div className="text-text-secondary mb-0.5">{tip.title}</div>
              <div className="text-text font-semibold tabular-nums">{tip.value}</div>
              {tip.lines.map((l) => (
                <div key={l} className="text-text-secondary">
                  {l}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
      <div aria-hidden="true" className="flex mt-1">
        {bars.map((b) => (
          <span
            key={b.period}
            className={`flex-1 text-center text-[10px] leading-tight ${
              b.inRange ? 'text-text font-semibold' : 'text-text-secondary'
            }`}
          >
            {b.label}
            {b.axisLabel !== b.label && <span className="block text-text-secondary font-normal">{b.axisLabel.slice(b.label.length + 1)}</span>}
          </span>
        ))}
      </div>
    </div>
  );
}
