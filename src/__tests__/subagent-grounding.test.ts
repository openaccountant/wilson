import { describe, expect, test } from 'bun:test';
import { isGrounded, type GroundingStep } from '../dashboard/ui/src/hybrid/subagent-core.js';

/**
 * VERIFY (spec 5.2, [C10]): the anti-hallucination guard for a 0.6B composer.
 * Every money amount and percentage in the answer must come from the tool data
 * (numeric leaves AND numbers inside string leaves, sign-insensitive, within a
 * cent), or be a difference / percent derived from two such numbers. URLs,
 * links, images and raw HTML always fail.
 */

const searchStep: GroundingStep = {
  tool: 'transaction_search',
  data: {
    count: 2,
    formatted: 'Found 2 transactions:\n2026-06-05 ADOBE CREATIVE CLOUD -54.99\n2026-06-05 ADOBE CREATIVE CLOUD -54.99\nTotal: -109.98',
    transactions: [
      { id: 11, date: '2026-06-05', description: 'ADOBE CREATIVE CLOUD', amount: -54.99, category: null },
      { id: 12, date: '2026-06-05', description: 'ADOBE CREATIVE CLOUD', amount: -54.99, category: null },
    ],
  },
};

const summaryStep: GroundingStep = {
  tool: 'spending_summary',
  data: {
    period: 'July 2026',
    totalSpending: 1234.56,
    transactionCount: 14,
    categories: [
      { category: 'Dining', total: 400, count: 6 },
      { category: 'Groceries', total: 834.56, count: 8 },
    ],
    previousPeriod: { label: 'June 2026', totalSpending: 1000, categories: [] },
    formatted: 'Total: $1,234.56',
  },
};

describe('amounts', () => {
  test('exact amounts from numeric leaves are grounded, sign-insensitive', () => {
    expect(isGrounded('Both Adobe charges were $54.99 each.', [searchStep])).toBe(true);
    expect(isGrounded('You paid -$54.99 twice.', [searchStep])).toBe(true);
  });

  test('a number that appears only inside a string leaf still counts', () => {
    expect(isGrounded('The total was $109.98.', [searchStep])).toBe(true);
  });

  test('an invented amount fails', () => {
    expect(isGrounded('Both Adobe charges were $55.99 each.', [searchStep])).toBe(false);
    expect(isGrounded('You spent $9,999.99.', [summaryStep])).toBe(false);
  });

  test('thousands separators are parsed', () => {
    expect(isGrounded('Total spending was $1,234.56.', [summaryStep])).toBe(true);
    expect(isGrounded('Total spending was $1,234.58.', [summaryStep])).toBe(false);
  });

  test('numbers across several steps pool together', () => {
    expect(isGrounded('Adobe was $54.99 and dining was $400.00.', [searchStep, summaryStep])).toBe(true);
  });

  test('an answer with no figures at all is grounded (nothing to contradict)', () => {
    expect(isGrounded('Yes, you were charged twice by Adobe on the same day.', [searchStep])).toBe(true);
  });
});

describe('rounding', () => {
  test('a whole-dollar answer may round or truncate the cents', () => {
    expect(isGrounded('You spent about $1,235.', [summaryStep])).toBe(true);
    expect(isGrounded('You spent about $1,234.', [summaryStep])).toBe(true);
    expect(isGrounded('You spent about $1,240.', [summaryStep])).toBe(false);
  });

  test('one-decimal answers round to the tenth', () => {
    expect(isGrounded('That is $1,234.6.', [summaryStep])).toBe(true);
    expect(isGrounded('That is $1,234.9.', [summaryStep])).toBe(false);
  });

  test('a cent of float noise is tolerated, two cents are not', () => {
    const s: GroundingStep = { tool: 'profit_loss', data: { net: 100.004 } };
    expect(isGrounded('Net was $100.00.', [s])).toBe(true);
    expect(isGrounded('Net was $100.03.', [s])).toBe(false);
  });
});

describe('differences and percents', () => {
  test('a difference between two data numbers is grounded', () => {
    // 1234.56 - 1000 = 234.56
    expect(isGrounded('You spent $234.56 more than last month.', [summaryStep])).toBe(true);
    expect(isGrounded('You spent $244.56 more than last month.', [summaryStep])).toBe(false);
  });

  test('a percent derived from two data numbers is grounded', () => {
    // (1234.56 - 1000) / 1000 = 23.456%
    expect(isGrounded('Spending rose 23% from last month.', [summaryStep])).toBe(true);
    expect(isGrounded('Spending rose 23.5% from last month.', [summaryStep])).toBe(true);
    expect(isGrounded('Spending rose 45% from last month.', [summaryStep])).toBe(false);
  });

  test('a share-of-total percent is grounded', () => {
    // 400 / 1234.56 = 32.4%
    expect(isGrounded('Dining was 32% of spending.', [summaryStep])).toBe(true);
  });

  test('a percent present in the data is grounded as-is', () => {
    const s: GroundingStep = { tool: 'profit_loss', data: { margin: 12.5 } };
    expect(isGrounded('Margin was 12.5%.', [s])).toBe(true);
  });
});

describe('plain numbers that are not money', () => {
  test('counts, days and years are not checked', () => {
    expect(isGrounded('You were charged 2 times on June 5, 2026.', [searchStep])).toBe(true);
  });

  test('row ids and "#id" tokens are not checked', () => {
    expect(isGrounded('See transaction #1500.', [searchStep])).toBe(true);
  });
});

describe('[C10] links, images and HTML always fail', () => {
  const cases = [
    'See https://evil.example/x for details.',
    'More at http://evil.example',
    'Visit www.evil.example today.',
    'Here: ![x](https://evil.example/p.png)',
    'Details: [click here](https://evil.example)',
    'Try [this](javascript:alert(1))',
    'Look <img src="x"> here',
    'Look <b>bold</b> here',
  ];
  for (const text of cases) {
    test(text, () => {
      expect(isGrounded(text, [searchStep])).toBe(false);
    });
  }

  test('a comparison like "5 < 10" is not HTML', () => {
    expect(isGrounded('Charges under 5 < 10 days apart.', [searchStep])).toBe(true);
  });
});

describe('robustness', () => {
  test('never throws on odd data', () => {
    const odd: GroundingStep = { tool: 'forecast', data: { a: null, b: undefined, c: [[1, [2]]], d: 'x', e: NaN, f: Infinity } };
    expect(() => isGrounded('Cash will be $2.00.', [odd])).not.toThrow();
    expect(() => isGrounded('x', [{ tool: 'forecast', data: undefined }])).not.toThrow();
  });

  test('a cyclic data object does not hang', () => {
    const a: Record<string, unknown> = { n: 5.5 };
    a.self = a;
    expect(isGrounded('That is $5.50.', [{ tool: 'profit_loss', data: a }])).toBe(true);
  });
});
