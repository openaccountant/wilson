import { describe, expect, test } from 'bun:test';
import { isToolResultEcho, toolResultsFallback } from '../agent/local-answer-check.js';

/**
 * Granite answered "What were my biggest expenses?" with the iteration
 * prompt's tool block verbatim: "### spending_summary(period=month, …)\n{"data":…".
 * The agent catches such answers for local models.
 */

const SUMMARY = JSON.stringify({
  data: {
    period: 'August 2026',
    totalSpending: -640,
    formatted: 'Spending Summary: August 2026\n\nCategory   Amount\nTravel   -$640.00',
  },
});

describe('isToolResultEcho', () => {
  test('the tool-result heading of a called tool', () => {
    expect(isToolResultEcho(`### spending_summary(period=month, compareWithPrevious=true)\n${SUMMARY}`, ['spending_summary'])).toBe(true);
    expect(isToolResultEcho('  ###spending_summary()\n…', ['spending_summary'])).toBe(true);
  });

  test('raw tool-result JSON, alone or inside the answer', () => {
    expect(isToolResultEcho(SUMMARY, ['spending_summary'])).toBe(true);
    expect(isToolResultEcho(`Here you go: ${SUMMARY}`, ['spending_summary'])).toBe(true);
  });

  test('a plain-language answer, even one quoting numbers or a table', () => {
    expect(isToolResultEcho('Your biggest expense in August 2026 was **Travel** at $640.', ['spending_summary'])).toBe(false);
    expect(isToolResultEcho('| Cat. | Amount |\n|---|---|\n| Travel | $640 |', ['spending_summary'])).toBe(false);
    // A heading for a tool that was not called is not an echo.
    expect(isToolResultEcho('### budget_set(x=1)', ['spending_summary'])).toBe(false);
  });
});

describe('toolResultsFallback', () => {
  test('the latest result with a formatted summary, in a code block', () => {
    const answer = toolResultsFallback([
      { tool: 'transaction_search', args: {}, result: JSON.stringify({ data: { formatted: 'older' } }) },
      { tool: 'spending_summary', args: {}, result: SUMMARY },
    ]);
    expect(answer).toBe("Here's what I found:\n\n```\nSpending Summary: August 2026\n\nCategory   Amount\nTravel   -$640.00\n```");
  });

  test('no formatted result: a short message, never the raw data', () => {
    const answer = toolResultsFallback([{ tool: 'net_worth', args: {}, result: '{"data":{"netWorth":1}}' }]);
    expect(answer).not.toContain('{');
    expect(answer).toContain('rephras');
  });
});
