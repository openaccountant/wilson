import { useMemo } from 'react';
import { AreaChart, Area, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useApi } from '@/hooks/useApi';
import { OfflineUnavailable } from '@/components/OfflineUnavailable';
import { ChartCard } from '@/charts/ChartCard';
import { ChartTooltip } from '@/charts/ChartTooltip';
import { chartTokens } from '@/charts/tokens';
import { buildSavingsSeries } from '@/lib/savingsSeries';
import { savingsPath } from '@/lib/overviewQueries';
import { useAppState } from '@/state';
import { money, moneyWhole, pct } from '@/format';
import type { SavingsPoint } from '@/types';

export function SavingsSparkline() {
  const { accountId, entityId } = useAppState();
  const { data, loading, offline } = useApi<SavingsPoint[]>(savingsPath({ accountId, entityId, category: null }));

  const series = useMemo(() => buildSavingsSeries(data ?? []), [data]);

  if (offline && !data) {
    // Mirror unavailable or never seeded — say so rather than a fake 0% rate.
    return <OfflineUnavailable title="Savings Rate" />;
  }

  const t = chartTokens();
  const { mode, points, latest, trend, lowIncome } = series;
  const fmtValue = mode === 'net' ? moneyWhole : (n: number) => pct(n, 1);
  const color = trend === 'up' ? t.green : trend === 'down' ? t.red : t.textSecondary;
  const plotted = points.filter((p) => p.value !== null).length;
  const title = mode === 'net' ? 'Net Savings' : 'Savings Rate';

  return (
    <ChartCard
      title={title}
      loading={loading}
      hasData={latest !== null}
      height={60}
      empty={<p className="text-sm text-text-muted">No income or spending in the last 6 months.</p>}
      takeaway={
        lowIncome ? 'Low income data — showing net savings in dollars instead of a rate.' : undefined
      }
      table={{
        columns: [
          { label: 'Month' },
          { label: 'Income', numeric: true },
          { label: 'Expenses', numeric: true },
          { label: mode === 'net' ? 'Net' : 'Rate', numeric: true },
        ],
        rows: points.map((p) => [
          p.month,
          p.income === null ? '—' : money(p.income),
          p.expenses === null ? '—' : money(p.expenses),
          p.value === null ? '—' : fmtValue(p.value),
        ]),
      }}
    >
      <div className="flex items-center gap-3">
        <span className="text-2xl font-bold font-mono tabular-nums" style={{ color }}>
          {latest && latest.value !== null ? (mode === 'net' ? moneyWhole(latest.value) : pct(latest.value)) : '—'}
        </span>
        {plotted > 1 && (
          <div className="flex-1 h-10 min-w-0">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={points}>
                <defs>
                  <linearGradient id="sparkFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={color} stopOpacity={0.3} />
                    <stop offset="100%" stopColor={color} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <XAxis dataKey="month" hide />
                <YAxis hide domain={['auto', 'auto']} />
                <Tooltip
                  content={
                    <ChartTooltip
                      valueFormat={fmtValue}
                      nameFor={() => (mode === 'net' ? 'Net savings' : 'Savings rate')}
                    />
                  }
                />
                <Area
                  type="monotone"
                  dataKey="value"
                  stroke={color}
                  strokeWidth={2}
                  fill="url(#sparkFill)"
                  // A month between two gaps has no segment to draw; give it a dot.
                  dot={(props: { cx?: number; cy?: number; index?: number }) => {
                    const i = props.index ?? -1;
                    const isolated =
                      points[i]?.value != null && points[i - 1]?.value == null && points[i + 1]?.value == null;
                    return isolated && props.cx != null && props.cy != null ? (
                      <circle key={i} cx={props.cx} cy={props.cy} r={2.5} fill={color} />
                    ) : (
                      <g key={i} />
                    );
                  }}
                  connectNulls={false}
                  isAnimationActive={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>
    </ChartCard>
  );
}
