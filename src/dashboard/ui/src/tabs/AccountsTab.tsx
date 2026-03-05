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
import type { Account, NetWorthResponse, NetWorthTrendPoint } from '@/types';

function fmt(n: number): string {
  return (
    '$' +
    Math.abs(n).toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
  );
}

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
      <div className="text-2xl font-bold font-mono mt-1" style={{ color: hex }}>
        {value < 0 && '-'}
        {fmt(value)}
      </div>
    </div>
  );
}

function NetWorthChart({ data }: { data: NetWorthTrendPoint[] }) {
  return (
    <div className="bg-surface-raised border border-border rounded-lg p-4">
      <h3 className="text-xs text-text-secondary uppercase tracking-wide mb-3">
        Net Worth Trend
      </h3>
      <div className="h-[240px]">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data}>
            <defs>
              <linearGradient id="nwFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#22c55e" stopOpacity={0.25} />
                <stop offset="100%" stopColor="#22c55e" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#2a2d37" />
            <XAxis
              dataKey="month"
              tick={{ fill: '#71717a', fontSize: 11 }}
              axisLine={false}
              tickLine={false}
            />
            <YAxis
              tick={{ fill: '#71717a', fontSize: 11 }}
              axisLine={false}
              tickLine={false}
              tickFormatter={(v: number) =>
                `$${(v / 1000).toFixed(0)}k`
              }
              width={60}
            />
            <Tooltip
              contentStyle={{
                background: '#1a1d27',
                border: '1px solid #2a2d37',
                borderRadius: 6,
                fontSize: 12,
                color: '#fff',
              }}
              formatter={(value: number, name: string) => [
                fmt(value),
                name === 'netWorth'
                  ? 'Net Worth'
                  : name === 'assets'
                    ? 'Assets'
                    : 'Liabilities',
              ]}
              labelFormatter={(label: string) => label}
            />
            <Area
              type="monotone"
              dataKey="netWorth"
              stroke="#22c55e"
              strokeWidth={2}
              fill="url(#nwFill)"
              dot={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function AccountCard({ account }: { account: Account }) {
  const isPositive = account.balance >= 0;

  return (
    <div className="bg-surface-raised border border-border rounded-lg p-4 flex items-center justify-between">
      <div>
        <div className="text-sm text-text font-medium">{account.name}</div>
        {account.institution && (
          <div className="text-xs text-text-muted mt-0.5">{account.institution}</div>
        )}
      </div>
      <div className={`text-sm font-bold font-mono ${isPositive ? 'text-green' : 'text-red'}`}>
        {account.balance < 0 && '-'}
        {fmt(account.balance)}
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
      const key = acct.type || 'Other';
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
      {trend && trend.length > 0 && <NetWorthChart data={trend} />}

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
