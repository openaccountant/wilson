import { useApi } from '@/hooks/useApi';
import { useFilterParams } from '@/hooks/useFilterParams';
import type { BudgetVsActualRow } from '@/types';

function barColor(pct: number): string {
  if (pct <= 70) return '#22c55e';
  if (pct <= 90) return '#eab308';
  return '#ef4444';
}

export function BudgetBars() {
  const params = useFilterParams();
  const { data, loading } = useApi<BudgetVsActualRow[]>(`/api/budgets?${params}`, [params]);

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
        <h3 className="text-xs text-text-secondary uppercase tracking-wide mb-2">Budgets</h3>
        <p className="text-sm text-text-muted">No budgets configured.</p>
      </div>
    );
  }

  return (
    <div className="bg-surface-raised border border-border rounded-lg p-4">
      <h3 className="text-xs text-text-secondary uppercase tracking-wide mb-3">Budgets vs Actual</h3>
      <div className="space-y-2.5">
        {data.map((row) => (
          <div key={row.category}>
            <div className="flex justify-between text-xs mb-1">
              <span className="text-text">{row.category}</span>
              <span className="text-text-muted font-mono">
                ${Math.abs(row.actual).toFixed(0)} / ${row.monthly_limit.toFixed(0)}
              </span>
            </div>
            <div className="h-2 bg-border-muted rounded-full overflow-hidden">
              <div
                className="h-full rounded-full transition-all duration-300"
                style={{
                  width: `${Math.min(row.percent_used, 100)}%`,
                  backgroundColor: barColor(row.percent_used),
                }}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
