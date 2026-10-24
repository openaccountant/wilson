import { Suspense, useMemo } from 'react';
import { useApi } from '@/hooks/useApi';
import { OfflineUnavailable } from '@/components/OfflineUnavailable';
import { ChartCard } from '@/charts/ChartCard';
import { SavingsSparklineChart } from '@/charts/lazyCharts';
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
            {/* recharts loads on demand (charts/lazyCharts.ts); the h-10 box holds the space meanwhile. */}
            <Suspense fallback={null}>
              <SavingsSparklineChart points={points} color={color} mode={mode} fmtValue={fmtValue} />
            </Suspense>
          </div>
        )}
      </div>
    </ChartCard>
  );
}
