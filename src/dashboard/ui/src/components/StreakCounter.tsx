import { useApi } from '@/hooks/useApi';
import type { StreakData } from '@/types';

export function StreakCounter() {
  const { data, loading } = useApi<StreakData>('/api/streak');

  if (loading) {
    return (
      <div className="bg-surface-raised border border-border rounded-lg p-4">
        <div className="h-[80px] animate-pulse bg-border-muted rounded" />
      </div>
    );
  }

  const current = data?.current ?? 0;
  const longest = data?.longest ?? 0;
  const isActive = current > 0;

  return (
    <div className="bg-surface-raised border border-border rounded-lg p-4">
      <h3 className="text-xs text-text-secondary uppercase tracking-wide mb-3">Streak</h3>
      <div className="flex items-baseline gap-2">
        <span className="text-4xl font-bold" style={{ color: isActive ? '#22c55e' : '#71717a' }}>
          {current}
        </span>
        <span className={`text-sm ${isActive ? 'text-green' : 'text-text-muted'}`}>
          {current === 1 ? 'day' : 'days'} under budget
        </span>
      </div>
      <div className="text-xs text-text-muted mt-2">
        Personal best: <span className="text-text">{longest} days</span>
      </div>
    </div>
  );
}
