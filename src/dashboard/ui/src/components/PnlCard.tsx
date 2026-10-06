import { useApi } from '@/hooks/useApi';
import { useFilterParams } from '@/hooks/useFilterParams';
import { useAppState } from '@/state';
import { FilteredBadge } from '@/components/FilteredBadge';
import { OfflineUnavailable } from '@/components/OfflineUnavailable';
import { money } from '@/format';
import type { PnlResponse } from '@/types';

export function PnlCard() {
  const params = useFilterParams();
  // /api/pnl honors the category filter (expense-only for that category).
  const { category } = useAppState();
  const { data, loading, offline } = useApi<PnlResponse>(`/api/pnl?${params}`, [params]);

  if (loading) {
    return (
      <div className="bg-surface-raised border border-border rounded-lg p-4">
        <div className="h-[80px] animate-pulse bg-border-muted rounded" />
      </div>
    );
  }

  if (offline && !data) {
    // Mirror unavailable or never seeded — say so rather than rendering zeros.
    return <OfflineUnavailable title="Profit & Loss" />;
  }

  const income = data?.totalIncome ?? 0;
  const expenses = data?.totalExpenses ?? 0;
  const net = data?.netProfitLoss ?? 0;

  return (
    <div className="bg-surface-raised border border-border rounded-lg p-4">
      <div className="flex items-center justify-between gap-2 mb-3">
        <h3 className="text-xs text-text-secondary uppercase tracking-wide m-0">Profit & Loss</h3>
        <FilteredBadge category={category} />
      </div>
      <div className="grid grid-cols-3 gap-3 text-center">
        <div>
          <div className="text-xs text-text-muted">Income</div>
          <div className="text-xl font-bold font-mono tabular-nums text-green mt-1">{money(Math.abs(income))}</div>
        </div>
        <div>
          <div className="text-xs text-text-muted">Expenses</div>
          <div className="text-xl font-bold font-mono tabular-nums text-red mt-1">{money(Math.abs(expenses))}</div>
        </div>
        <div>
          <div className="text-xs text-text-muted">Net</div>
          <div
            className="text-xl font-bold font-mono tabular-nums mt-1"
            style={{ color: net >= 0 ? '#22c55e' : '#ef4444' }}
          >
            {net > 0 ? '+' : ''}{money(net)}
          </div>
        </div>
      </div>
    </div>
  );
}
