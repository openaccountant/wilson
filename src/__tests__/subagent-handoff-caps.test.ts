import { describe, expect, test } from 'bun:test';
import {
  buildHandoff,
  projectStepSummary,
  type ExecutedStep,
} from '../dashboard/ui/src/hybrid/subagent-core.js';
import { HANDOFF_CAPS } from '../dashboard/local-handoff-format.js';

/**
 * The handoff payload (spec 8.1 / 8.3): bounded, minimal, no notes. These are
 * the CLIENT-side caps; the server re-enforces them (a later slice).
 */

function searchStep(rowCount: number, extra: Partial<ExecutedStep> = {}): ExecutedStep {
  const transactions = Array.from({ length: rowCount }, (_, i) => ({
    id: i + 1,
    date: `2026-06-${String((i % 28) + 1).padStart(2, '0')}`,
    description: `MERCHANT ${i} ` + 'LONG DESCRIPTION '.repeat(10),
    amount: -(10 + i),
    category: 'Dining',
    notes: `SECRET NOTE ${i}`,
    account_last4: '4471',
    plaid_transaction_id: `plaid-${i}`,
  }));
  return {
    tool: 'transaction_search',
    args: { query: 'Merchant' },
    ok: true,
    ms: 12,
    rows: rowCount,
    summary: 'RAW-MIRROR-SUMMARY',
    data: { query: 'Merchant', filtersApplied: {}, count: rowCount, formatted: '...', transactions },
    ...extra,
  };
}

function base(over: Partial<Parameters<typeof buildHandoff>[0]> = {}): Parameters<typeof buildHandoff>[0] {
  return { reason: 'step-limit', steps: [], mirrorSyncedAt: '2026-07-15T11:59:00.000Z', ...over };
}

describe('transaction_search projection', () => {
  test('at most 25 rows, only id/date/description(<=80)/amount/category, never notes', () => {
    const text = projectStepSummary(searchStep(60));
    const lines = text.split('\n').filter((l) => l.startsWith('#'));
    expect(lines.length).toBeLessThanOrEqual(HANDOFF_CAPS.searchRows);
    expect(lines.length).toBeGreaterThan(5);
    expect(text).not.toContain('SECRET NOTE');
    expect(text).not.toContain('4471');
    expect(text).not.toContain('plaid-');
    expect(text.length).toBeLessThanOrEqual(HANDOFF_CAPS.summaryChars);
    expect(text).toContain('60'); // the true count is stated
    for (const l of lines) {
      // "#id date -$amount Category description" — the description part is capped.
      expect(l.length).toBeLessThanOrEqual(80 + 40);
    }
  });

  test('a zero-row search is stated plainly', () => {
    expect(projectStepSummary(searchStep(0))).toMatch(/0|no transactions/i);
  });

  test('other tools fall back to the mirror summary, capped at 1,200 chars', () => {
    const s: ExecutedStep = {
      tool: 'spending_summary', args: {}, ok: true, ms: 3, summary: 'x'.repeat(5000), data: { notes: 'SECRET' },
    };
    const text = projectStepSummary(s);
    expect(text.length).toBeLessThanOrEqual(HANDOFF_CAPS.summaryChars);
    expect(text).not.toContain('SECRET');
  });
});

describe('buildHandoff', () => {
  test('the minimal payload', () => {
    const h = buildHandoff(base({ reason: 'non-data' }));
    expect(h).toEqual({ v: 1, reason: 'non-data', mirror: { syncedAt: '2026-07-15T11:59:00.000Z' }, steps: [] });
  });

  test('the mirror profile is never sent', () => {
    const h = buildHandoff(base({ steps: [searchStep(3)] }));
    expect(JSON.stringify(h)).not.toContain('profile');
  });

  test('steps carry tool/args/ok/summary only, and are limited to 4', () => {
    const h = buildHandoff(base({ steps: [searchStep(2), searchStep(2), searchStep(2), searchStep(2), searchStep(2)] }));
    expect(h.steps.length).toBe(4);
    for (const s of h.steps) expect(Object.keys(s).sort()).toEqual(['args', 'ok', 'summary', 'tool']);
  });

  test('no notes, account digits or ids leak anywhere in the serialised payload', () => {
    const h = buildHandoff(base({ steps: [searchStep(40)] }));
    const json = JSON.stringify(h);
    expect(json).not.toContain('SECRET NOTE');
    expect(json).not.toContain('plaid-');
    expect(json).not.toContain('account_last4');
    expect(json).not.toContain('"notes"');
  });

  test('proposal userWords <= 300 chars; localNote <= 400; prior turns <= 3 with q<=300, a<=600', () => {
    const h = buildHandoff(
      base({
        reason: 'ungrounded',
        proposal: { tool: 'edit_transaction', userWords: 'u'.repeat(900) },
        localNote: 'n'.repeat(900),
        priorLocalTurns: [1, 2, 3, 4, 5].map((i) => ({ q: `q${i}` + 'q'.repeat(500), a: `a${i}` + 'a'.repeat(900) })),
      })
    );
    expect(h.proposal!.userWords.length).toBe(300);
    expect(h.localNote!.length).toBeLessThanOrEqual(400);
    expect(h.priorLocalTurns!.length).toBe(3);
    // the MOST RECENT three survive
    expect(h.priorLocalTurns![0].q.startsWith('q3')).toBe(true);
    expect(h.priorLocalTurns![2].q.startsWith('q5')).toBe(true);
    for (const t of h.priorLocalTurns!) {
      expect(t.q.length).toBeLessThanOrEqual(300);
      expect(t.a.length).toBeLessThanOrEqual(600);
    }
  });

  test('localNote is only kept for the ungrounded reason', () => {
    expect(buildHandoff(base({ reason: 'step-limit', localNote: 'hello' })).localNote).toBeUndefined();
    expect(buildHandoff(base({ reason: 'ungrounded', localNote: 'hello' })).localNote).toBe('hello');
  });

  test('suggestedCall is never forecast (the dashboard agent has no forecast tool) [C2]', () => {
    const net = buildHandoff(base({ reason: 'tool-unavailable', suggestedCall: { tool: 'net_worth', args: { action: 'summary' } } }));
    expect(net.suggestedCall).toEqual({ tool: 'net_worth', args: { action: 'summary' } });
    const fc = buildHandoff(base({
      reason: 'tool-unavailable',
      // @ts-expect-error forecast is not an AgentReadToolName; the builder must still refuse it at runtime
      suggestedCall: { tool: 'forecast', args: {} },
    }));
    expect(fc.suggestedCall).toBeUndefined();
  });

  test('omitted optionals stay omitted (no undefined keys, no empty arrays)', () => {
    const h = buildHandoff(base({ priorLocalTurns: [] }));
    expect('priorLocalTurns' in h).toBe(false);
    expect('proposal' in h).toBe(false);
    expect('suggestedCall' in h).toBe(false);
    expect('localNote' in h).toBe(false);
  });
});

describe('8,000-char serialised cap and drop order', () => {
  const bigPriors = [1, 2, 3].map((i) => ({ q: `PRIOR-Q${i} ` + 'q'.repeat(290), a: `PRIOR-A${i} ` + 'a'.repeat(590) }));
  const longSummary = (tool: ExecutedStep['tool']): ExecutedStep => ({
    tool, args: { period: 'month' }, ok: true, ms: 1, summary: 's'.repeat(1_300),
  });

  test('under the cap nothing is dropped', () => {
    const h = buildHandoff(base({ reason: 'ungrounded', steps: [longSummary('spending_summary')], localNote: 'note', priorLocalTurns: bigPriors }));
    expect(JSON.stringify(h).length).toBeLessThanOrEqual(HANDOFF_CAPS.maxSerializedChars);
    expect(h.priorLocalTurns!.length).toBe(3);
    expect(h.localNote).toBe('note');
  });

  test('over the cap: the OLDEST prior turn goes first', () => {
    const steps = [longSummary('spending_summary'), longSummary('profit_loss'), longSummary('net_worth'), longSummary('forecast')];
    const h = buildHandoff(base({ reason: 'ungrounded', steps, localNote: 'n'.repeat(400), priorLocalTurns: bigPriors }));
    const len = JSON.stringify(h).length;
    expect(len).toBeLessThanOrEqual(HANDOFF_CAPS.maxSerializedChars);
    // 4 steps * 1200 + 3 * ~900 priors + note is > 8000, so something was dropped from priors first.
    expect(h.priorLocalTurns?.some((t) => t.q.startsWith('PRIOR-Q1')) ?? false).toBe(false);
    // and the note is still there as long as dropping priors was enough
    if (h.priorLocalTurns && h.priorLocalTurns.length > 0) expect(h.localNote).toBeDefined();
  });

  test('then localNote, then summaries are trimmed', () => {
    const huge = (tool: ExecutedStep['tool']): ExecutedStep => ({
      tool, args: { query: 'a'.repeat(1_800) }, ok: true, ms: 1, summary: 's'.repeat(1_300),
    });
    const steps = [huge('transaction_search'), huge('spending_summary'), huge('profit_loss'), huge('net_worth')];
    const h = buildHandoff(base({ reason: 'ungrounded', steps, localNote: 'n'.repeat(400), priorLocalTurns: bigPriors }));
    expect(JSON.stringify(h).length).toBeLessThanOrEqual(HANDOFF_CAPS.maxSerializedChars);
    expect(h.priorLocalTurns).toBeUndefined();
    expect(h.localNote).toBeUndefined();
    expect(h.steps.length).toBeGreaterThan(0);
    // summaries were trimmed (not all dropped): at least one is shorter than the original cap
    expect(h.steps.some((s) => s.summary.length < 1_200)).toBe(true);
  });

  test('always terminates under the cap, even for absurd args', () => {
    const steps = Array.from({ length: 4 }, () => ({
      tool: 'forecast' as const, args: { whatIf: Array.from({ length: 50 }, () => ({ type: 'drop_recurring', description: 'd'.repeat(500) })) },
      ok: true, ms: 1, summary: 's'.repeat(1_300),
    }));
    const h = buildHandoff(base({ steps, priorLocalTurns: bigPriors }));
    expect(JSON.stringify(h).length).toBeLessThanOrEqual(HANDOFF_CAPS.maxSerializedChars);
  });
});
