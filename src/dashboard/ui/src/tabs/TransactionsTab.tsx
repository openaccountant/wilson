import { useState, useMemo } from 'react';
import { useApi } from '@/hooks/useApi';
import { useAppState } from '@/state';
import type { Transaction } from '@/types';

function formatAmount(amount: number): string {
  const abs = Math.abs(amount);
  return `${amount < 0 ? '-' : ''}$${abs.toFixed(2)}`;
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function TransactionsTab() {
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const { dateRange, accountId, category: globalCategory } = useAppState();

  const apiPath = useMemo(() => {
    const parts = [`start=${dateRange.startDate}`, `end=${dateRange.endDate}`, 'limit=500'];
    if (accountId != null) parts.push(`accountId=${accountId}`);
    if (globalCategory) parts.push(`category=${encodeURIComponent(globalCategory)}`);
    return `/api/transactions?${parts.join('&')}`;
  }, [dateRange, accountId, globalCategory]);

  const { data, loading, error } = useApi<Transaction[]>(apiPath, [apiPath]);

  const categories = useMemo(() => {
    if (!data) return [];
    const set = new Set<string>();
    for (const tx of data) {
      if (tx.category) set.add(tx.category);
    }
    return Array.from(set).sort();
  }, [data]);

  const filtered = useMemo(() => {
    if (!data) return [];
    return data.filter((tx) => {
      if (search) {
        const q = search.toLowerCase();
        const merchant = (tx.merchant_name ?? '').toLowerCase();
        const desc = tx.description.toLowerCase();
        if (!merchant.includes(q) && !desc.includes(q)) return false;
      }
      if (categoryFilter && tx.category !== categoryFilter) return false;
      return true;
    });
  }, [data, search, categoryFilter]);

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Fixed header + filters */}
      <div className="shrink-0 p-6 pb-0 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-text">Transactions</h2>
          {data && (
            <span className="text-xs text-text-muted font-mono">
              {filtered.length} of {data.length} transactions
            </span>
          )}
        </div>

        <div className="flex gap-3">
          <input
            type="text"
            placeholder="Search by merchant or description..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="flex-1 bg-surface-raised border border-border rounded-md px-3 py-2 text-sm text-text placeholder:text-text-muted focus:outline-none focus:border-green"
          />
          <select
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
            className="bg-surface-raised border border-border rounded-md px-3 py-2 text-sm text-text focus:outline-none focus:border-green"
          >
            <option value="">All Categories</option>
            {categories.map((cat) => (
              <option key={cat} value={cat}>
                {cat}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Scrollable table area */}
      <div className="flex-1 overflow-y-auto px-6 py-4 min-h-0">
        {loading && (
          <div className="bg-surface-raised border border-border rounded-lg p-4">
            <div className="h-[300px] animate-pulse bg-border-muted rounded" />
          </div>
        )}

        {error && (
          <div className="bg-surface-raised border border-border rounded-lg p-4 text-red text-sm">
            Failed to load transactions: {error}
          </div>
        )}

        {!loading && !error && filtered.length === 0 && (
          <div className="bg-surface-raised border border-border rounded-lg p-8 text-center">
            <p className="text-sm text-text-muted">
              {data && data.length > 0 ? 'No transactions match your filters.' : 'No transactions found.'}
            </p>
          </div>
        )}

        {!loading && !error && filtered.length > 0 && (
          <div className="bg-surface-raised border border-border rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-surface-raised z-10">
                <tr className="border-b border-border text-text-secondary text-xs uppercase tracking-wide">
                  <th className="text-left px-4 py-3 font-medium">Date</th>
                  <th className="text-left px-4 py-3 font-medium">Description</th>
                  <th className="text-right px-4 py-3 font-medium">Amount</th>
                  <th className="text-left px-4 py-3 font-medium">Category</th>
                  <th className="text-left px-4 py-3 font-medium">Account</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((tx) => (
                  <tr
                    key={tx.id}
                    className="border-b border-border last:border-b-0 hover:bg-surface transition-colors"
                  >
                    <td className="px-4 py-3 text-text-secondary font-mono text-xs whitespace-nowrap">
                      {formatDate(tx.date)}
                    </td>
                    <td className="px-4 py-3 text-text">
                      <div className="flex items-center gap-2">
                        <span className="truncate max-w-[300px]">
                          {tx.merchant_name ?? tx.description}
                        </span>
                        {tx.pending && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-border text-text-muted uppercase tracking-wider">
                            pending
                          </span>
                        )}
                      </div>
                      {tx.merchant_name && tx.description !== tx.merchant_name && (
                        <div className="text-xs text-text-muted truncate max-w-[300px]">
                          {tx.description}
                        </div>
                      )}
                    </td>
                    <td
                      className={`px-4 py-3 text-right font-mono whitespace-nowrap ${
                        tx.amount < 0 ? 'text-red' : 'text-green'
                      }`}
                    >
                      {formatAmount(tx.amount)}
                    </td>
                    <td className="px-4 py-3 text-text-secondary text-xs">
                      {tx.category_detailed ?? tx.category ?? (
                        <span className="text-text-muted">Uncategorized</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-text-secondary text-xs">
                      {tx.account_name ?? <span className="text-text-muted">--</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
