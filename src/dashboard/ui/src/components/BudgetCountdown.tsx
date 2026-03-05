import { useApi } from '@/hooks/useApi';
import { useAppState } from '@/state';
import type { BudgetCountdownItem } from '@/types';

function barColor(percent: number): string {
  if (percent <= 60) return '#22c55e';
  if (percent <= 85) return '#eab308';
  return '#ef4444';
}

export function BudgetCountdown() {
  const { dateRange } = useAppState();
  const month = dateRange.startDate.slice(0, 7);
  const { data, loading } = useApi<BudgetCountdownItem[]>(`/api/budget-countdown?month=${month}`, [month]);

  if (loading) {
    return (
      <div className="bg-surface-raised border border-border rounded-lg p-4">
        <div className="h-[120px] animate-pulse bg-border-muted rounded" />
      </div>
    );
  }

  if (!data || data.length === 0) {
    return (
      <div className="bg-surface-raised border border-border rounded-lg p-4">
        <h3 className="text-xs text-text-secondary uppercase tracking-wide mb-2">Budget Countdown</h3>
        <p className="text-sm text-text-muted">No budgets configured.</p>
      </div>
    );
  }

  const sorted = [...data].sort((a, b) => {
    const pctA = a.limit > 0 ? (a.spent / a.limit) * 100 : 0;
    const pctB = b.limit > 0 ? (b.spent / b.limit) * 100 : 0;
    return pctB - pctA;
  });

  return (
    <div className="bg-surface-raised border border-border rounded-lg p-4">
      <h3 className="text-xs text-text-secondary uppercase tracking-wide mb-3">Budget Countdown</h3>
      <div className="space-y-3">
        {sorted.map((item) => {
          const pct = item.limit > 0 ? Math.min((item.spent / item.limit) * 100, 100) : 0;
          return (
            <div key={item.category}>
              <div className="flex justify-between text-xs mb-1">
                <span className="text-text">{item.category}</span>
                <span className="text-text-muted font-mono">
                  ${item.remaining.toFixed(0)} left &middot; {item.daysLeft}d &middot; ${item.perDay.toFixed(2)}/day
                </span>
              </div>
              <div className="h-2 bg-border-muted rounded-full overflow-hidden">
                <div
                  className="h-full rounded-full transition-all duration-300"
                  style={{ width: `${pct}%`, backgroundColor: barColor(pct) }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
