import { useState, useMemo } from 'react';
import { useApi } from '@/hooks/useApi';
import { api } from '@/api';
import { formatAmount, formatDate } from '@/format';
import type { ReviewQueueItem, SpendingSummaryItem } from '@/types';

/** Confidence at or below which a suggestion landed in the review queue (src/tools/categorize). */
const CONFIDENCE_REVIEW_THRESHOLD = 0.7;

interface AuthStatus {
  authEnabled: boolean;
  user: { id: number; username: string; role: string } | null;
}

function ConfidenceBadge({ confidence }: { confidence: number }) {
  const low = confidence < CONFIDENCE_REVIEW_THRESHOLD;
  return (
    <span
      title={low ? 'Low model confidence — that\u2019s why this needs your review' : 'Model confidence'}
      className={`inline-block text-[10px] px-1.5 py-0.5 rounded border font-mono ${
        low
          ? 'border-yellow/40 bg-yellow/10 text-yellow'
          : 'border-border bg-border-muted/60 text-text-muted'
      }`}
    >
      {Math.round(confidence * 100)}%
    </span>
  );
}

/**
 * One pending review with its Confirm/Correct actions. Holds its own
 * category-picker state so a choice on one row never leaks to another.
 */
function ReviewRow({
  review,
  categories,
  canAct,
  onResolved,
  onError,
}: {
  review: ReviewQueueItem;
  categories: string[];
  canAct: boolean;
  onResolved: (category: string) => void;
  onError: (message: string) => void;
}) {
  const [pick, setPick] = useState('');
  const [busy, setBusy] = useState(false);

  async function resolve(action: 'confirm' | 'correct') {
    setBusy(true);
    try {
      const body = action === 'correct' ? JSON.stringify({ category: pick }) : undefined;
      const result = await api<{ success: boolean; category: string }>(
        `/api/reviews/${review.review_id}/${action}`,
        { method: 'POST', body }
      );
      if (result.success) onResolved(result.category);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <tr className="border-b border-border last:border-b-0 hover:bg-surface transition-colors">
      <td className="px-4 py-3 text-text-secondary font-mono text-xs whitespace-nowrap">
        {formatDate(review.date)}
      </td>
      <td className="px-4 py-3 text-text">
        <span className="truncate max-w-[300px] block">
          {review.merchant_name ?? review.description}
        </span>
        {review.merchant_name && review.description !== review.merchant_name && (
          <div className="text-xs text-text-muted truncate max-w-[300px]">
            {review.description}
          </div>
        )}
      </td>
      <td
        className={`px-4 py-3 text-right font-mono whitespace-nowrap ${
          review.amount < 0 ? 'text-red' : 'text-green'
        }`}
      >
        {formatAmount(review.amount)}
      </td>
      <td className="px-4 py-3 text-text-secondary text-xs">
        <span className="inline-flex items-center gap-1.5">
          {review.suggested_category}
          <ConfidenceBadge confidence={review.confidence} />
        </span>
      </td>
      <td className="px-4 py-3 text-text-muted text-xs">
        {review.current_category ? `currently \u2018${review.current_category}\u2019` : ''}
      </td>
      {canAct && (
        <td className="px-4 py-3">
          <div className="flex items-center gap-2">
            <button
              onClick={() => resolve('confirm')}
              disabled={busy}
              className="bg-green-700 hover:bg-green-600 disabled:opacity-50 text-white text-xs font-medium px-2.5 py-1.5 rounded-md transition-colors cursor-pointer border-none whitespace-nowrap"
              title="Apply the suggested category"
            >
              Confirm
            </button>
            <select
              value={pick}
              onChange={(e) => setPick(e.target.value)}
              disabled={busy}
              className="bg-surface-raised border border-border rounded px-1.5 py-1.5 text-xs text-text-secondary focus:outline-none focus:border-green disabled:opacity-50 max-w-[140px] cursor-pointer"
            >
              <option value="">Correct…</option>
              {categories.map((cat) => (
                <option key={cat} value={cat}>
                  {cat}
                </option>
              ))}
            </select>
            <button
              onClick={() => resolve('correct')}
              disabled={busy || !pick}
              className="bg-surface-raised hover:bg-border-muted disabled:opacity-50 disabled:cursor-not-allowed text-text-secondary border border-border text-xs font-medium px-2.5 py-1.5 rounded-md transition-colors cursor-pointer whitespace-nowrap"
              title="Apply the category you picked instead"
            >
              Apply
            </button>
          </div>
        </td>
      )}
    </tr>
  );
}

export function ReviewTab() {
  const [banner, setBanner] = useState('');
  const [errorBanner, setErrorBanner] = useState('');

  const { data: reviews, loading, error, refetch } = useApi<ReviewQueueItem[]>('/api/reviews');
  const { data: authStatus } = useApi<AuthStatus>('/api/auth/status');
  // Same category derivation as App.tsx: sorted unique from the all-time summary.
  const { data: allSummary } = useApi<SpendingSummaryItem[]>('/api/summary?startDate=2000-01-01&endDate=2099-12-31');

  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const s of allSummary ?? []) {
      if (s.category) set.add(s.category);
    }
    return [...set].sort();
  }, [allSummary]);

  // Server stays the authority — the UI only hides the controls when the
  // viewer can't act (auth enabled and not admin).
  const canAct = !authStatus?.authEnabled || authStatus?.user?.role === 'admin';

  function handleResolved(category: string) {
    refetch();
    setErrorBanner('');
    setBanner(`Applied \u2018${category}\u2019 — the transaction is marked verified and the review is resolved.`);
  }

  function handleError(message: string) {
    setBanner('');
    setErrorBanner(message);
  }

  const pending = reviews ?? [];

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="shrink-0 p-6 pb-0 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-semibold text-text">Review</h2>
            <span className="text-xs text-text-muted font-mono">
              {pending.length} pending
            </span>
          </div>
        </div>

        {!canAct && (
          <p className="text-xs text-text-muted">
            Suggestions are read-only for your role — sign in as an admin to resolve reviews.
          </p>
        )}

        {banner && (
          <div className="flex items-center justify-between border border-green-700/50 bg-green-900/30 text-text rounded-md px-3 py-2 text-sm">
            <span className="break-words">{banner}</span>
            <button
              onClick={() => setBanner('')}
              className="text-text-muted hover:text-text bg-transparent border-none text-base cursor-pointer ml-3 shrink-0"
              aria-label="Dismiss"
            >
              &times;
            </button>
          </div>
        )}

        {errorBanner && (
          <div className="flex items-center justify-between border border-red/50 bg-red/10 text-text rounded-md px-3 py-2 text-sm">
            <span className="break-words">{errorBanner}</span>
            <button
              onClick={() => setErrorBanner('')}
              className="text-text-muted hover:text-text bg-transparent border-none text-base cursor-pointer ml-3 shrink-0"
              aria-label="Dismiss"
            >
              &times;
            </button>
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-4 min-h-0">
        {loading && (
          <div className="bg-surface-raised border border-border rounded-lg p-4">
            <div className="h-[200px] animate-pulse bg-border-muted rounded" />
          </div>
        )}

        {error && (
          <div className="bg-surface-raised border border-border rounded-lg p-4 text-red text-sm">
            Failed to load the review queue: {error}
          </div>
        )}

        {!loading && !error && pending.length === 0 && (
          <div className="bg-surface-raised border border-border rounded-lg p-8 text-center">
            <p className="text-sm text-text-muted">Nothing to review — all suggestions resolved.</p>
          </div>
        )}

        {!loading && !error && pending.length > 0 && (
          <div className="bg-surface-raised border border-border rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-surface-raised z-10">
                <tr className="border-b border-border text-text-secondary text-xs uppercase tracking-wide">
                  <th className="text-left px-4 py-3 font-medium">Date</th>
                  <th className="text-left px-4 py-3 font-medium">Description</th>
                  <th className="text-right px-4 py-3 font-medium">Amount</th>
                  <th className="text-left px-4 py-3 font-medium">Suggested</th>
                  <th className="text-left px-4 py-3 font-medium">Current</th>
                  {canAct && (
                    <th className="text-left px-4 py-3 font-medium">Actions</th>
                  )}
                </tr>
              </thead>
              <tbody>
                {pending.map((r) => (
                  <ReviewRow
                    key={r.review_id}
                    review={r}
                    categories={categories}
                    canAct={canAct}
                    onResolved={handleResolved}
                    onError={handleError}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}