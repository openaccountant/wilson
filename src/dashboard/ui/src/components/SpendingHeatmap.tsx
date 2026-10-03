import { useMemo } from 'react';
import { useApi } from '@/hooks/useApi';
import { useAppState } from '@/state';
import { OfflineUnavailable } from '@/components/OfflineUnavailable';
import { ChartCard } from '@/charts/ChartCard';
import { FilteredBadge } from '@/components/FilteredBadge';
import { chartTokens } from '@/charts/tokens';
import { buildHeatmapGrid, heatmapSummary, heatmapYearRange, isFilteredHeatmap } from '@/lib/heatmapGrid';
import { dailySpendingPath } from '@/lib/overviewQueries';
import { formatDate, money } from '@/format';
import type { CoverageResponse, DailySpendingRow, StreakData } from '@/types';

interface SpendingHeatmapProps {
  onDayClick?: (date: string) => void;
}

const CELL_SIZE = 13;
const CELL_GAP = 3;
const TOTAL = CELL_SIZE + CELL_GAP;
const LABEL_WIDTH = 28;
const HEADER_HEIGHT = 18;
const DAY_LABELS = ['', 'M', '', 'W', '', 'F', ''];
const HATCH_ID = 'heatmap-uncovered-hatch';

/** Filtered view: one green ramp by share of the busiest day (no budget semantics). */
function getRelativeColor(amount: number, maxAmount: number): string {
  if (amount === 0) return '#1e2130';
  const ratio = maxAmount > 0 ? amount / maxAmount : 0;
  if (ratio <= 0.25) return '#064e1a';
  if (ratio <= 0.5) return '#166534';
  if (ratio <= 0.75) return '#15803d';
  return '#22c55e';
}

function getColor(amount: number, dailyBudget: number): string {
  if (amount === 0) return '#1e2130';
  const ratio = dailyBudget > 0 ? amount / dailyBudget : 0;
  if (ratio <= 0.5) return '#064e1a';
  if (ratio <= 0.8) return '#166534';
  if (ratio <= 1.0) return '#22c55e';
  if (ratio <= 1.5) return '#eab308';
  if (ratio <= 2.0) return '#f97316';
  return '#ef4444';
}

export function SpendingHeatmap({ onDayClick }: SpendingHeatmapProps) {
  const { startDate, endDate } = useMemo(() => heatmapYearRange(), []);
  // Header filters (URL-backed) scope the cells; the window stays the last year.
  const { accountId, entityId, category } = useAppState();
  const dailyPath = dailySpendingPath(startDate, endDate, { accountId, entityId, category });
  const { data: dailyData, loading: loadingDaily, offline: offlineDaily } = useApi<DailySpendingRow[]>(dailyPath);
  const { data: streakData, loading: loadingStreak, offline: offlineStreak } = useApi<StreakData>('/api/streak');
  // Coverage is optional: if the endpoint is missing or fails, every day is
  // treated as covered (the pre-coverage behavior).
  const { data: coverage, loading: loadingCoverage } = useApi<CoverageResponse>('/api/coverage');

  const budget = streakData?.dailyBudget ?? 50;
  const grid = useMemo(() => {
    const spending = new Map<string, number>();
    for (const row of dailyData ?? []) spending.set(row.date, row.spending);
    return buildHeatmapGrid({ startDate, endDate, spending, dailyBudget: budget, coverage });
  }, [dailyData, budget, coverage, startDate, endDate]);

  if ((offlineDaily && !dailyData) || (offlineStreak && !streakData)) {
    // Mirror unavailable or never seeded — say so rather than an all-zero grid.
    return <OfflineUnavailable title="Spending Heatmap" />;
  }

  const { weeks, months, maxAmount } = grid;
  const filtered = isFilteredHeatmap({ accountId, entityId, category });
  const summary = heatmapSummary(grid, money(budget), filtered);
  const cellColor = (amount: number) => (filtered ? getRelativeColor(amount, maxAmount) : getColor(amount, budget));
  const svgWidth = LABEL_WIDTH + weeks.length * TOTAL;
  const svgHeight = HEADER_HEIGHT + 7 * TOTAL;
  const t = chartTokens();
  const hasUncovered = weeks.some((w) => w.some((d) => !d.covered && !d.future));

  const tableRows = weeks
    .flat()
    .filter((d) => d.covered && !d.future && d.amount > 0)
    .reverse()
    .map((d) =>
      filtered ? [formatDate(d.date), money(d.amount)] : [formatDate(d.date), money(d.amount), d.amount <= budget ? 'Under' : 'Over'],
    );

  return (
    <ChartCard
      title="Spending Heatmap"
      loading={loadingDaily || loadingStreak || loadingCoverage}
      hasData={dailyData !== null}
      height={140}
      takeaway={summary.takeaway}
      headerRight={
        summary.tally || category ? (
          <>
            <FilteredBadge category={category} />
            {summary.tally && (
              <span className="text-xs text-text-muted tabular-nums">
                Under budget <span className="text-green font-semibold">{summary.tally.under}</span> of{' '}
                {summary.tally.total} days
              </span>
            )}
          </>
        ) : undefined
      }
      table={{
        columns: filtered
          ? [{ label: 'Date' }, { label: 'Spent', numeric: true }]
          : [{ label: 'Date' }, { label: 'Spent', numeric: true }, { label: 'Budget', numeric: true }],
        rows: tableRows,
      }}
      footer={
        hasUncovered ? (
          <p className="flex items-center gap-1.5 text-[10px] text-text-muted mt-2 mb-0">
            <span
              aria-hidden="true"
              className="inline-block w-2.5 h-2.5 rounded-sm"
              style={{
                background: `repeating-linear-gradient(45deg, ${t.chartNeutral} 0 1.5px, ${t.chartUncovered} 1.5px 4px)`,
              }}
            />
            No imported statements — not counted
          </p>
        ) : null
      }
    >
      <div className="overflow-x-auto">
        <svg width={svgWidth} height={svgHeight} className="block">
          <defs>
            <pattern id={HATCH_ID} width={4} height={4} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <rect width={4} height={4} fill={t.chartUncovered} />
              <line x1={0} y1={0} x2={0} y2={4} stroke={t.chartNeutral} strokeWidth={1.5} />
            </pattern>
          </defs>

          {/* Month labels (spaced so they never overlap) */}
          {months.map((m) => (
            <text
              key={`${m.label}-${m.weekIndex}`}
              x={LABEL_WIDTH + m.weekIndex * TOTAL}
              y={12}
              className="fill-text-muted text-[10px]"
              fontSize={10}
            >
              {m.label}
            </text>
          ))}

          {/* Day-of-week labels */}
          {DAY_LABELS.map((label, i) => (
            <text
              key={i}
              x={0}
              y={HEADER_HEIGHT + i * TOTAL + CELL_SIZE - 2}
              className="fill-text-muted text-[10px]"
              fontSize={10}
            >
              {label}
            </text>
          ))}

          {/* Heatmap cells */}
          {weeks.map((week, wi) =>
            week.map((day) => (
              <rect
                key={day.date}
                x={LABEL_WIDTH + wi * TOTAL}
                y={HEADER_HEIGHT + day.dayOfWeek * TOTAL}
                width={CELL_SIZE}
                height={CELL_SIZE}
                rx={2}
                fill={
                  day.future ? '#13161d' : !day.covered ? `url(#${HATCH_ID})` : cellColor(day.amount)
                }
                className="cursor-pointer"
                onClick={() => onDayClick?.(day.date)}
              >
                <title>
                  {day.future
                    ? day.date
                    : day.covered
                      ? `${day.date}: ${money(day.amount)}`
                      : `${day.date}: no imported data`}
                </title>
              </rect>
            )),
          )}
        </svg>
      </div>
    </ChartCard>
  );
}
