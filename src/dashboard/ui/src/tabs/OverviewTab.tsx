import { useState } from 'react';
import { WeeklySummary } from '@/components/WeeklySummary';
import { SpendingHeatmap } from '@/components/SpendingHeatmap';
import { StreakCounter } from '@/components/StreakCounter';
import { BudgetCountdown } from '@/components/BudgetCountdown';
import { SavingsSparkline } from '@/components/SavingsSparkline';
import { DonutChart } from '@/components/DonutChart';
import { PnlCard } from '@/components/PnlCard';
import { BudgetBars } from '@/components/BudgetBars';
import { AlertList } from '@/components/AlertList';
import { LiabilitiesCard } from '@/components/LiabilitiesCard';
import { Dialog } from '@/components/Dialog';
import { useApi } from '@/hooks/useApi';
import type { Transaction } from '@/types';

export function OverviewTab() {
  const [selectedDate, setSelectedDate] = useState<string | null>(null);

  const { data: dayTransactions, loading: dayLoading } = useApi<Transaction[]>(
    `/api/transactions?start=${selectedDate}&end=${selectedDate}&limit=50`,
    [selectedDate],
  );

  const dayTotal = (dayTransactions ?? [])
    .filter((t) => t.amount < 0)
    .reduce((sum, t) => sum + Math.abs(t.amount), 0);

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-4">
      {/* Weekly narrative */}
      <WeeklySummary />

      {/* Heatmap + Streak */}
      <div className="grid grid-cols-[1fr_240px] gap-4">
        <SpendingHeatmap onDayClick={(date) => setSelectedDate(date)} />
        <StreakCounter />
      </div>

      {/* Budget countdown + Savings sparkline */}
      <div className="grid grid-cols-2 gap-4">
        <BudgetCountdown />
        <SavingsSparkline />
      </div>

      {/* Donut + P&L */}
      <div className="grid grid-cols-2 gap-4">
        <DonutChart />
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
                    className={`ml-4 text-sm font-medium whitespace-nowrap ${
                      txn.amount < 0 ? 'text-red' : 'text-green'
                    }`}
                  >
                    {txn.amount < 0 ? '-' : '+'}${Math.abs(txn.amount).toFixed(2)}
                  </span>
                </li>
              ))}
            </ul>
            <div className="mt-4 pt-3 border-t border-border flex items-center justify-between">
              <span className="text-text-secondary text-sm">Total spending</span>
              <span className="text-red text-sm font-semibold">
                -${dayTotal.toFixed(2)}
              </span>
            </div>
          </>
        )}
      </Dialog>
    </div>
  );
}
