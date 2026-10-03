import { describe, expect, test } from 'bun:test';
import { detectComparisonIntent } from '../dashboard/ui/src/hybrid/subagent-intent.js';
import { gateQuestion } from '../dashboard/ui/src/hybrid/subagent-core.js';

/**
 * Round 3 (specs/DECISIONS.md "Empty results"): what-if, comparison and trend phrasing needs more
 * than one read tool call, which the single-call templates cannot express, so it hands off. This is an
 * explicit, total detector over the question text only.
 */

const POSITIVE: Array<[string, string]> = [
  // the decision's own examples
  ['forecast without golf dues', 'what-if'],
  ['What would my savings be if I cancel Netflix?', 'what-if'],
  ['if I cut dining by 20% what happens to my cash', 'what-if'],
  ['what if I stop paying for the gym', 'what-if'],
  ['spending vs last month', 'comparison'],
  ['income vs expenses vs last year', 'comparison'],
  ['Show me spending versus June', 'comparison'],
  ['how does this month compare to last month', 'comparison'],
  ['spending compared to last quarter', 'comparison'],
  ['Compare my spending in May and June', 'comparison'],
  ['are we spending more than last month', 'comparison'],
  ['did I earn less than last year', 'comparison'],
  ['Is dining higher than usual?', 'comparison'],
  ['how much did spending change from last month', 'comparison'],
  ['what is the difference between June and July spending', 'comparison'],
  ['spending over the last 3 months', 'multi-period'],
  ['What did I earn over the last six months?', 'multi-period'],
  ['expenses for the past 4 months', 'multi-period'],
  ['average spending over the last few months', 'multi-period'],
  ['month by month spending', 'multi-period'],
  ["how's my spending trending vs last month", 'comparison'],
  ['spending trend', 'trend'],
  ['Is my income trending up?', 'trend'],
  ['show my net worth over time', 'trend'],
  ['year over year profit', 'trend'],
  ['month-over-month spending', 'trend'],
];

const NEGATIVE = [
  'P&L june',
  'income vs expenses',
  'Income versus expenses this month',
  'income minus expenses last month',
  'how much do I make versus spend',
  'spending by category',
  'what is my net worth',
  'forecast',
  'where will my cash be in 3 months',
  'how much will we have saved in 6 months',
  'adobe charges?',
  'list client payments',
  'how much was the delta flight',
  'what did I spend last month',
  'profit this quarter',
  'show me spending for the last month',
  "what's the biggest category",
  'show transactions from the last 30 days',
  'Did I get charged twice by Adobe?',
  'Pull up my rent payments from March',
  'What are my balances?',
];

describe('detectComparisonIntent', () => {
  for (const [q, kind] of POSITIVE) {
    test(`hands off (${kind}): ${q}`, () => {
      expect(detectComparisonIntent(q)).toBe(kind as never);
    });
  }
  for (const q of NEGATIVE) {
    test(`single-call phrasing passes: ${q}`, () => {
      expect(detectComparisonIntent(q)).toBeNull();
    });
  }

  test('case, curly quotes and extra whitespace do not hide it', () => {
    expect(detectComparisonIntent('  SPENDING   VS.   LAST MONTH ')).toBe('comparison');
    expect(detectComparisonIntent('WITHOUT the gym')).toBe('what-if');
  });
  test('total: never throws, null on empty or non-strings', () => {
    for (const v of ['', '   ', undefined, null, 42, {}] as unknown[]) {
      expect(detectComparisonIntent(v as string)).toBeNull();
    }
  });
  test('the three decision examples that must hand off are all read-shaped, i.e. the gate lets them reach the detector', () => {
    for (const q of ['What would my savings be if I cancel Netflix?', 'spending vs last month', 'Are we spending more than last month?']) {
      expect(gateQuestion(q).kind, q).toBe('route');
    }
  });
});
