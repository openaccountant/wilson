import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from 'recharts';
import { useApi } from '@/hooks/useApi';
import { useFilterParams } from '@/hooks/useFilterParams';
import type { SpendingSummaryItem } from '@/types';

const COLORS = [
  '#22c55e', '#3b82f6', '#f59e0b', '#ef4444', '#8b5cf6',
  '#06b6d4', '#ec4899', '#14b8a6', '#f97316', '#6366f1',
  '#84cc16', '#e879f9',
];

export function DonutChart() {
  const params = useFilterParams();
  const { data, loading } = useApi<SpendingSummaryItem[]>(`/api/summary?${params}`, [params]);

  if (loading) {
    return (
      <div className="bg-surface-raised border border-border rounded-lg p-4">
        <div className="h-[220px] animate-pulse bg-border-muted rounded" />
      </div>
    );
  }

  if (!data || data.length === 0) {
    return (
      <div className="bg-surface-raised border border-border rounded-lg p-4">
        <h3 className="text-xs text-text-secondary uppercase tracking-wide mb-2">Spending by Category</h3>
        <p className="text-sm text-text-muted">No spending data.</p>
      </div>
    );
  }

  const chartData = data
    .filter((d) => d.total < 0)
    .map((d) => ({ name: d.category || 'Uncategorized', value: Math.abs(d.total) }))
    .sort((a, b) => b.value - a.value);

  return (
    <div className="bg-surface-raised border border-border rounded-lg p-4">
      <h3 className="text-xs text-text-secondary uppercase tracking-wide mb-3">Spending by Category</h3>
      <ResponsiveContainer width="100%" height={200}>
        <PieChart>
          <Pie
            data={chartData}
            cx="50%"
            cy="50%"
            innerRadius={50}
            outerRadius={80}
            paddingAngle={2}
            dataKey="value"
          >
            {chartData.map((_, i) => (
              <Cell key={i} fill={COLORS[i % COLORS.length]} />
            ))}
          </Pie>
          <Tooltip
            contentStyle={{
              background: '#1a1d27',
              border: '1px solid #2a2d37',
              borderRadius: 6,
              fontSize: 12,
              color: '#e4e4e7',
            }}
            formatter={(value: number) => [`$${value.toLocaleString('en-US', { minimumFractionDigits: 2 })}`, '']}
          />
        </PieChart>
      </ResponsiveContainer>
      <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2">
        {chartData.slice(0, 6).map((d, i) => (
          <div key={d.name} className="flex items-center gap-1.5 text-xs text-text-muted">
            <span className="w-2 h-2 rounded-full" style={{ background: COLORS[i % COLORS.length] }} />
            {d.name}
          </div>
        ))}
      </div>
    </div>
  );
}
