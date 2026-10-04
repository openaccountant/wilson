import { ComposedChart, Area, Line, XAxis, YAxis, Tooltip, ReferenceLine, ResponsiveContainer } from 'recharts';
import type { NetWorthForecast } from '@/lib/netWorthForecast';
import { moneyCompact, moneyWhole } from '@/format';

interface ChartDatum {
  label: string;
  p10: number;
  p50: number;
  p90: number;
  band25: number;
  band50: number;
  band75: number;
  band90: number;
}

function FanTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: ReadonlyArray<{ payload: ChartDatum }>;
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
      <div>Median {moneyWhole(d.p50)}</div>
      <div style={{ color: '#a1a1aa' }}>
        10th–90th percentile {moneyWhole(d.p10)}–{moneyWhole(d.p90)}
      </div>
    </div>
  );
}

export function ForecastFanChart({ forecast }: { forecast: NetWorthForecast }) {
  // Same technique as CashflowForecast.tsx: stack band deltas on an invisible
  // p10 base so the fan stays correct even when the pessimistic edge dips
  // below zero.
  const chartData: ChartDatum[] = forecast.points.map((pt) => ({
    label: pt.label,
    p10: pt.p10,
    p50: pt.p50,
    p90: pt.p90,
    band25: pt.p25 - pt.p10,
    band50: pt.p50 - pt.p25,
    band75: pt.p75 - pt.p50,
    band90: pt.p90 - pt.p75,
  }));

  const showZeroLine = forecast.points.some((p) => p.p10 < 0);

  return (
    <div className="h-[360px]">
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
            width={56}
            tick={{ fontSize: 10, fill: '#a1a1aa' }}
            tickLine={false}
            axisLine={false}
            tickFormatter={(v: number) => moneyCompact(v)}
          />
          <Tooltip content={<FanTooltip />} />
          {showZeroLine && <ReferenceLine y={0} stroke="#2a2d37" />}
          <Area dataKey="p10" stackId="fan" stroke="none" fill="transparent" isAnimationActive={false} />
          <Area dataKey="band25" stackId="fan" stroke="none" fill="#233046" fillOpacity={0.55} isAnimationActive={false} />
          <Area dataKey="band50" stackId="fan" stroke="none" fill="#2e4a6b" fillOpacity={0.55} isAnimationActive={false} />
          <Area dataKey="band75" stackId="fan" stroke="none" fill="#2e4a6b" fillOpacity={0.55} isAnimationActive={false} />
          <Area dataKey="band90" stackId="fan" stroke="none" fill="#233046" fillOpacity={0.55} isAnimationActive={false} />
          <Line dataKey="p50" stroke="#e4e4e7" strokeWidth={2} dot={false} isAnimationActive={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
