import { describe, expect, test } from 'bun:test';
import {
  categorizationModelReady,
  reviewEmptyState,
  uncategorizedTransactionsHash,
} from '../dashboard/ui/src/lib/reviewEmptyState.js';
import { defaultUrlState, parseHash } from '../dashboard/ui/src/lib/urlState.js';
import type { ModelsPanel, ModelTaskRow, ReviewQueueStatus } from '../dashboard/ui/src/types.js';

/**
 * #185: an empty Review queue says "all suggestions resolved" only when that is true; with uncategorized rows and no
 * suggestions it says how many and the two ways forward, and it never claims a model is missing when one is ready.
 */

const status = (over: Partial<ReviewQueueStatus> = {}): ReviewQueueStatus => ({
  pending: 0,
  uncategorized: 3,
  transactions: 40,
  uncategorizedFrom: '2026-10-15',
  uncategorizedTo: '2026-10-22',
  ...over,
});

function models(row: Partial<ModelTaskRow> | null): ModelsPanel {
  const base: ModelTaskRow = {
    task: 'categorization',
    label: 'Categorization',
    inUse: true,
    model: 'ollama:granite4.1:3b',
    modelName: 'Granite',
    provider: 'ollama',
    providerName: 'Ollama',
    execution: 'local',
    webgpu: false,
    assignment: 'default',
    note: null,
    availability: 'installed',
  };
  return { tasks: row ? [{ ...base, ...row }] : [], catalog: [] };
}

describe('categorizationModelReady', () => {
  test('installed or not-an-Ollama-row (availability null) is ready; not installed / Ollama down is not; no answer is unknown', () => {
    expect(categorizationModelReady(models({ availability: 'installed' }))).toBe(true);
    expect(categorizationModelReady(models({ availability: null, model: 'claude-sonnet-4', provider: 'anthropic' }))).toBe(true);
    expect(categorizationModelReady(models({ availability: 'not-installed' }))).toBe(false);
    expect(categorizationModelReady(models({ availability: 'unreachable' }))).toBe(false);
    expect(categorizationModelReady(models({ inUse: false, model: null }))).toBe(false);
    expect(categorizationModelReady(models(null))).toBeNull();
    expect(categorizationModelReady(null)).toBeNull();
  });
});

describe('reviewEmptyState', () => {
  test('uncategorized rows and no model: the issue copy, with the Transactions link', () => {
    const s = reviewEmptyState(status(), false, true);
    expect(s.message).toBe(
      '3 transactions are uncategorized. Set up a model in Settings → Models to get suggestions, or categorize them in Transactions.',
    );
    expect(s.showTransactionsLink).toBe(true);
    expect(s.message).not.toContain('resolved');
  });

  test('a ready model is never called missing', () => {
    const s = reviewEmptyState(status({ uncategorized: 1 }), true, true);
    expect(s.message).toBe('1 transaction is uncategorized. Run /categorize in Chat to get suggestions, or categorize them in Transactions.');
    expect(s.message).not.toMatch(/set up a model/i);
  });

  test('viewers are pointed at an admin, never told to do what their role cannot', () => {
    expect(reviewEmptyState(status(), true, false).message).toContain('An admin can run /categorize');
    expect(reviewEmptyState(status(), false, false).message).toContain('An admin can set up a model');
  });

  test('model status unknown: no claim either way', () => {
    const s = reviewEmptyState(status(), null, true);
    expect(s.message).not.toMatch(/set up a model|run \/categorize/i);
    expect(s.showTransactionsLink).toBe(true);
  });

  test('"all suggestions resolved" only when nothing is uncategorized', () => {
    expect(reviewEmptyState(status({ uncategorized: 0 }), false, true).message).toContain('all suggestions resolved');
    expect(reviewEmptyState(status({ uncategorized: 0 }), false, true).showTransactionsLink).toBe(false);
    for (const s of [reviewEmptyState(status(), false, true), reviewEmptyState(status(), true, true), reviewEmptyState(status(), null, false)]) {
      expect(s.message).not.toContain('resolved');
    }
  });

  test('no transactions, or no counts: nothing false', () => {
    expect(reviewEmptyState(status({ transactions: 0, uncategorized: 0 }), null, true).message).toContain('no transactions have been imported');
    const unknown = reviewEmptyState(null, true, true);
    expect(unknown).toEqual({ message: 'Nothing waiting for review.', showTransactionsLink: false });
  });

  test('large counts are grouped', () => {
    expect(reviewEmptyState(status({ uncategorized: 1234 }), false, true).message.startsWith('1,234 transactions are uncategorized.')).toBe(true);
  });
});

describe('uncategorizedTransactionsHash', () => {
  test('opens Transactions on the Uncategorized filter over a range spanning those rows, account/entity cleared', () => {
    const from = { ...defaultUrlState('review'), account: 4, entity: 2 };
    const hash = uncategorizedTransactionsHash(from, status());
    const parsed = parseHash(hash);
    expect(parsed.tab).toBe('transactions');
    expect(parsed.cat).toBe('Uncategorized');
    expect(parsed.preset).toBe('custom');
    expect(parsed.start).toBe('2026-10-15');
    expect(parsed.end).toBe('2026-10-22');
    expect(parsed.account).toBeNull();
    expect(parsed.entity).toBeNull();
  });
});
