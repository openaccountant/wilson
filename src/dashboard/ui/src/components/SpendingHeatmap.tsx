import { useMemo } from 'react';
import { useApi } from '@/hooks/useApi';
import type { DailySpendingRow, StreakData } from '@/types';

interface SpendingHeatmapProps {
  onDayClick?: (date: string) => void;
}

const CELL_SIZE = 13;
const CELL_GAP = 3;
const TOTAL = CELL_SIZE + CELL_GAP;
const LABEL_WIDTH = 28;
const HEADER_HEIGHT = 18;
const DAY_LABELS = ['', 'M', '', 'W', '', 'F', ''];

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

function getYearRange(): { startDate: string; endDate: string } {
  const end = new Date();
  const start = new Date();
  start.setFullYear(end.getFullYear() - 1);
  start.setDate(start.getDate() + 1);
  // Align to Sunday
  const dayOffset = start.getDay();
  start.setDate(start.getDate() - dayOffset);
  const fmt = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return { startDate: fmt(start), endDate: fmt(end) };
}

export function SpendingHeatmap({ onDayClick }: SpendingHeatmapProps) {
  const { startDate, endDate } = useMemo(getYearRange, []);
  const { data: dailyData, loading: loadingDaily } = useApi<DailySpendingRow[]>(
    `/api/daily-spending?startDate=${startDate}&endDate=${endDate}`,
  );
  const { data: streakData, loading: loadingStreak } = useApi<StreakData>('/api/streak');

  const { weeks, months, underBudgetDays, totalDays } = useMemo(() => {
    const spendingMap = new Map<string, number>();
    if (dailyData) {
      for (const row of dailyData) {
        spendingMap.set(row.date, row.spending);
      }
    }
    const budget = streakData?.dailyBudget ?? 50;

    const start = new Date(startDate + 'T00:00:00');
    const end = new Date(endDate + 'T00:00:00');
    const allWeeks: { date: string; amount: number; dayOfWeek: number; future: boolean }[][] = [];
    let currentWeek: typeof allWeeks[0] = [];
    let under = 0;
    let total = 0;

    const monthLabels: { label: string; weekIndex: number }[] = [];
    let lastMonth = -1;

    const cursor = new Date(start);
    while (cursor <= end) {
      const dateStr = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}-${String(cursor.getDate()).padStart(2, '0')}`;
      const dayOfWeek = cursor.getDay();
      const amount = spendingMap.get(dateStr) ?? 0;
      const future = cursor > new Date();

      if (dayOfWeek === 0 && currentWeek.length > 0) {
        allWeeks.push(currentWeek);
        currentWeek = [];
      }

      if (cursor.getMonth() !== lastMonth) {
        lastMonth = cursor.getMonth();
        monthLabels.push({
          label: cursor.toLocaleDateString('en-US', { month: 'short' }),
          weekIndex: allWeeks.length,
        });
      }

      currentWeek.push({ date: dateStr, amount, dayOfWeek, future });

      if (!future) {
        total++;
        if (amount <= budget) under++;
      }

      cursor.setDate(cursor.getDate() + 1);
    }
    if (currentWeek.length > 0) allWeeks.push(currentWeek);

    return { weeks: allWeeks, months: monthLabels, underBudgetDays: under, totalDays: total };
  }, [dailyData, streakData, startDate, endDate]);

  if (loadingDaily || loadingStreak) {
    return (
      <div className="bg-surface-raised border border-border rounded-lg p-4">
        <div className="h-[140px] animate-pulse bg-border-muted rounded" />
      </div>
    );
  }

  const svgWidth = LABEL_WIDTH + weeks.length * TOTAL;
  const svgHeight = HEADER_HEIGHT + 7 * TOTAL;
  const budget = streakData?.dailyBudget ?? 50;

  return (
    <div className="bg-surface-raised border border-border rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-xs text-text-secondary uppercase tracking-wide">Spending Heatmap</h3>
        <span className="text-xs text-text-muted">
          Under budget{' '}
          <span className="text-green font-semibold">{underBudgetDays}</span> of last {Math.min(totalDays, 365)} days
        </span>
      </div>
      <div className="overflow-x-auto">
        <svg width={svgWidth} height={svgHeight} className="block">
          {/* Month labels */}
          {months.map((m, i) => (
            <text
              key={i}
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
                fill={day.future ? '#13161d' : getColor(day.amount, budget)}
                className="cursor-pointer"
                onClick={() => onDayClick?.(day.date)}
              >
                <title>
                  {day.date}: ${day.amount.toFixed(2)}
                </title>
              </rect>
            )),
          )}
        </svg>
      </div>
    </div>
  );
}
