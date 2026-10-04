import { useApi } from '@/hooks/useApi';
import { OfflineUnavailable } from '@/components/OfflineUnavailable';
import { money } from '@/format';
import type { NetWorthResponse } from '@/types';

export function LiabilitiesCard() {
  // Net worth aggregates the accounts table, which the mirror does not carry —
  // outside the approved offline scope, so offline it degrades to an explicit
  // unavailable state rather than zeros.
  const { data, loading, offline } = useApi<NetWorthResponse>('/api/net-worth');

  if (loading) {
    return (
      <div className="bg-surface-raised border border-border rounded-lg p-4">
        <div className="h-[80px] animate-pulse bg-border-muted rounded" />
      </div>
    );
  }

  if (offline && !data) {
    return <OfflineUnavailable title="Net Worth" />;
  }

  if (!data) {
    return (
      <div className="bg-surface-raised border border-border rounded-lg p-4">
        <h3 className="text-xs text-text-secondary uppercase tracking-wide mb-2">Net Worth</h3>
        <p className="text-sm text-text-muted">No account data.</p>
      </div>
    );
  }

  // Liability rows carry a positive current_balance on the wire, so detect by
  // account_type first; a negative current_balance catches overdrawn assets too.
  const liabilities = data.accounts.filter(
    (a) => a.account_type === 'liability' || a.current_balance < 0,
  );

  return (
    <div className="bg-surface-raised border border-border rounded-lg p-4">
      <h3 className="text-xs text-text-secondary uppercase tracking-wide mb-3">Net Worth</h3>
      <div className="grid grid-cols-3 gap-3 text-center mb-3">
        <div>
          <div className="text-xs text-text-muted">Assets</div>
          <div className="text-lg font-bold font-mono tabular-nums text-green mt-1">{money(data.totalAssets)}</div>
        </div>
        <div>
          <div className="text-xs text-text-muted">Liabilities</div>
          {/* Amount owed, shown as a magnitude under the Liabilities label. */}
          <div className="text-lg font-bold font-mono tabular-nums text-red mt-1">{money(Math.abs(data.totalLiabilities))}</div>
        </div>
        <div>
          <div className="text-xs text-text-muted">Net</div>
          <div
            className="text-lg font-bold font-mono tabular-nums mt-1"
            style={{ color: data.netWorth >= 0 ? '#22c55e' : '#ef4444' }}
          >
            {/* Signed: a negative net worth must read '-$161,809.00', not '$161,809.00'. */}
            {money(data.netWorth)}
          </div>
        </div>
      </div>
      {liabilities.length > 0 && (
        <div className="space-y-1 border-t border-border pt-2">
          {liabilities.map((acct) => (
            <div key={acct.id} className="flex justify-between text-xs">
              <span className="text-text-muted">{acct.name}</span>
              {/* Owed amounts listed as magnitudes (overdrawn assets carry a negative balance). */}
              <span className="font-mono tabular-nums text-red">{money(Math.abs(acct.current_balance))}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
