import { describe, expect, test } from 'bun:test';
import { CATEGORIES } from '../tools/categorize/categories.js';
import { fillArgs, numberWordToInt } from '../dashboard/ui/src/hybrid/subagent-args.js';
import { validateReadToolArgs } from '../dashboard/ui/src/hybrid/read-tool-schemas.js';
import gold from './fixtures/subagent-route-gold.json';

/**
 * Rule-based arg filling (spec 5.3). The LLM never writes args. Everything
 * here is pinned at now = 2026-07-15 (a Wednesday in July, so "last month" is
 * June, "May" is -2 months, "by year end" is 5 months out, Q3 is current).
 */

const NOW = new Date('2026-07-15T12:00:00');

function fill(tool: Parameters<typeof fillArgs>[0], q: string) {
  return fillArgs(tool, q, NOW, CATEGORIES);
}
function args(tool: Parameters<typeof fillArgs>[0], q: string): Record<string, unknown> {
  const r = fill(tool, q);
  if (!r.ok) throw new Error(`expected fillable, got unfillable (${r.why}): ${q}`);
  return r.args;
}
function unfillable(tool: Parameters<typeof fillArgs>[0], q: string): void {
  const r = fill(tool, q);
  expect(r.ok, q).toBe(false);
}

describe('number words', () => {
  test('one..twenty-four', () => {
    expect(numberWordToInt('one')).toBe(1);
    expect(numberWordToInt('three')).toBe(3);
    expect(numberWordToInt('six')).toBe(6);
    expect(numberWordToInt('twelve')).toBe(12);
    expect(numberWordToInt('twenty')).toBe(20);
    expect(numberWordToInt('twenty-four')).toBe(24);
    expect(numberWordToInt('Twenty Four')).toBe(24);
    expect(numberWordToInt('12')).toBe(12);
  });
  test('out of range and non-numbers are null', () => {
    expect(numberWordToInt('twenty-five')).toBeNull();
    expect(numberWordToInt('zero')).toBeNull();
    expect(numberWordToInt('banana')).toBeNull();
    expect(numberWordToInt('')).toBeNull();
  });
});

describe('transaction_search: canonical query, never the raw question [C3]', () => {
  const cases: Array<[string, string]> = [
    ['Show me every Whole Foods charge in June', 'Whole Foods in June'],
    ['Did I get charged twice by Adobe?', 'Adobe'],
    ['Show me every Whole Foods charge last month', 'Whole Foods last month'],
    ['Find all transactions over $200 in June', 'in June over $200'],
    ['When did I last pay Comcast?', 'Comcast'],
    ['List my Uber rides this year', 'Uber this year'],
    ['Search for anything from Ticketmaster', 'Ticketmaster'],
    ['How much did I pay in total to Costco this year?', 'Costco this year'],
    ['Show me recurring charges over $50', 'over $50 recurring'],
    ['Show me dining charges last month', 'Dining last month'],
    ['Show me my subscription payments under $20', 'under $20 recurring'],
    ['Find transactions over $1,000 in March', 'in March over $1000'],
    ['Show my Netflix charges last year', 'Netflix last year'],
  ];
  for (const [q, canonical] of cases) {
    test(`${q} -> "${canonical}"`, () => {
      expect(args('transaction_search', q)).toEqual({ query: canonical });
    });
  }

  test('unfillable: nothing to search for', () => {
    unfillable('transaction_search', 'Show me my transactions');
    unfillable('transaction_search', 'Show me all of them');
    unfillable('transaction_search', '');
  });

  test('unfillable: a date window the parser cannot express is never guessed', () => {
    unfillable('transaction_search', 'Pull up my rent payments from the last three months');
    unfillable('transaction_search', 'Show Uber charges in the last 30 days');
    unfillable('transaction_search', 'Show me Netflix charges yesterday');
    unfillable('transaction_search', 'Show me Netflix charges this week');
    unfillable('transaction_search', 'Show me Netflix charges since January');
    unfillable('transaction_search', 'Show me Uber charges in 2025');
  });

  test('unfillable: a category AND a merchant cannot both be expressed', () => {
    unfillable('transaction_search', 'Show me Starbucks dining charges');
  });

  test('unfillable: two different date phrases', () => {
    unfillable('transaction_search', 'Show Adobe charges last month and in March');
  });

  test('the canonical query round-trips through the real parser', () => {
    // fillArgs self-checks this; here we just pin that a merchant survives untouched.
    expect(args('transaction_search', 'Show me every Zzyzx Labs charge')).toEqual({ query: 'Zzyzx Labs' });
  });
});

describe('spending_summary: explicit defaults, only current periods', () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ['Where did my money go this month?', { period: 'month', compareWithPrevious: true }],
    ['Break down my spending by category for the quarter', { period: 'quarter', compareWithPrevious: true }],
    ['What are my biggest expense categories this year?', { period: 'year', compareWithPrevious: true }],
    ['How much did I spend on dining compared to last month?', { period: 'month', compareWithPrevious: true }],
    ['Am I spending more on groceries than before?', { period: 'month', compareWithPrevious: true }],
    ['Which category grew the most compared to the previous period?', { period: 'month', compareWithPrevious: true }],
    ['What did I spend in July?', { period: 'month', compareWithPrevious: true }],
  ];
  for (const [q, expected] of cases) {
    test(q, () => {
      expect(args('spending_summary', q)).toEqual(expected);
    });
  }

  test('a named past period spending_summary cannot express is unfillable', () => {
    unfillable('spending_summary', 'What did I spend in March?');
    unfillable('spending_summary', 'What did I spend last month?');
    unfillable('spending_summary', 'Break down my spending last quarter');
    unfillable('spending_summary', 'What did I spend per category in the last 30 days?');
    unfillable('spending_summary', 'Spending in the second quarter');
  });
});

describe('profit_loss: period + offset', () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ['Give me a profit and loss for last quarter', { period: 'quarter', offset: -1 }],
    ['How much did my business make versus spend in May?', { period: 'month', offset: -2 }],
    ['Income vs expenses for the year so far', { period: 'year', offset: 0 }],
    ['Did I come out ahead last month?', { period: 'month', offset: -1 }],
    ['P&L by category for this month', { period: 'month', offset: 0 }],
    ['Give me a P&L for June', { period: 'month', offset: -1 }],
    ['Show income minus expenses for the previous quarter', { period: 'quarter', offset: -1 }],
    ['What was my profit last year?', { period: 'year', offset: -1 }],
    ['P&L for this quarter', { period: 'quarter', offset: 0 }],
    ['What is my profit YTD?', { period: 'year', offset: 0 }],
    ['P&L for Q1', { period: 'quarter', offset: -2 }],
    ['P&L for the second quarter', { period: 'quarter', offset: -1 }],
    ['P&L for July', { period: 'month', offset: 0 }],
  ];
  for (const [q, expected] of cases) {
    test(q, () => {
      expect(args('profit_loss', q)).toEqual(expected);
    });
  }

  test('year-boundary: month names read in the current year only; "last month" in January is still offset -1', () => {
    const jan = new Date('2027-01-10T12:00:00');
    // Month names are read inside the current year only; December is in the future => unfillable.
    expect(fillArgs('profit_loss', 'P&L for December', jan, CATEGORIES).ok).toBe(false);
    expect(fillArgs('profit_loss', 'P&L for last month', jan, CATEGORIES)).toEqual({
      ok: true,
      args: { period: 'month', offset: -1 },
    });
  });

  test('anything the rules cannot place is unfillable', () => {
    unfillable('profit_loss', 'P&L for December'); // future month
    unfillable('profit_loss', 'P&L for Q4'); // future quarter
    unfillable('profit_loss', 'Show me my P&L'); // no period cue at all
    unfillable('profit_loss', 'Profit over the last 90 days');
    unfillable('profit_loss', 'Profit since March');
    unfillable('profit_loss', 'Profit in 2024');
    unfillable('profit_loss', 'Profit for June 2025');
  });
});

describe('net_worth: action + months', () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ['What is my net worth?', { action: 'summary' }],
    ['Show my net worth trend over the last 12 months', { action: 'trend', months: 12 }],
    ['Give me my balance sheet with assets and liabilities', { action: 'balance_sheet' }],
    ['Am I worth more than I was six months ago?', { action: 'trend', months: 6 }],
    ['How have my assets and debts changed over the past year?', { action: 'trend', months: 12 }],
    ['What do my total assets minus liabilities come to?', { action: 'summary' }],
    ['Show my net worth over the last twenty-four months', { action: 'trend', months: 24 }],
    ['Has my net worth changed?', { action: 'trend', months: 12 }],
  ];
  for (const [q, expected] of cases) {
    test(q, () => {
      expect(args('net_worth', q)).toEqual(expected);
    });
  }
});

describe('forecast: horizon + what-if', () => {
  const base = { trailingMonths: 3, horizonMonths: 3 };
  const cases: Array<[string, Record<string, unknown>]> = [
    ['What will my savings look like in three months?', { ...base, horizonMonths: 3 }],
    ['Project my cash flow for the next six months', { ...base, horizonMonths: 6 }],
    ['Project my cash flow for the next 12 months', { ...base, horizonMonths: 12 }],
    ['Will I have enough cash by September at my current pace?', { ...base, horizonMonths: 2 }],
    ['Estimate my savings at the end of the year if I keep spending like this', { ...base, horizonMonths: 5 }],
    ['What will my cash be by year end?', { ...base, horizonMonths: 5 }],
    ['Forecast my cash', base],
    [
      'If I cancel Netflix, how much will I save by year end?',
      { ...base, horizonMonths: 5, whatIf: [{ type: 'drop_recurring', description: 'Netflix' }] },
    ],
    [
      'What if I cut dining out by $100 a month?',
      { ...base, whatIf: [{ type: 'adjust_category', category: 'Dining', monthlyDelta: -100 }] },
    ],
    [
      'What if I spend $200 more on groceries a month for the next 6 months?',
      { ...base, horizonMonths: 6, whatIf: [{ type: 'adjust_category', category: 'Groceries', monthlyDelta: 200 }] },
    ],
    [
      'What happens if I stop paying for Adobe?',
      { ...base, whatIf: [{ type: 'drop_recurring', description: 'Adobe' }] },
    ],
  ];
  for (const [q, expected] of cases) {
    test(q, () => {
      expect(args('forecast', q)).toEqual(expected);
    });
  }

  test('a what-if that does not parse is unfillable, never ignored', () => {
    unfillable('forecast', 'What if I buy a boat?');
    unfillable('forecast', 'If I get a raise, what happens to my savings?');
    unfillable('forecast', 'What if I cut spending by $100 a month?'); // no category named
    unfillable('forecast', 'What if I cut astronomy by $100 a month?'); // not a category
  });

  test('a horizon outside 1..24 is unfillable', () => {
    unfillable('forecast', 'Project my cash for the next 30 months');
  });
});

describe('schema validation', () => {
  test('every fillable gold read row yields args that pass the frozen schema snapshot', () => {
    const rows = (gold.rows as Array<{ question: string; expected: string }>).filter((r) => r.expected !== 'none');
    let filled = 0;
    for (const r of rows) {
      const res = fill(r.expected as 'forecast', r.question);
      if (!res.ok) continue;
      filled++;
      expect(validateReadToolArgs(r.expected, res.args), r.question).toEqual({ ok: true });
    }
    expect(filled).toBeGreaterThan(20);
  });

  test('all net_worth and forecast gold rows are fillable', () => {
    const rows = (gold.rows as Array<{ question: string; expected: string }>).filter(
      (r) => r.expected === 'net_worth' || r.expected === 'forecast'
    );
    for (const r of rows) {
      expect(fill(r.expected as 'forecast', r.question).ok, r.question).toBe(true);
    }
  });

  test('never throws, whatever the input', () => {
    for (const q of ['', '   ', '💸'.repeat(50), 'x'.repeat(5000), '$$$', 'over under last next ago']) {
      for (const t of ['transaction_search', 'spending_summary', 'profit_loss', 'net_worth', 'forecast'] as const) {
        expect(() => fill(t, q)).not.toThrow();
      }
    }
  });
});
