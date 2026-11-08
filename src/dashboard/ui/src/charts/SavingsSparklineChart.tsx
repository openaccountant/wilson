// The Overview sparkline's recharts half, split out so recharts stays off the first paint (see lazyCharts.ts).
import { AreaChart, Area, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { ChartTooltip } from '@/charts/ChartTooltip';
import type { SavingsMode, SavingsSeriesPoint } from '@/lib/savingsSeries';

export interface SavingsSparklineChartProps {
  points: SavingsSeriesPoint[];
  color: string;
  mode: SavingsMode;
  fmtValue: (n: number) => string;
}

export function SavingsSparklineChart({ points, color, mode, fmtValue }: SavingsSparklineChartProps) {
  return (
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
  );
}
