import { useMemo, useState } from 'react';
import { ComposedChart, Area, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { useApi } from '@/hooks/useApi';
import {
  runCashflowForecast,
  WHATIF_MIN_PCT,
  WHATIF_MAX_PCT,
  WHATIF_STEP,
} from '@/lib/cashflowForecast';
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

/** Signed what-if label: '+25%', '-25%', '0%'. */
function pctLabel(pct: number): string {
  if (pct === 100) return '0%';
  return pct > 100 ? `+${pct - 100}%` : `-${100 - pct}%`;
}

const HORIZON_OPTIONS = [
  { id: 6, label: '6m' },
  { id: 12, label: '12m' },
  { id: 24, label: '24m' },
] as const;

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

  // What-if controls: pure client state — adjusting them re-runs the already-
  // fetched history through the seeded engine in place (no refetch ever
  // happens; the data deps of the memo below are unchanged).
  const [horizon, setHorizon] = useState(12);
  const [incomePct, setIncomePct] = useState(100); // percent, 50..150
  const [expensePct, setExpensePct] = useState(100);
  const atBaseline = horizon === 12 && incomePct === 100 && expensePct === 100;

  const forecast = useMemo(
    () =>
      history
        ? runCashflowForecast({
            history,
            startBalance,
            startMonth: currentMonth(),
            horizonMonths: horizon,
            incomeScale: incomePct / 100,
            expenseScale: expensePct / 100,
          })
        : null,
    [history, startBalance, horizon, incomePct, expensePct],
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

  // When assumptions are off-baseline, say so on the takeaway line so the
  // numbers stay self-describing.
  const adjustments: string[] = [];
  if (incomePct !== 100)
    adjustments.push(`income ${incomePct > 100 ? '+' : '-'}${Math.abs(incomePct - 100)}%`);
  if (expensePct !== 100)
    adjustments.push(`expenses ${expensePct > 100 ? '+' : '-'}${Math.abs(expensePct - 100)}%`);
  const takeawayFull =
    adjustments.length > 0 ? `${takeaway} · assuming ${adjustments.join(', ')}` : takeaway;

  return (
    <div className="bg-surface-raised border border-border rounded-lg p-4">
      <h3 className="text-xs text-text-secondary uppercase tracking-wide mb-2">Cash Forecast</h3>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-0.5 bg-surface border border-border rounded-md p-0.5">
          {HORIZON_OPTIONS.map((opt) => (
            <button
              key={opt.id}
              type="button"
              aria-pressed={horizon === opt.id}
              onClick={() => setHorizon(opt.id)}
              className={`px-2 py-1 text-xs font-medium rounded cursor-pointer border-none transition-colors ${
                horizon === opt.id
                  ? 'bg-green/20 text-green'
                  : 'bg-transparent text-text-muted hover:text-text'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => {
            setHorizon(12);
            setIncomePct(100);
            setExpensePct(100);
          }}
          disabled={atBaseline}
          className="bg-transparent text-text-muted border border-border px-2 py-1 text-xs rounded cursor-pointer hover:text-text disabled:cursor-not-allowed disabled:opacity-50"
        >
          Reset
        </button>
      </div>
      <div className="grid grid-cols-2 gap-3 mb-1">
        <div>
          <div className="flex items-center justify-between text-xs">
            <span className="text-text-muted">Income</span>
            <span className={incomePct !== 100 ? 'text-green' : 'text-text-muted'}>
              {pctLabel(incomePct)}
            </span>
          </div>
          <input
            type="range"
            min={WHATIF_MIN_PCT}
            max={WHATIF_MAX_PCT}
            step={WHATIF_STEP}
            value={incomePct}
            onChange={(e) => setIncomePct(Number(e.target.value))}
            className="w-full accent-green cursor-pointer"
            aria-label="Assumed monthly income, percent of history"
          />
        </div>
        <div>
          <div className="flex items-center justify-between text-xs">
            <span className="text-text-muted">Expenses</span>
            <span className={expensePct !== 100 ? 'text-green' : 'text-text-muted'}>
              {pctLabel(expensePct)}
            </span>
          </div>
          <input
            type="range"
            min={WHATIF_MIN_PCT}
            max={WHATIF_MAX_PCT}
            step={WHATIF_STEP}
            value={expensePct}
            onChange={(e) => setExpensePct(Number(e.target.value))}
            className="w-full accent-green cursor-pointer"
            aria-label="Assumed monthly expense, percent of history"
          />
        </div>
      </div>
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
      <p className="text-sm text-text mt-2">{takeawayFull}</p>
      <p className="text-xs text-text-muted mt-2">
        Transfers between accounts and debt payments aren&apos;t modeled.
      </p>
    </div>
  );
}