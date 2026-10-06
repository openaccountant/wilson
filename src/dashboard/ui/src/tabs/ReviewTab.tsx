import { useState, useMemo, useCallback, useEffect, useRef, Fragment, type ChangeEvent } from 'react';
import { useApi } from '@/hooks/useApi';
import { api } from '@/api';
import { formatAmount, formatDate } from '@/format';
import type { CategoryRow, ReviewQueueItem } from '@/types';
import { CATEGORIES } from '../../../../tools/categorize/categories.js';
import { orderByLane, type LaneRoute } from '@/prelabel/core';
import type { PrelabelResult } from '@/prelabel/protocol';
import { PrelabelPanel } from '@/components/prelabel/PrelabelPanel';
import { PrelabelChip } from '@/components/prelabel/PrelabelChip';
import { LaneHeaderRow } from '@/components/prelabel/LaneHeaderRow';
import { QuickConfirmButton } from '@/components/prelabel/QuickConfirmButton';
import { useDeclarativeTool, useHumanBusy } from '@/agent/useDeclarativeTool';
import { useWebMcpPageTools } from '@/agent/useWebMcpPageTools';
import { usePageContext } from '@/agent/WebMcpProvider';
import { pageError, pollUntil } from '@webmcp-page-tools';
import { armPageGuard, scrollForAgent, useAgentGuard } from '@/agent/agentGuard';
import { AgentFilledBanner, AgentOutcomeNote } from '@/components/agent/AgentFilledBanner';
import { buildCategoryOptions, buildReviewOptions, fieldLock } from '@declarative-submit';

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
  route,
  selected,
  guarded,
  onResolved,
  onError,
}: {
  review: ReviewQueueItem;
  categories: string[];
  canAct: boolean;
  /** open-jev second opinion for this row; absent when the feature is off. */
  route?: LaneRoute;
  /** An agent pre-selected this review (`open_review_item`). */
  selected?: boolean;
  /** An agent just moved to this row: its action buttons stay off for a moment (T16), so a click aimed elsewhere cannot land here. */
  guarded?: boolean;

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
    <tr
      data-review-id={review.review_id}
      aria-current={selected ? 'true' : undefined}
      data-agent-guard={guarded ? '' : undefined}
      className={`scroll-mt-12 border-b border-border last:border-b-0 hover:bg-surface transition-colors ${selected ? 'ring-1 ring-inset ring-green bg-green/10' : ''}`}
    >
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
          {route && <PrelabelChip route={route} />}
        </span>
      </td>
      <td className="px-4 py-3 text-text-muted text-xs">
        {review.current_category ? `currently \u2018${review.current_category}\u2019` : ''}
      </td>
      {canAct && (
        <td className="px-4 py-3">
          <div className="flex items-center gap-2">
            {route?.kind === 'agrees' ? (
              <QuickConfirmButton busy={busy || !!guarded} onConfirm={() => resolve('confirm')} />
            ) : (
              <button
                onClick={() => resolve('confirm')}
                disabled={busy || guarded}
                className="bg-green-700 hover:bg-green-600 disabled:opacity-50 text-white text-xs font-medium px-2.5 py-1.5 rounded-md transition-colors cursor-pointer border-none whitespace-nowrap"
                title="Apply the suggested category"
              >
                Confirm
              </button>
            )}
            <select
              value={pick}
              onChange={(e) => setPick(e.target.value)}
              disabled={busy || guarded}
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
              disabled={busy || guarded || !pick}
              className="bg-surface-raised hover:bg-border-muted disabled:opacity-50 disabled:cursor-not-allowed text-text-secondary border border-border text-xs font-medium px-2.5 py-1.5 rounded-md transition-colors cursor-pointer whitespace-nowrap"
              title="Apply the category you picked instead"
            >
              Apply
            </button>
            {guarded && (
              <span role="status" className="text-[10px] text-yellow whitespace-nowrap">
                Agent moved the view, actions paused…
              </span>
            )}
          </div>
        </td>
      )}
    </tr>
  );
}

/**
 * Resolve one pending review from a form. The form is also a declarative WebMCP tool (`resolve_review_item`): a person
 * submits it like any form (the same REST routes as the row buttons), while an agent's submit becomes a proposal
 * that waits for the approval card. Option labels are ids, dates and amounts only (no merchant text).
 */
function ReviewActionForm({
  reviews,
  categoryRows,
  preselect,
  guarded,
  onResolved,
  onError,
  onSettled,
}: {
  reviews: ReviewQueueItem[];
  categoryRows: CategoryRow[];
  /** An agent asked to pre-select a review (`open_review_item`). The nonce makes asking again for the same id count. */
  preselect: { id: number; nonce: number } | null;
  /** An agent just moved the view: the human Resolve button stays off for a moment (T16). */
  guarded: boolean;
  onResolved: (category: string) => void;
  onError: (message: string) => void;
  onSettled: () => void;
}) {
  const [reviewId, setReviewId] = useState('');
  const [action, setAction] = useState<'confirm' | 'correct'>('confirm');
  const [categoryId, setCategoryId] = useState('');
  const { busy, setBusy, isBusy } = useHumanBusy();

  const reviewOptions = useMemo(() => buildReviewOptions(reviews), [reviews]);
  const categoryOptions = useMemo(() => buildCategoryOptions(categoryRows), [categoryRows]);

  async function resolveAsHuman() {
    const id = Number(reviewId);
    if (!Number.isInteger(id) || id <= 0) return onError('Pick a review to resolve.');
    const category = categoryRows.find((c) => String(c.id) === categoryId)?.name;
    if (action === 'correct' && !category) return onError('Pick the category to correct it to.');
    setBusy(true);
    try {
      const result = await api<{ success: boolean; category: string }>(`/api/reviews/${id}/${action}`, {
        method: 'POST',
        body: action === 'correct' ? JSON.stringify({ category }) : undefined,
      });
      if (result.success) {
        setReviewId('');
        setCategoryId('');
        onResolved(result.category);
      }
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const declarative = useDeclarativeTool({
    tool: 'resolve_review_item',
    // The form advertises itself only once BOTH option lists exist. Chrome derives the tool's schema from the DOM it sees,
    // and a `category_id` select that offered only its empty option made `action=correct` unusable by an agent (L2).
    ready: reviewOptions.length > 0 && categoryOptions.length > 0,
    onAgentCleared: () => {
      setReviewId('');
      setAction('confirm');
      setCategoryId('');
    },
    onHumanSubmit: resolveAsHuman,
    humanBusy: isBusy,
    // The agent's call ended (approved, rejected, expired...): the queue may have changed. Refetch only once the agent
    // has its answer: a refetch swaps this form for a skeleton, and a form removed mid-call cancels the call.
    onSettled,
  });
  // Option lists are frozen while an agent call is in flight (a changed select makes Chrome re-derive the schema).
  const shownReviewOptions = declarative.hold('reviews', reviewOptions);
  const shownCategoryOptions = declarative.hold('categories', categoryOptions);

  // Only the review is chosen: the action and the category stay as they are, and nothing is submitted. An agent
  // changed what this mutating form acts on, so the form is agent-touched (amber banner; the next submit, even a
  // human click, goes through the approval card) until it is submitted, reset or cancelled: not on the cue's timer.
  const { markAgentTouched } = declarative;
  useEffect(() => {
    if (preselect === null) return;
    setReviewId(String(preselect.id));
    markAgentTouched();
  }, [preselect, markAgentTouched]);

  const selectClass =
    'bg-surface-raised border border-border rounded px-2 py-1.5 text-xs text-text-secondary focus:outline-none focus:border-green cursor-pointer';
  // A person's resolve in flight locks the fields WITHOUT `disabled` (a disabled field leaves the tool's schema and cancels a running call).
  const lock = fieldLock(busy);

  return (
    <div className="bg-surface-raised border border-border rounded-lg p-4 mb-4">
      {declarative.agentTouched && <AgentFilledBanner />}
      <form key={declarative.formKey} className="flex flex-wrap items-end gap-3" aria-label="Resolve a review" {...declarative.formProps}>
        <label className={`text-xs text-text-muted ${lock.wrapperClass}`}>
          <span className="block mb-1">Review</span>
          <select name="review_id" value={reviewId} onChange={lock.guard((e: ChangeEvent<HTMLSelectElement>) => setReviewId(e.target.value))} {...lock.fieldProps} className={`${selectClass} min-w-[220px]`} {...declarative.field('review_id')}>
            <option value="">Choose a review…</option>
            {shownReviewOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>
        <label className={`text-xs text-text-muted ${lock.wrapperClass}`}>
          <span className="block mb-1">Action</span>
          <select name="action" value={action} onChange={lock.guard((e: ChangeEvent<HTMLSelectElement>) => setAction(e.target.value as 'confirm' | 'correct'))} {...lock.fieldProps} className={selectClass} {...declarative.field('action')}>
            <option value="confirm">confirm</option>
            <option value="correct">correct</option>
          </select>
        </label>
        <label className={`text-xs text-text-muted ${lock.wrapperClass}`}>
          <span className="block mb-1">Category (for correct)</span>
          <select name="category_id" value={categoryId} onChange={lock.guard((e: ChangeEvent<HTMLSelectElement>) => setCategoryId(e.target.value))} {...lock.fieldProps} className={`${selectClass} max-w-[200px]`} {...declarative.field('category_id')}>
            <option value="">—</option>
            {/* Always every category (ids and safe labels), whatever review or action is chosen: Chrome builds the enum from these. */}
            {shownCategoryOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>
        <button
          type="submit"
          disabled={busy || guarded}
          data-agent-guard={guarded ? '' : undefined}
          className="bg-green-700 hover:bg-green-600 disabled:opacity-50 text-white text-xs font-medium px-3 py-1.5 rounded-md transition-colors cursor-pointer border-none whitespace-nowrap"
        >
          Resolve
        </button>
        {guarded && (
          <span role="status" className="text-[10px] text-yellow">
            Agent moved the view, actions paused…
          </span>
        )}
      </form>
      <AgentOutcomeNote outcome={declarative.outcome} />
    </div>
  );
}

export function ReviewTab() {
  const [banner, setBanner] = useState('');
  const [errorBanner, setErrorBanner] = useState('');
  const [prelabel, setPrelabel] = useState<{ results: Map<number, PrelabelResult>; marginCut: number; active: boolean }>({
    results: new Map(),
    marginCut: 0.3,
    active: false,
  });
  const handlePrelabelResults = useCallback(
    (results: Map<number, PrelabelResult>, marginCut: number, active: boolean) => setPrelabel({ results, marginCut, active }),
    [],
  );

  const { data: reviews, loading, error, refetch } = useApi<ReviewQueueItem[]>('/api/reviews');
  const { data: authStatus } = useApi<AuthStatus>('/api/auth/status');
  // Offer exactly what apiCorrectReview accepts: names in the categories table,
  // falling back to the static CATEGORIES list it also validates against.
  const { data: categoryRows } = useApi<CategoryRow[]>('/api/categories');

  const categories = useMemo(() => {
    const names = (categoryRows ?? []).map((r) => r.name).filter(Boolean);
    return [...new Set(names.length > 0 ? names : CATEGORIES)].sort();
  }, [categoryRows]);

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

  const pending = useMemo(() => reviews ?? [], [reviews]);
  // Identity order (the server's) until open-jev has scored something.
  const lanes = useMemo(
    () => orderByLane(pending, prelabel.results, prelabel.marginCut),
    [pending, prelabel.results, prelabel.marginCut],
  );
  const showLanes = prelabel.active && prelabel.results.size > 0;
  const laneCounts = { ATTENTION: 0, QUICK: 0 };
  for (const e of lanes) laneCounts[e.route.lane]++;

  // ── Agent journey: show one review (`open_review_item`) ────────────────────
  // The bridge registers the tool only while this tab shows, after the server confirmed the review is pending. The
  // handler pre-selects it in the form and says whether that really happened.
  const [preselect, setPreselect] = useState<{ id: number; nonce: number } | null>(null);
  const latest = useRef({ pending, canAct });
  latest.current = { pending, canAct };
  // Whatever an agent moves to, the human Confirm/Apply/Resolve buttons stay off for a moment (T16).
  const { guarded, armGuard } = useAgentGuard();

  useWebMcpPageTools('review', {
    open_review_item: async (args, { signal }) => {
      const reviewId = args.reviewId as number;
      const { pending: queue, canAct: mayAct } = latest.current;
      // Refusals are RESULTS ({ error: { code, message } }): Chrome 154 hides the text of a thrown error from the agent.
      if (!queue.some((r) => r.review_id === reviewId)) {
        return { reviewId, prefilled: false, ...pageError('not_found', 'That review is not in the queue shown. Call list_review_items for the current ids.') };
      }
      if (!mayAct) return { reviewId, prefilled: false, ...pageError('read_only', 'The review form is read-only for this role.') };
      armGuard();
      setPreselect({ id: reviewId, nonce: Date.now() });
      const prefilled = await pollUntil(
        () => (document.querySelector('form[aria-label="Resolve a review"] select[name="review_id"]') as HTMLSelectElement | null)?.value === String(reviewId),
        signal,
        { timeoutMs: 2000 }
      );
      // Only when the row is not already fully visible, and only as far as needed; a scroll moves every row, so the page waits too.
      if (scrollForAgent(document.querySelector(`[data-review-id="${reviewId}"]`))) armPageGuard();
      return prefilled ? { reviewId, prefilled: true } : { reviewId, prefilled: false, ...pageError('form_not_showing', 'The review form is not showing.') };
    },
  });

  // The cue fades: it is a pointer to a row, not a state the user has to clear.
  useEffect(() => {
    if (preselect === null) return;
    const timer = setTimeout(() => setPreselect(null), 10_000);
    return () => clearTimeout(timer);
  }, [preselect]);

  usePageContext('review', { selection: { reviewId: preselect?.id ?? null }, visibleRows: pending.length });

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
        {!error && <div className="mb-3"><PrelabelPanel reviews={pending} canAct={canAct} onResults={handlePrelabelResults} /></div>}

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

        {!loading && !error && canAct && pending.length > 0 && (
          <ReviewActionForm
            reviews={pending}
            categoryRows={categoryRows ?? []}
            preselect={preselect}
            guarded={guarded}
            onResolved={handleResolved}
            onError={handleError}
            onSettled={refetch}
          />
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
                {lanes.map(({ item: r, route }, i) => (
                  <Fragment key={r.review_id}>
                    {showLanes && (i === 0 || lanes[i - 1].route.lane !== route.lane) && (
                      <LaneHeaderRow lane={route.lane} count={laneCounts[route.lane]} colSpan={canAct ? 6 : 5} />
                    )}
                    <ReviewRow
                      review={r}
                      categories={categories}
                      canAct={canAct}
                      route={prelabel.active ? route : undefined}
                      selected={r.review_id === preselect?.id}
                      guarded={guarded && r.review_id === preselect?.id}
                      onResolved={handleResolved}
                      onError={handleError}
                    />
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}