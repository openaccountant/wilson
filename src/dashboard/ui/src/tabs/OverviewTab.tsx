import { WeeklySummary } from '@/components/WeeklySummary';
import { SpendingHeatmap } from '@/components/SpendingHeatmap';
import { StreakCounter } from '@/components/StreakCounter';
import { BudgetCountdown } from '@/components/BudgetCountdown';
import { SavingsSparkline } from '@/components/SavingsSparkline';
import { CashflowForecast } from '@/components/CashflowForecast';
import { SpendingDrill } from '@/components/spending/SpendingDrill';
import { FilteredBadge } from '@/components/FilteredBadge';
import { PnlCard } from '@/components/PnlCard';
import { BudgetBars } from '@/components/BudgetBars';
import { AlertList } from '@/components/AlertList';
import { LiabilitiesCard } from '@/components/LiabilitiesCard';
import { Dialog } from '@/components/Dialog';
import { useApi } from '@/hooks/useApi';
import { useMirrorStatus } from '@/hooks/useMirrorSync';
import { useUrlState } from '@/hooks/useUrlState';
import { useAppState } from '@/state';
import { dayTransactionsPath, daySpendTotal } from '@/lib/overviewQueries';
import { money } from '@/format';
import type { Transaction } from '@/types';

export function OverviewTab() {
  // The open day dialog lives in the URL (`day=YYYY-MM-DD`) so it survives a
  // reload and can be linked.
  const { state: url, navigate } = useUrlState();
  const selectedDate = url.day;
  const setSelectedDate = (day: string | null) => navigate((s) => ({ ...s, day }), { mode: 'replace' });
  const { accountId, entityId, category } = useAppState();
  const mirror = useMirrorStatus();

  // Only fetch while a day is open (null path = skip), scoped to the same
  // header filters as the heatmap so the dialog total matches the cell.
  const dayPath = dayTransactionsPath(selectedDate, { accountId, entityId, category });
  const { data: dayTransactions, loading: dayLoading } = useApi<Transaction[]>(dayPath);

  const dayTotal = daySpendTotal(dayTransactions ?? []);

  return (
    // pb-20: a safe area under the last row so the floating 'Agent access'
    // pill (fixed bottom-left, webmcp-bridge.ts) never covers card footnotes.
    <div className="flex-1 overflow-y-auto p-6 pb-20 space-y-4">
      {/* Offline pill — same affordance as the transactions tab */}
      {mirror.available && mirror.seeded && !mirror.online && (
        <div className="flex items-center gap-2">
          <span
            data-testid="offline-pill"
            className="text-[10px] px-2 py-0.5 rounded-full bg-amber-400/10 text-amber-500 uppercase tracking-wide"
          >
            Offline — showing synced data
          </span>
        </div>
      )}

      {/* Weekly narrative */}
      <WeeklySummary />

      {/* Heatmap + Streak */}
      <div className="grid grid-cols-[1fr_240px] gap-4">
        <SpendingHeatmap onDayClick={(date) => setSelectedDate(date)} />
        <StreakCounter />
      </div>

      {/* Budget countdown + Savings sparkline + Cash forecast */}
      <div className="grid grid-cols-3 gap-4">
        <BudgetCountdown />
        <SavingsSparkline />
        <CashflowForecast />
      </div>

      {/* Spending drill-down (L1 categories → L2 merchants → L3 merchant → txn) + P&L */}
      <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,1fr)] gap-4 items-start">
        <SpendingDrill />
        <PnlCard />
      </div>

      {/* Budget bars + Alerts + Liabilities */}
      <div className="grid grid-cols-3 gap-4">
        <BudgetBars />
        <AlertList />
        <LiabilitiesCard />
      </div>

      {/* Day-click detail modal */}
      <Dialog
        open={selectedDate !== null}
        onClose={() => setSelectedDate(null)}
        title={selectedDate ?? ''}
      >
        {category && (
          <div className="mb-3">
            <FilteredBadge category={category} />
          </div>
        )}
        {dayLoading ? (
          <p className="text-text-secondary text-sm">Loading...</p>
        ) : !dayTransactions || dayTransactions.length === 0 ? (
          <p className="text-text-secondary text-sm">No transactions on this day.</p>
        ) : (
          <>
            <ul className="space-y-2">
              {dayTransactions.map((txn) => (
                <li
                  key={txn.id}
                  className="flex items-center justify-between bg-surface-raised border border-border rounded px-3 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-text text-sm truncate">
                      {txn.merchant_name ?? txn.description}
                    </p>
                    {txn.category && (
                      <p className="text-text-secondary text-xs">{txn.category}</p>
                    )}
                  </div>
                  <span
                    className={`ml-4 text-sm font-medium whitespace-nowrap tabular-nums ${
                      txn.amount < 0 ? 'text-red' : 'text-green'
                    }`}
                  >
                    {txn.amount > 0 ? '+' : ''}
                    {money(txn.amount)}
                  </span>
                </li>
              ))}
            </ul>
            <div className="mt-4 pt-3 border-t border-border flex items-center justify-between">
              <span className="text-text-secondary text-sm">Total spending</span>
              <span className="text-red text-sm font-semibold tabular-nums">
                {money(-dayTotal)}
              </span>
            </div>
          </>
        )}
      </Dialog>
    </div>
  );
}
