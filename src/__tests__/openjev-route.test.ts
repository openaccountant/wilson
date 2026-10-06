import { describe, expect, test } from 'bun:test';
import {
  OPEN_JEV_CHAT_TIMEOUT_MS,
  OPEN_JEV_ROUTE_CUT,
  OPEN_JEV_ROUTE_OPTIONS,
  OPEN_JEV_ROUTE_QUESTION,
  decideRoute,
  routeChoiceQuestion,
  routeOptionStrings,
  routeOptionTokens,
  type ToolChoice,
} from '../dashboard/ui/src/hybrid/openjev-route.js';
import { READ_TOOLS } from '../dashboard/ui/src/hybrid/subagent-core.js';

/**
 * Round 4, slice R4-1 (specs/browser-subagent-round4-openjev-router.md §1, §3, §9):
 * the pure open-jev tiebreak decision. open-jev only ever sees questions with 0 or 2+
 * keyword hits, picks among the 5 read tools (never `none`), and is honoured only when
 * its margin clears the frozen cut and, on a multi-hit, its top1 is one of the hits
 * (DECISIONS Round 4: "when several keywords match, open-jev must pick one of them").
 */

const CUT = 0.3;

function choice(tool: string, p1: number, p2: number): ToolChoice {
  return { tool, p1, p2, margin: p1 - p2 };
}

describe('decideRoute', () => {
  test('exactly one keyword hit ignores any choice (keyword route, round 3 unchanged)', () => {
    for (const ch of [null, choice('net_worth', 0.9, 0.05), choice('profit_loss', 0.1, 0.09)]) {
      expect(decideRoute(['spending_summary'], ch, CUT)).toEqual({ tool: 'spending_summary', via: 'keyword' });
    }
    // even with arm O disabled (no cut)
    expect(decideRoute(['forecast'], choice('net_worth', 0.9, 0.05), null)).toEqual({ tool: 'forecast', via: 'keyword' });
  });

  test('0 hits with margin >= cut gives top1 via openjev', () => {
    expect(decideRoute([], choice('net_worth', 0.7, 0.2), CUT)).toEqual({ tool: 'net_worth', via: 'openjev' });
    // the cut itself is inclusive
    expect(decideRoute([], { tool: 'forecast', p1: 0.6, p2: 0.3, margin: CUT }, CUT)).toEqual({ tool: 'forecast', via: 'openjev' });
  });

  test('margin < cut hands off as router-none (low-margin)', () => {
    expect(decideRoute([], choice('net_worth', 0.4, 0.3), CUT)).toEqual({ handoff: 'router-none', why: 'low-margin' });
  });

  test('NaN, Infinity or a non-number margin hands off', () => {
    for (const margin of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, '0.9' as unknown as number]) {
      expect(decideRoute([], { tool: 'net_worth', p1: 0.9, p2: 0.1, margin }, CUT)).toEqual({ handoff: 'router-none', why: 'bad-margin' });
    }
  });

  test('an unknown tool (including none) hands off', () => {
    for (const tool of ['none', 'edit_transaction', 'Net_Worth', '', 'categorize']) {
      expect(decideRoute([], choice(tool, 0.95, 0.01), CUT)).toEqual({ handoff: 'router-none', why: 'unknown-tool' });
    }
  });

  test('cut === null (arm O disabled) hands off every 0 / 2+ hit turn', () => {
    expect(decideRoute([], choice('net_worth', 0.99, 0.0), null)).toEqual({ handoff: 'router-none', why: 'disabled' });
    expect(decideRoute(['net_worth', 'forecast'], choice('net_worth', 0.99, 0.0), null)).toEqual({ handoff: 'router-none', why: 'disabled' });
  });

  test('an invalid cut (NaN, out of range) is treated as disabled', () => {
    for (const cut of [Number.NaN, -0.1, 1.5, Number.POSITIVE_INFINITY]) {
      expect(decideRoute([], choice('net_worth', 0.99, 0.0), cut)).toEqual({ handoff: 'router-none', why: 'disabled' });
    }
  });

  test('no choice (arm unavailable, not ready, timed out) hands off', () => {
    expect(decideRoute([], null, CUT)).toEqual({ handoff: 'router-none', why: 'unavailable' });
    expect(decideRoute(['profit_loss', 'spending_summary'], null, CUT)).toEqual({ handoff: 'router-none', why: 'unavailable' });
  });

  test('multi-hit with top1 outside the hit set hands off (inconsistent)', () => {
    expect(decideRoute(['profit_loss', 'spending_summary'], choice('net_worth', 0.9, 0.05), CUT)).toEqual({
      handoff: 'router-none',
      why: 'inconsistent',
    });
  });

  test('multi-hit with top1 inside the hit set gives top1', () => {
    expect(decideRoute(['profit_loss', 'spending_summary'], choice('spending_summary', 0.8, 0.1), CUT)).toEqual({
      tool: 'spending_summary',
      via: 'openjev',
    });
  });

  test('multi-hit consistency is checked before the margin is trusted, and a low margin still hands off', () => {
    expect(decideRoute(['profit_loss', 'spending_summary'], choice('profit_loss', 0.45, 0.4), CUT)).toEqual({
      handoff: 'router-none',
      why: 'low-margin',
    });
  });

  test('a hit list with an unknown name never widens what open-jev may pick', () => {
    expect(decideRoute(['none', 'net_worth'] as string[], choice('none', 0.9, 0.05), CUT)).toEqual({ handoff: 'router-none', why: 'unknown-tool' });
  });

  test('never throws on junk input', () => {
    const junk = [undefined, null, 42, 'x', {}, { tool: 1 }] as unknown[];
    for (const ch of junk) {
      expect(() => decideRoute([], ch as ToolChoice, CUT)).not.toThrow();
      expect('handoff' in decideRoute([], ch as ToolChoice, CUT)).toBe(true);
    }
    expect(() => decideRoute(undefined as unknown as string[], choice('net_worth', 0.9, 0.1), CUT)).not.toThrow();
  });
});

describe('route options and question', () => {
  test('the options are exactly the 5 read tools in catalog order, and never include none', () => {
    expect(Object.keys(OPEN_JEV_ROUTE_OPTIONS)).toEqual([...READ_TOOLS]);
    expect(Object.keys(OPEN_JEV_ROUTE_OPTIONS)).not.toContain('none');
    expect(routeChoiceQuestion().options).toEqual([...READ_TOOLS]);
    expect(routeChoiceQuestion().options).not.toContain('none');
    for (const s of routeOptionStrings()) expect(s.toLowerCase().startsWith('none')).toBe(false);
  });

  test('the question is the spike text with the none sentence removed', () => {
    expect(OPEN_JEV_ROUTE_QUESTION).toBe('Which tool should answer this user question?');
    expect(OPEN_JEV_ROUTE_QUESTION).not.toMatch(/none/i);
  });

  test('descriptions mode renders "name: description", the way open-jev renders choice() with descriptions', () => {
    const q = routeChoiceQuestion('descriptions');
    expect(q).toEqual({ type: 'choice', instructions: OPEN_JEV_ROUTE_QUESTION, options: [...READ_TOOLS], descriptions: { ...OPEN_JEV_ROUTE_OPTIONS } });
    expect(routeOptionStrings('descriptions')).toEqual(READ_TOOLS.map((t) => `${t}: ${OPEN_JEV_ROUTE_OPTIONS[t]}`));
  });

  test('bare mode (the pre-registered fallback) renders the tool names only', () => {
    const q = routeChoiceQuestion('bare');
    expect(q).toEqual({ type: 'choice', instructions: OPEN_JEV_ROUTE_QUESTION, options: [...READ_TOOLS] });
    expect(routeOptionStrings('bare')).toEqual([...READ_TOOLS]);
  });

  test('total option tokens stay under the engine limit (200) with a stub counter', () => {
    // Stub: one token per word piece or punctuation mark. DeBERTa-v3 sentencepiece splits snake_case
    // names into more pieces than words, so the stub also counts each '_' segment.
    const stub = (text: string) => (text.match(/[A-Za-z0-9]+|[^\sA-Za-z0-9]/g) ?? []).length;
    const total = routeOptionTokens(stub);
    expect(total).toBeGreaterThan(0);
    expect(total).toBeLessThan(200);
    expect(routeOptionTokens(stub, 'bare')).toBeLessThan(total);
  });

  test('the frozen constants are frozen', () => {
    expect(Object.isFrozen(OPEN_JEV_ROUTE_OPTIONS)).toBe(true);
    expect(OPEN_JEV_CHAT_TIMEOUT_MS).toBe(400);
    expect(OPEN_JEV_ROUTE_CUT === null || (typeof OPEN_JEV_ROUTE_CUT === 'number' && OPEN_JEV_ROUTE_CUT >= 0.05 && OPEN_JEV_ROUTE_CUT <= 0.95)).toBe(true);
  });
});
