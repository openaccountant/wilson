import { useApi } from '@/hooks/useApi';
import type { NetWorthResponse } from '@/types';

function fmt(n: number): string {
  return '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function LiabilitiesCard() {
  const { data, loading } = useApi<NetWorthResponse>('/api/net-worth');

  if (loading) {
    return (
      <div className="bg-surface-raised border border-border rounded-lg p-4">
        <div className="h-[80px] animate-pulse bg-border-muted rounded" />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="bg-surface-raised border border-border rounded-lg p-4">
        <h3 className="text-xs text-text-secondary uppercase tracking-wide mb-2">Net Worth</h3>
        <p className="text-sm text-text-muted">No account data.</p>
      </div>
    );
  }

  const liabilities = data.accounts.filter((a) => a.balance < 0);

  return (
    <div className="bg-surface-raised border border-border rounded-lg p-4">
      <h3 className="text-xs text-text-secondary uppercase tracking-wide mb-3">Net Worth</h3>
      <div className="grid grid-cols-3 gap-3 text-center mb-3">
        <div>
          <div className="text-xs text-text-muted">Assets</div>
          <div className="text-lg font-bold font-mono text-green mt-1">{fmt(data.totalAssets)}</div>
        </div>
        <div>
          <div className="text-xs text-text-muted">Liabilities</div>
          <div className="text-lg font-bold font-mono text-red mt-1">{fmt(data.totalLiabilities)}</div>
        </div>
        <div>
          <div className="text-xs text-text-muted">Net</div>
          <div
            className="text-lg font-bold font-mono mt-1"
            style={{ color: data.netWorth >= 0 ? '#22c55e' : '#ef4444' }}
          >
            {fmt(data.netWorth)}
          </div>
        </div>
      </div>
      {liabilities.length > 0 && (
        <div className="space-y-1 border-t border-border pt-2">
          {liabilities.map((acct) => (
            <div key={acct.name} className="flex justify-between text-xs">
              <span className="text-text-muted">{acct.name}</span>
              <span className="font-mono text-red">{fmt(acct.balance)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
