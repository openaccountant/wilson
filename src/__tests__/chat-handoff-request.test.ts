import { describe, expect, test } from 'bun:test';
import { buildChatRequest, hasHandoffPayload } from '../dashboard/ui/src/lib/chat-request.js';
import type { HybridResult } from '../dashboard/ui/src/hybrid/core.js';
import type { LocalHandoffV1 } from '../dashboard/local-handoff-format.js';

/**
 * buildChatRequest is the pure seam between a finished local attempt and the
 * POST /api/chat body (spec section 11, slice 6). The handoff rides only when
 * the local attempt produced one AND no @mentions are present (mentions go
 * straight to the server and never reach the hybrid layer anyway; this is the
 * belt-and-braces half of that rule).
 */

const STEP = {
  tool: 'transaction_search' as const,
  args: { query: 'Adobe' },
  ok: true,
  summary: '#1 2026-06-03 -$54.99 WHOLE',
};

function handoff(over: Partial<LocalHandoffV1> = {}): LocalHandoffV1 {
  return { v: 1, reason: 'empty-result', mirror: { syncedAt: '2026-10-02T10:00:00.000Z' }, steps: [STEP], ...over };
}

const MENTION = { type: 'category' as const, id: 3, label: 'Dining' };

describe('buildChatRequest', () => {
  test('plain request: query only, session id when known', () => {
    expect(buildChatRequest('hi', null, [], { ok: false })).toEqual({ query: 'hi' });
    expect(buildChatRequest('hi', 's1', [], { ok: false })).toEqual({ query: 'hi', sessionId: 's1' });
  });

  test('attaches localHandoff only when the result carries one', () => {
    const h = handoff();
    const withIt = buildChatRequest('q', 's1', [], { ok: false, reason: 'empty-result', handoff: h });
    expect(withIt.localHandoff).toEqual(h);
    expect(withIt.query).toBe('q');
    expect(withIt.sessionId).toBe('s1');

    const without = buildChatRequest('q', 's1', [], { ok: false, reason: 'outside-bundle' });
    expect('localHandoff' in without).toBe(false);
  });

  test('never attaches a handoff when mentions are present, and keeps the mentions', () => {
    const req = buildChatRequest('q @Dining', null, [MENTION], { ok: false, reason: 'empty-result', handoff: handoff() });
    expect('localHandoff' in req).toBe(false);
    expect(req.mentions).toEqual([MENTION]);
  });

  test('caps mentions at 10 (MAX_MENTIONS) and trims labels to 120', () => {
    const many = Array.from({ length: 14 }, (_, i) => ({ type: 'category' as const, id: i, label: 'L'.repeat(200) }));
    const req = buildChatRequest('q', null, many, { ok: false });
    expect(req.mentions).toHaveLength(10);
    expect(req.mentions![0].label).toHaveLength(120);
  });

  test('a handoff with nothing in it is not sent at all', () => {
    const empty = handoff({ reason: 'non-data', steps: [] });
    const req = buildChatRequest('explain a Roth IRA', null, [], { ok: false, reason: 'non-data', handoff: empty });
    expect('localHandoff' in req).toBe(false);
  });

  test('a priors-only handoff IS sent (it closes the history gap)', () => {
    const priors = handoff({ reason: 'non-data', steps: [], priorLocalTurns: [{ q: 'a', a: 'b' }] });
    const req = buildChatRequest('explain', null, [], { ok: false, reason: 'non-data', handoff: priors });
    expect(req.localHandoff?.priorLocalTurns).toEqual([{ q: 'a', a: 'b' }]);
  });

  test('priorTurns fill a handoff that lacks them (last 3), but never create one on their own', () => {
    const turns = [1, 2, 3, 4].map((n) => ({ q: `q${n}`, a: `a${n}` }));
    const filled = buildChatRequest('q', null, [], { ok: false, handoff: handoff() }, turns);
    expect(filled.localHandoff?.priorLocalTurns).toEqual(turns.slice(-3));
    // A handoff that already carries priors keeps its own.
    const own = [{ q: 'own', a: 'turns' }];
    const kept = buildChatRequest('q', null, [], { ok: false, handoff: handoff({ priorLocalTurns: own }) }, turns);
    expect(kept.localHandoff?.priorLocalTurns).toEqual(own);
    // No handoff on the result: priors alone do not start one.
    const none = buildChatRequest('q', null, [], { ok: false, reason: 'outside-bundle' }, turns);
    expect('localHandoff' in none).toBe(false);
  });

  test('an answered local result never builds a handoff', () => {
    const r: HybridResult = { ok: true, answer: 'x', sessionId: null, source: 'local' };
    expect('localHandoff' in buildChatRequest('q', null, [], r)).toBe(false);
  });
});

describe('hasHandoffPayload (what "handoffSent" means for the badge)', () => {
  test('true for steps, a suggestedCall or a proposal', () => {
    expect(hasHandoffPayload(handoff())).toBe(true);
    expect(hasHandoffPayload(handoff({ steps: [], suggestedCall: { tool: 'net_worth', args: {} } }))).toBe(true);
    expect(
      hasHandoffPayload(handoff({ steps: [], proposal: { tool: 'edit_transaction', userWords: 'recategorize Netflix' } })),
    ).toBe(true);
  });

  test('false for priors-only, empty and absent handoffs', () => {
    expect(hasHandoffPayload(handoff({ steps: [], priorLocalTurns: [{ q: 'a', a: 'b' }] }))).toBe(false);
    expect(hasHandoffPayload(handoff({ steps: [] }))).toBe(false);
    expect(hasHandoffPayload(undefined)).toBe(false);
  });
});
