// The spending drill's donut (recharts), split out so recharts stays off the Overview's first paint (see lazyCharts.ts).
import { PieChart, Pie, Cell, Tooltip } from 'recharts';
import { ChartTooltip } from '@/charts/ChartTooltip';
import { chartTokens } from '@/charts/tokens';
import type { DonutSlice } from '@/lib/drill';

export interface SpendingDonutProps {
  size: number;
  slices: DonutSlice[];
  total: number;
  highlight: string | null;
  onHighlight: (key: string | null) => void;
}

export function SpendingDonut({ size, slices, total, highlight, onHighlight }: SpendingDonutProps) {
  return (
    <PieChart width={size} height={size}>
      <Pie
        data={slices}
        dataKey="value"
        nameKey="name"
        cx="50%"
        cy="50%"
        innerRadius={36}
        outerRadius={60}
        paddingAngle={1.5}
        stroke={chartTokens().surfaceRaised}
        strokeWidth={2}
        isAnimationActive={false}
        onMouseEnter={(_, index) => onHighlight(slices[index]?.key ?? null)}
        onMouseLeave={() => onHighlight(null)}
      >
        {slices.map((s) => (
          <Cell
            key={s.key}
            fill={s.color}
            fillOpacity={highlight == null || highlight === s.key ? 1 : 0.3}
          />
        ))}
      </Pie>
      <Tooltip content={<ChartTooltip total={total} labelFormat={() => null} colorFor={(name) => slices.find((s) => s.name === name)?.color} />} />
    </PieChart>
  );
}
