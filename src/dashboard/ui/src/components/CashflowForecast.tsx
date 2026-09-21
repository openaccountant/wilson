import { useMemo } from 'react';
import { ComposedChart, Area, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { useApi } from '@/hooks/useApi';
import { runCashflowForecast } from '@/lib/cashflowForecast';
import type { MonthlyCashflowRow, Account } from '@/types';

// Liquid asset subtypes from the account taxonomy
// (src/tools/net-worth/account-types.ts) — the projection starts from
// spendable cash, not total net-worth assets (investment/real_estate/
// vehicle/crypto/other_asset are excluded).
const LIQUID_SUBTYPES = ['checking', 'savings', 'cash'];

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

function fmtUsd(n: number): string {
  const rounded = Math.round(n);
  return rounded < 0
    ? `-$${Math.abs(rounded).toLocaleString('en-US')}`
    : `$${rounded.toLocaleString('en-US')}`;
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
      <div>Median {fmtUsd(d.p50)}</div>
      <div style={{ color: '#a1a1aa' }}>
        Range {fmtUsd(d.p10)}–{fmtUsd(d.p90)}
      </div>
    </div>
  );
}

function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

export function CashflowForecast() {
  // No useFilterParams(): the projection starts from now, so the header's
  // global month/account filters don't apply (same posture as the net-worth
  // surfaces and the savings sparkline).
  const { data: history, loading } = useApi<MonthlyCashflowRow[]>(
    '/api/cashflow/monthly?months=24',
  );
  const { data: accounts } = useApi<Account[]>('/api/accounts');

  const startBalance = useMemo(
    () =>
      (accounts ?? [])
        .filter((a) => a.account_type === 'asset' && LIQUID_SUBTYPES.includes(a.account_subtype))
        .reduce((sum, a) => sum + a.current_balance, 0),
    [accounts],
  );

  const forecast = useMemo(
    () =>
      history
        ? runCashflowForecast({ history, startBalance, startMonth: currentMonth() })
        : null,
    [history, startBalance],
  );

  if (loading) {
    return (
      <div className="bg-surface-raised border border-border rounded-lg p-4">
        <div className="h-[120px] animate-pulse bg-border-muted rounded" />
      </div>
    );
  }

  if (!forecast) {
    return (
      <div className="bg-surface-raised border border-border rounded-lg p-4">
        <h3 className="text-xs text-text-secondary uppercase tracking-wide mb-2">Cash Forecast</h3>
        <p className="text-sm text-text-secondary">
          Not enough history yet — the projection needs a couple of months of income and
          expenses. Import more statements and check back.
        </p>
      </div>
    );
  }

  // Stacked translucent percentile bands around the median line: the chart
  // stacks band widths on top of an invisible p10 base, which stays correct
  // even when the pessimistic edge dips below zero.
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

  const last = forecast.points[forecast.points.length - 1];
  const lowIdx = forecast.points.findIndex((pt) => pt.step > 0 && pt.p10 < 0);
  const takeaway =
    `Median cash in ${last.label}: ${fmtUsd(last.p50)}` +
    (lowIdx >= 0 ? ` — pessimistic path runs low around ${forecast.points[lowIdx].label}` : '');

  return (
    <div className="bg-surface-raised border border-border rounded-lg p-4">
      <h3 className="text-xs text-text-secondary uppercase tracking-wide mb-2">Cash Forecast</h3>
      <div className="h-[160px]">
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
              tickFormatter={(v: number) =>
                Math.abs(v) >= 1000 ? `$${(v / 1000).toFixed(0)}k` : `$${Math.round(v)}`
              }
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
      </div>
      <p className="text-sm text-text mt-2">{takeaway}</p>
      <p className="text-xs text-text-muted mt-2">
        Transfers between accounts and debt payments aren&apos;t modeled.
      </p>
    </div>
  );
}