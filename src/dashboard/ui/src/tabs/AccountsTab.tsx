import { useMemo } from 'react';
import {
  AreaChart,
  Area,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  CartesianGrid,
} from 'recharts';
import { useApi } from '@/hooks/useApi';
import { ChartCard } from '@/charts/ChartCard';
import { ChartTooltip } from '@/charts/ChartTooltip';
import { chartTokens } from '@/charts/tokens';
import { formatDate, money, moneyCompact } from '@/format';
import type { Account, NetWorthResponse, NetWorthTrendPoint } from '@/types';

/** Display names keyed by the trend point's dataKey. */
const SERIES_NAMES: Record<string, string> = {
  netWorth: 'Net worth',
  totalAssets: 'Assets',
  totalLiabilities: 'Liabilities',
};

function StatCard({
  label,
  value,
  color,
}: {
  label: string;
  value: number;
  color: 'green' | 'red' | 'auto';
}) {
  const resolved = color === 'auto' ? (value >= 0 ? 'green' : 'red') : color;
  const hex = resolved === 'green' ? '#22c55e' : '#ef4444';

  return (
    <div className="bg-surface-raised border border-border rounded-lg p-4">
      <div className="text-xs text-text-muted uppercase tracking-wide">{label}</div>
      <div className="text-2xl font-bold font-mono tabular-nums mt-1" style={{ color: hex }}>
        {money(value)}
      </div>
    </div>
  );
}

function NetWorthChart({ data, loading }: { data: NetWorthTrendPoint[]; loading: boolean }) {
  const t = chartTokens();
  const first = data[0];
  const last = data[data.length - 1];
  const change = first && last ? last.netWorth - first.netWorth : 0;
  const takeaway =
    first && last && data.length > 1
      ? `Net worth ${change >= 0 ? 'up' : 'down'} ${money(Math.abs(change))} since ${formatDate(first.date)}, now ${money(last.netWorth)}.`
      : undefined;
  return (
    <ChartCard
      title="Net Worth Trend"
      takeaway={takeaway}
      loading={loading}
      hasData={data.length > 0}
      height={240}
      table={{
        columns: [
          { label: 'Date' },
          { label: 'Assets', numeric: true },
          { label: 'Liabilities', numeric: true },
          { label: 'Net worth', numeric: true },
        ],
        rows: data.map((p) => [p.date, money(p.totalAssets), money(p.totalLiabilities), money(p.netWorth)]),
      }}
    >
      <div className="h-[240px]">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data}>
            <defs>
              <linearGradient id="nwFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={t.green} stopOpacity={0.25} />
                <stop offset="100%" stopColor={t.green} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke={t.chartGrid} vertical={false} />
            <XAxis
              dataKey="date"
              tick={{ fill: t.chartAxis, fontSize: 11 }}
              axisLine={false}
              tickLine={false}
            />
            <YAxis
              tick={{ fill: t.chartAxis, fontSize: 11 }}
              axisLine={false}
              tickLine={false}
              tickFormatter={(v: number) => moneyCompact(v)}
              width={60}
            />
            <Tooltip
              content={<ChartTooltip nameFor={(dataKey, name) => SERIES_NAMES[dataKey] ?? name} />}
            />
            <Area
              type="monotone"
              dataKey="netWorth"
              stroke={t.green}
              strokeWidth={2}
              fill="url(#nwFill)"
              dot={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </ChartCard>
  );
}

function AccountCard({ account }: { account: Account }) {
  // Liabilities are stored as positive amounts owed, so a positive balance is bad.
  const isGood = account.account_type === 'liability'
    ? account.current_balance <= 0
    : account.current_balance >= 0;

  return (
    <div className="bg-surface-raised border border-border rounded-lg p-4 flex items-center justify-between">
      <div>
        <div className="text-sm text-text font-medium">{account.name}</div>
        {account.institution && (
          <div className="text-xs text-text-muted mt-0.5">{account.institution}</div>
        )}
      </div>
      <div className={`text-sm font-bold font-mono tabular-nums ${isGood ? 'text-green' : 'text-red'}`}>
        {money(account.current_balance)}
      </div>
    </div>
  );
}

export function AccountsTab() {
  const { data: netWorth, loading: nwLoading } = useApi<NetWorthResponse>('/api/net-worth');
  const { data: trend, loading: trendLoading } = useApi<NetWorthTrendPoint[]>(
    '/api/net-worth/trend?months=12',
  );
  const { data: accounts, loading: acctLoading } = useApi<Account[]>('/api/accounts');

  const grouped = useMemo(() => {
    if (!accounts) return {};
    const groups: Record<string, Account[]> = {};
    for (const acct of accounts) {
      const key = acct.account_type;
      if (!groups[key]) groups[key] = [];
      groups[key].push(acct);
    }
    return groups;
  }, [accounts]);

  const loading = nwLoading || trendLoading || acctLoading;

  if (loading) {
    return (
      <div className="flex-1 overflow-y-auto p-6 space-y-4">
        <div className="grid grid-cols-3 gap-4">
          {[0, 1, 2].map((i) => (
            <div key={i} className="bg-surface-raised border border-border rounded-lg p-4">
              <div className="h-[48px] animate-pulse bg-border-muted rounded" />
            </div>
          ))}
        </div>
        <div className="bg-surface-raised border border-border rounded-lg p-4">
          <div className="h-[240px] animate-pulse bg-border-muted rounded" />
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-4">
      {/* Stat cards */}
      <div className="grid grid-cols-3 gap-4">
        <StatCard label="Total Assets" value={netWorth?.totalAssets ?? 0} color="green" />
        <StatCard label="Total Liabilities" value={netWorth?.totalLiabilities ?? 0} color="red" />
        <StatCard label="Net Worth" value={netWorth?.netWorth ?? 0} color="auto" />
      </div>

      {/* Net worth trend chart */}
      {trend && trend.length > 0 && <NetWorthChart data={trend} loading={trendLoading} />}

      {/* Accounts grouped by type */}
      {Object.keys(grouped).length > 0 ? (
        Object.entries(grouped).map(([type, accts]) => (
          <div key={type}>
            <h3 className="text-xs text-text-secondary uppercase tracking-wide mb-2">{type}</h3>
            <div className="space-y-2">
              {accts.map((acct) => (
                <AccountCard key={acct.id} account={acct} />
              ))}
            </div>
          </div>
        ))
      ) : (
        <div className="bg-surface-raised border border-border rounded-lg p-4">
          <p className="text-sm text-text-muted">No accounts found.</p>
        </div>
      )}
    </div>
  );
}
