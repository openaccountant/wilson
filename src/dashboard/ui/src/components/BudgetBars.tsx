import { useApi } from '@/hooks/useApi';
import { useFilterParams } from '@/hooks/useFilterParams';
import { OfflineUnavailable } from '@/components/OfflineUnavailable';
import { ChartCard } from '@/charts/ChartCard';
import { chartTokens } from '@/charts/tokens';
import { moneyWhole, pct } from '@/format';
import { budgetLimitScaleLabel, budgetTakeaway } from '@/lib/budgetBars';
import type { BudgetVsActualRow } from '@/types';

function barColor(pctUsed: number): string {
  const t = chartTokens();
  if (pctUsed <= 70) return t.green;
  if (pctUsed <= 90) return t.yellow;
  return t.red;
}

export function BudgetBars() {
  const params = useFilterParams();
  const { data, loading, offline } = useApi<BudgetVsActualRow[]>(`/api/budgets?${params}`, [params]);

  if (offline && !data) {
    // Mirror unavailable or never seeded — say so rather than "No budgets configured."
    return <OfflineUnavailable title="Budgets" />;
  }

  const rows = data ?? [];
  const takeaway = budgetTakeaway(rows);
  const scaleLabel = budgetLimitScaleLabel(rows);

  return (
    <ChartCard
      title="Budgets vs Actual"
      takeaway={takeaway}
      loading={loading}
      hasData={rows.length > 0}
      height={120}
      empty={<p className="text-sm text-text-muted">No budgets configured.</p>}
      headerRight={
        scaleLabel ? <span className="text-[10px] text-text-muted tabular-nums">{scaleLabel}</span> : undefined
      }
      table={{
        columns: [
          { label: 'Category' },
          { label: 'Spent', numeric: true },
          { label: 'Limit', numeric: true },
          { label: 'Used', numeric: true },
        ],
        rows: rows.map((r) => [
          r.category,
          moneyWhole(Math.abs(r.actual)),
          moneyWhole(r.limit ?? r.monthly_limit),
          pct(r.percent_used),
        ]),
      }}
    >
      <div className="space-y-2.5">
        {rows.map((row) => (
          <div key={row.category}>
            <div className="flex justify-between text-xs mb-1">
              <span className="text-text">{row.category}</span>
              <span className="text-text-muted font-mono tabular-nums">
                {moneyWhole(Math.abs(row.actual))} / {moneyWhole(row.limit ?? row.monthly_limit)}
              </span>
            </div>
            <div className="h-2 bg-border-muted rounded-full overflow-hidden">
              <div
                className="h-full rounded-full transition-all duration-300"
                style={{
                  width: `${Math.max(0, Math.min(row.percent_used, 100))}%`,
                  backgroundColor: barColor(row.percent_used),
                }}
              />
            </div>
          </div>
        ))}
      </div>
    </ChartCard>
  );
}
