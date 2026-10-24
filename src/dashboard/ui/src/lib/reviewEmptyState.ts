/**
 * What the Review tab says when its queue is empty (#185). Pure: ReviewTab
 * renders it, src/__tests__/review-empty-state.test.ts pins it.
 *
 * The queue holds model suggestions only (specs/issue-86), so an empty queue
 * is not "all done" while rows still have no category. Say how many, and the
 * two ways forward: get suggestions from a model, or pick categories by hand
 * in Transactions (inline picker, #184).
 */

import type { ModelsPanel, ReviewQueueStatus } from '../types';
import { MODELS_SETTINGS_LABEL } from './modelSetup';
import { serializeHash, withTab, type UrlState } from './urlState';

/** Is the categorization model set and able to run? null = not known (no answer from /api/models). */
export function categorizationModelReady(models: ModelsPanel | null | undefined): boolean | null {
  const row = models?.tasks.find((t) => t.task === 'categorization');
  if (!row) return null;
  if (!row.inUse || !row.model) return false;
  return row.availability !== 'not-installed' && row.availability !== 'unreachable';
}

export interface ReviewEmptyState {
  message: string;
  /** Offer the link to the uncategorized rows in Transactions. */
  showTransactionsLink: boolean;
}

function uncategorizedLead(n: number): string {
  return n === 1 ? '1 transaction is uncategorized.' : `${n.toLocaleString('en-US')} transactions are uncategorized.`;
}

export function reviewEmptyState(
  status: ReviewQueueStatus | null | undefined,
  modelReady: boolean | null,
  canAct: boolean,
): ReviewEmptyState {
  // No counts (the request failed): say only what the empty list proves.
  if (!status) return { message: 'Nothing waiting for review.', showTransactionsLink: false };
  if (status.transactions === 0) {
    return { message: 'Nothing to review yet — no transactions have been imported.', showTransactionsLink: false };
  }
  if (status.uncategorized === 0) {
    return { message: 'Nothing to review — all suggestions resolved and every transaction has a category.', showTransactionsLink: false };
  }
  const lead = uncategorizedLead(status.uncategorized);
  let next: string;
  if (modelReady === true) {
    next = canAct
      ? 'Run /categorize in Chat to get suggestions, or categorize them in Transactions.'
      : 'An admin can run /categorize in Chat to get suggestions, or categorize them in Transactions.';
  } else if (modelReady === false) {
    next = canAct
      ? `Set up a model in ${MODELS_SETTINGS_LABEL} to get suggestions, or categorize them in Transactions.`
      : `An admin can set up a model in ${MODELS_SETTINGS_LABEL} to get suggestions, or categorize them in Transactions.`;
  } else {
    next = `Suggestions come from a model (${MODELS_SETTINGS_LABEL}), or categorize them in Transactions.`;
  }
  return { message: `${lead} ${next}`, showTransactionsLink: true };
}

/**
 * '#transactions?…' showing exactly the uncategorized rows: the Uncategorized
 * filter over a custom range that spans them (the tab otherwise opens on the
 * current month and could hide some). The count is profile-wide, so the
 * account / entity filters are cleared too.
 */
export function uncategorizedTransactionsHash(url: UrlState, status: ReviewQueueStatus): string {
  const next = withTab(url, 'transactions');
  next.cat = 'Uncategorized';
  next.account = null;
  next.entity = null;
  if (status.uncategorizedFrom && status.uncategorizedTo) {
    next.preset = 'custom';
    next.start = status.uncategorizedFrom;
    next.end = status.uncategorizedTo;
  }
  return serializeHash(next);
}
