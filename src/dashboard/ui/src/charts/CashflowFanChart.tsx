// The Overview cash-flow fan chart's recharts half, split out so recharts stays off the first paint (see lazyCharts.ts).
import { ComposedChart, Area, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { moneyCompact, moneyWhole } from '@/format';

export interface CashflowChartDatum {
  label: string;
  p10: number;
  p50: number;
  p90: number;
  band25: number;
  band50: number;
  band75: number;
  band90: number;
}

const fmtUsd = moneyWhole;

function FanTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: ReadonlyArray<{ payload: CashflowChartDatum }>;
  label?: string;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const d = payload[0].payload;
  return (
    <div
      style={{
        background: '#1a1d27',
        border: '1px solid #2a2d37',
        borderRadius: 6,
        fontSize: 12,
        color: '#e4e4e7',
        padding: '6px 10px',
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 2 }}>{label}</div>
      <div>Median {fmtUsd(d.p50)}</div>
      <div style={{ color: '#a1a1aa' }}>
        Range {fmtUsd(d.p10)}–{fmtUsd(d.p90)}
      </div>
    </div>
  );
}

export function CashflowFanChart({ chartData }: { chartData: CashflowChartDatum[] }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <ComposedChart data={chartData} margin={{ top: 5, right: 0, bottom: 0, left: 0 }}>
        <XAxis
          dataKey="label"
          tick={{ fontSize: 10, fill: '#a1a1aa' }}
          tickLine={false}
          axisLine={false}
          interval="preserveStartEnd"
        />
        <YAxis
          width={52}
          tick={{ fontSize: 10, fill: '#a1a1aa' }}
          tickLine={false}
          axisLine={false}
          tickFormatter={(v: number) => moneyCompact(v)}
        />
        <Tooltip content={<FanTooltip />} />
        <Area dataKey="p10" stackId="fan" stroke="none" fill="transparent" isAnimationActive={false} />
        <Area dataKey="band25" stackId="fan" stroke="none" fill="#233046" fillOpacity={0.55} isAnimationActive={false} />
        <Area dataKey="band50" stackId="fan" stroke="none" fill="#2e4a6b" fillOpacity={0.55} isAnimationActive={false} />
        <Area dataKey="band75" stackId="fan" stroke="none" fill="#2e4a6b" fillOpacity={0.55} isAnimationActive={false} />
        <Area dataKey="band90" stackId="fan" stroke="none" fill="#233046" fillOpacity={0.55} isAnimationActive={false} />
        <Line dataKey="p50" stroke="#e4e4e7" strokeWidth={2} dot={false} isAnimationActive={false} />
        <Line dataKey="p10" stroke="#ef4444" strokeWidth={1} strokeDasharray="4 4" dot={false} isAnimationActive={false} />
      </ComposedChart>
    </ResponsiveContainer>
  );
}
