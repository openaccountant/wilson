import { useMemo } from 'react';
import { AreaChart, Area, ResponsiveContainer, Tooltip } from 'recharts';
import { useApi } from '@/hooks/useApi';
import type { SavingsPoint } from '@/types';

export function SavingsSparkline() {
  const { data, loading } = useApi<SavingsPoint[]>('/api/savings');

  const { chartData, currentRate, trending } = useMemo(() => {
    if (!data || data.length === 0) {
      return { chartData: [], currentRate: 0, trending: 'up' as const };
    }

    // Take last 6 months
    const recent = data.slice(-6);
    const clamp = (v: number) => Math.max(-100, Math.min(100, v));
    const cd = recent.map((p) => ({
      month: p.month,
      rate: clamp(p.savingsRate),
    }));

    const last = recent[recent.length - 1];
    const prev = recent.length >= 2 ? recent[recent.length - 2] : null;
    const tr = prev ? (last.savingsRate >= prev.savingsRate ? 'up' : 'down') : ('up' as const);

    return { chartData: cd, currentRate: clamp(last.savingsRate), trending: tr };
  }, [data]);

  if (loading) {
    return (
      <div className="bg-surface-raised border border-border rounded-lg p-4">
        <div className="h-[60px] animate-pulse bg-border-muted rounded" />
      </div>
    );
  }

  const color = trending === 'up' ? '#22c55e' : '#ef4444';

  return (
    <div className="bg-surface-raised border border-border rounded-lg p-4">
      <h3 className="text-xs text-text-secondary uppercase tracking-wide mb-2">Savings Rate</h3>
      <div className="flex items-center gap-3">
        <span className="text-2xl font-bold font-mono" style={{ color }}>
          {currentRate.toFixed(0)}%
        </span>
        {chartData.length > 1 && (
          <div className="flex-1 h-10">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData}>
                <defs>
                  <linearGradient id="sparkFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={color} stopOpacity={0.3} />
                    <stop offset="100%" stopColor={color} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <Tooltip
                  contentStyle={{
                    background: '#1a1d27',
                    border: '1px solid #2a2d37',
                    borderRadius: 6,
                    fontSize: 12,
                    color: '#e4e4e7',
                  }}
                  formatter={(value: number) => [`${value.toFixed(1)}%`, 'Rate']}
                  labelFormatter={(label: string) => label}
                />
                <Area
                  type="monotone"
                  dataKey="rate"
                  stroke={color}
                  strokeWidth={2}
                  fill="url(#sparkFill)"
                  dot={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>
    </div>
  );
}
