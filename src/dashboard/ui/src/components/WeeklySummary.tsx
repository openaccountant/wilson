import { useApi } from '@/hooks/useApi';
import type { WeeklySummaryData, StreakData } from '@/types';

export function WeeklySummary() {
  const { data: weekData, loading: loadingWeek } = useApi<WeeklySummaryData>('/api/weekly-summary');
  const { data: streakData, loading: loadingStreak } = useApi<StreakData>('/api/streak');

  if (loadingWeek || loadingStreak) {
    return (
      <div className="bg-surface-raised border border-border rounded-lg p-4">
        <div className="h-[60px] animate-pulse bg-border-muted rounded" />
      </div>
    );
  }

  if (!weekData) {
    return (
      <div className="bg-surface-raised border border-border rounded-lg p-4">
        <h3 className="text-xs text-text-secondary uppercase tracking-wide mb-2">This Week</h3>
        <p className="text-sm text-text-muted">No spending data yet.</p>
      </div>
    );
  }

  const { thisWeek, change } = weekData;
  const isDown = change.amount <= 0;
  const arrow = isDown ? '\u2193' : '\u2191';
  const changeColor = isDown ? 'text-green' : 'text-red';
  const pctText = Math.abs(change.percent).toFixed(0);

  const topCat = thisWeek.byCategory.length > 0
    ? thisWeek.byCategory.reduce((a, b) => (b.total > a.total ? b : a))
    : null;

  const streak = streakData?.current ?? 0;

  return (
    <div className="bg-surface-raised border border-border rounded-lg p-4">
      <h3 className="text-xs text-text-secondary uppercase tracking-wide mb-2">This Week</h3>
      <p className="text-sm text-text leading-relaxed">
        <span className="font-mono font-semibold text-text">
          ${Math.abs(thisWeek.total).toLocaleString('en-US', { minimumFractionDigits: 2 })}
        </span>{' '}
        spent{' '}
        <span className={`font-semibold ${changeColor}`}>
          ({arrow}{pctText}% vs last week)
        </span>
        {topCat && (
          <>
            . Top category:{' '}
            <span className="text-text">{topCat.category}</span>{' '}
            <span className="font-mono text-text-muted">
              (${Math.abs(topCat.total).toLocaleString('en-US', { minimumFractionDigits: 2 })})
            </span>
          </>
        )}
        {streak > 0 && (
          <>
            . Streak: <span className="text-green font-semibold">{streak} days</span>
          </>
        )}
        .
      </p>
    </div>
  );
}
