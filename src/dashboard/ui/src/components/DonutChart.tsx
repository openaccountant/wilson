import { useMemo } from 'react';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from 'recharts';
import { useApi } from '@/hooks/useApi';
import { useFilterParams } from '@/hooks/useFilterParams';
import { OfflineUnavailable } from '@/components/OfflineUnavailable';
import { ChartCard } from '@/charts/ChartCard';
import { ChartTooltip } from '@/charts/ChartTooltip';
import { useCategoryColor } from '@/charts/usePalette';
import { chartTokens } from '@/charts/tokens';
import { buildDonutData } from '@/lib/donutData';
import { money, pct } from '@/format';
import type { SpendingSummaryItem } from '@/types';

export function DonutChart() {
  const params = useFilterParams();
  const { data, loading, offline } = useApi<SpendingSummaryItem[]>(`/api/summary?${params}`, [params]);
  const colorFor = useCategoryColor();

  const { slices, total } = useMemo(() => buildDonutData(data ?? []), [data]);

  if (offline && !data) {
    // Mirror unavailable or never seeded — say so rather than "No spending data."
    return <OfflineUnavailable title="Spending by Category" />;
  }

  const top = slices[0];
  const takeaway =
    top && total > 0
      ? `${top.name} leads at ${pct((top.value / total) * 100)} of ${money(total)} spent.`
      : undefined;

  return (
    <ChartCard
      title="Spending by Category"
      takeaway={takeaway}
      loading={loading}
      hasData={slices.length > 0}
      height={240}
      empty={<p className="text-sm text-text-muted">No spending data.</p>}
      table={{
        columns: [
          { label: 'Category' },
          { label: 'Spent', numeric: true },
          { label: 'Share', numeric: true },
          { label: 'Txns', numeric: true },
        ],
        rows: slices.map((s) => [s.name, money(s.value), pct((s.value / total) * 100, 1), s.count]),
      }}
    >
      <ResponsiveContainer width="100%" height={200}>
        <PieChart>
          <Pie
            data={slices}
            cx="50%"
            cy="50%"
            innerRadius={50}
            outerRadius={80}
            paddingAngle={2}
            stroke={chartTokens().surfaceRaised}
            strokeWidth={2}
            dataKey="value"
            nameKey="name"
          >
            {slices.map((s) => (
              <Cell key={s.name} fill={colorFor(s.name)} />
            ))}
          </Pie>
          <Tooltip content={<ChartTooltip total={total} countKey="count" colorFor={colorFor} labelFormat={() => null} />} />
        </PieChart>
      </ResponsiveContainer>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 mt-2 list-none p-0 m-0">
        {slices.slice(0, 6).map((d) => (
          <li key={d.name} className="flex items-center gap-1.5 text-xs text-text-muted">
            <span aria-hidden="true" className="w-2 h-2 rounded-full" style={{ background: colorFor(d.name) }} />
            {d.name}
          </li>
        ))}
      </ul>
    </ChartCard>
  );
}
