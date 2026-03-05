import { useMemo } from 'react';
import { useApi } from '@/hooks/useApi';
import type { Goal } from '@/types';

function fmt(n: number): string {
  return (
    '$' +
    Math.abs(n).toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
  );
}

function barColor(pct: number): string {
  if (pct <= 70) return '#22c55e';
  if (pct <= 90) return '#eab308';
  return '#ef4444';
}

function statusColor(status: Goal['status']): string {
  switch (status) {
    case 'active':
      return '#22c55e';
    case 'completed':
      return '#3b82f6';
    case 'paused':
      return '#eab308';
    case 'abandoned':
      return '#71717a';
  }
}

function GoalCard({ goal }: { goal: Goal }) {
  const isFinancial = goal.goal_type === 'financial';
  const pct =
    isFinancial && goal.target_amount
      ? Math.round((goal.current_amount / goal.target_amount) * 100)
      : null;

  return (
    <div className="bg-surface-raised border border-border rounded-lg p-4">
      <div className="flex items-center justify-between mb-2">
        <div className="text-sm text-text font-medium">{goal.title}</div>
        <div className="flex gap-2">
          <span
            className="text-[10px] uppercase tracking-wide font-medium px-1.5 py-0.5 rounded"
            style={{
              backgroundColor: isFinancial ? 'rgba(34,197,94,0.15)' : 'rgba(168,85,247,0.15)',
              color: isFinancial ? '#22c55e' : '#a855f7',
            }}
          >
            {goal.goal_type}
          </span>
          <span
            className="text-[10px] uppercase tracking-wide font-medium px-1.5 py-0.5 rounded"
            style={{
              backgroundColor: `${statusColor(goal.status)}22`,
              color: statusColor(goal.status),
            }}
          >
            {goal.status}
          </span>
        </div>
      </div>

      {isFinancial && goal.target_amount != null && pct != null ? (
        <>
          <div className="flex justify-between text-xs mb-1">
            <span className="text-text-muted font-mono">
              {fmt(goal.current_amount)} / {fmt(goal.target_amount)}
            </span>
            <span className="text-text-muted">{pct}%</span>
          </div>
          <div className="h-2 bg-border-muted rounded-full overflow-hidden">
            <div
              className="h-full rounded-full transition-all duration-300"
              style={{
                width: `${Math.min(pct, 100)}%`,
                backgroundColor: barColor(pct),
              }}
            />
          </div>
          {goal.target_date && (
            <div className="text-xs text-text-muted mt-2">
              Target: {goal.target_date}
            </div>
          )}
        </>
      ) : (
        <div className="text-xs text-text-muted">
          {goal.category && <span>Category: {goal.category}</span>}
          {goal.notes && <span className="block mt-1">{goal.notes}</span>}
        </div>
      )}
    </div>
  );
}

export function GoalsTab() {
  const { data: goals, loading } = useApi<Goal[]>('/api/goals');

  const { activeCount, completedCount, avgProgress, grouped } = useMemo(() => {
    if (!goals) return { activeCount: 0, completedCount: 0, avgProgress: 0, grouped: {} };

    const active = goals.filter((g) => g.status === 'active');
    const completed = goals.filter((g) => g.status === 'completed');

    const financialActive = active.filter(
      (g) => g.goal_type === 'financial' && g.target_amount
    );
    const avg =
      financialActive.length > 0
        ? Math.round(
            financialActive.reduce(
              (sum, g) => sum + (g.current_amount / (g.target_amount ?? 1)) * 100,
              0
            ) / financialActive.length
          )
        : 0;

    const order: Goal['status'][] = ['active', 'paused', 'completed', 'abandoned'];
    const groups: Record<string, Goal[]> = {};
    for (const status of order) {
      const items = goals.filter((g) => g.status === status);
      if (items.length > 0) groups[status] = items;
    }

    return { activeCount: active.length, completedCount: completed.length, avgProgress: avg, grouped: groups };
  }, [goals]);

  if (loading) {
    return (
      <div className="flex-1 overflow-y-auto p-6 space-y-4">
        <div className="grid grid-cols-3 gap-4">
          {[0, 1, 2].map((i) => (
            <div key={i} className="bg-surface-raised border border-border rounded-lg p-4">
              <div className="h-[48px] animate-pulse bg-border-muted rounded" />
            </div>
          ))}
        </div>
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className="bg-surface-raised border border-border rounded-lg p-4">
              <div className="h-[60px] animate-pulse bg-border-muted rounded" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-4">
      {/* Stat cards */}
      <div className="grid grid-cols-3 gap-4">
        <div className="bg-surface-raised border border-border rounded-lg p-4">
          <div className="text-xs text-text-muted uppercase tracking-wide">Active Goals</div>
          <div className="text-2xl font-bold font-mono mt-1 text-green">{activeCount}</div>
        </div>
        <div className="bg-surface-raised border border-border rounded-lg p-4">
          <div className="text-xs text-text-muted uppercase tracking-wide">Completed</div>
          <div className="text-2xl font-bold font-mono mt-1" style={{ color: '#3b82f6' }}>
            {completedCount}
          </div>
        </div>
        <div className="bg-surface-raised border border-border rounded-lg p-4">
          <div className="text-xs text-text-muted uppercase tracking-wide">Avg Progress</div>
          <div className="text-2xl font-bold font-mono mt-1 text-green">{avgProgress}%</div>
        </div>
      </div>

      {/* Goal cards grouped by status */}
      {Object.keys(grouped).length > 0 ? (
        Object.entries(grouped).map(([status, items]) => (
          <div key={status}>
            <h3 className="text-xs text-text-secondary uppercase tracking-wide mb-2">
              {status}
            </h3>
            <div className="space-y-2">
              {items.map((goal) => (
                <GoalCard key={goal.id} goal={goal} />
              ))}
            </div>
          </div>
        ))
      ) : (
        <div className="bg-surface-raised border border-border rounded-lg p-4">
          <p className="text-sm text-text-muted">
            No goals yet. Use the <code className="text-green">goal_manage</code> tool to create goals.
          </p>
        </div>
      )}
    </div>
  );
}
