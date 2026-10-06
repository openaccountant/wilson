import { describe, expect, test } from 'bun:test';
import { gateQuestion } from '../dashboard/ui/src/hybrid/subagent-core.js';

/** Round 4 (specs/DECISIONS.md "Round 4", "Bugs to fix"). */

describe('(3) gate: the change-wording check applies to the round-3 READ_START openers', () => {
  // None of these contain a MUTATION_VERB. With the round-3 openers ("all my", "any", "every",
  // "everything", noun-phrase report names) they all reached `route`; at 786d3e6 none did.
  const LEAKS = [
    'All my Starbucks should be Dining',
    'all my Uber charges count as Transport',
    'Any Netflix charge belongs under Entertainment',
    'every Costco purchase is Household, not Groceries',
    'Everything from Whole Foods is Groceries',
    'everything at Shell should be Gas',
    'All the Delta ones are Travel',
    'Anything from Trader Joes goes to Groceries',
    'any amazon order is shopping going forward',
    'Spending at Chipotle counts as Dining',
    'Expenses from Shell are Gas, not Shopping',
    'Total from the Home Depot trip is a business expense',
    'please, all my Lyft rides should be Transport',
  ];
  for (const q of LEAKS) {
    test(`not routed: ${q}`, () => {
      expect(gateQuestion(q).kind, q).not.toBe('route');
    });
  }

  const READS = [
    'any charges from hulu lately',
    'every transaction tagged groceries in july',
    'anything from Delta airlines in 2026',
    'any spotify payments',
    'anything over $100',
    'any bank fees i got hit with',
    'anything today?',
    'anything from dayjob inc',
    'everything on 06/05',
    'anything for school',
    'all my transactions over $500',
    'all my Uber rides in June',
    'Spending by category this month',
    'expenses over $500 last quarter',
    'total spent on coffee in June',
    'net worth',
    'profit last month',
  ];
  for (const q of READS) {
    test(`still routed: ${q}`, () => {
      expect(gateQuestion(q).kind, q).toBe('route');
    });
  }
});

describe('(3b) gate: the change-wording check applies to EVERY non-question READ_START opener', () => {
  // Verb-less change requests that start with a report-name / forecast / conditional opener. None has a
  // MUTATION_VERB, so before this fix they went straight to `route` through READ_START.
  const OPENER_LEAKS: Record<string, string[]> = {
    profit: [
      'Profit for June should include the Etsy refund',
      'Profit needs the Etsy refund counted as income',
      'profit last month is wrong, the refund belongs in it',
    ],
    'p&l': ['P&L should leave out the owner draws', 'p&l needs the Etsy refund', 'P&L is wrong, the refund is income'],
    'net worth': [
      'net worth needs the 401k at 52k',
      'Net worth should include the car',
      'net worth is wrong, the 401k is 52k',
    ],
    'balance sheet': [
      'Balance sheet should show the mortgage as a liability',
      'balance sheet needs the 401k at 52k',
      'Balance sheet is wrong, the loan is paid off',
    ],
    'income vs': [
      'Income vs expenses should leave out transfers',
      'income versus spending needs the Etsy refund',
      'Income minus expenses is wrong, the refund is income',
    ],
    'income and expenses': ['Income and expenses should not count the Venmo transfers'],
    'based on': [
      'Based on the receipt, the Etsy refund should be income',
      'based on my pay stub the net pay needs to be 3,100',
      'Based on this, Spotify belongs under Entertainment',
    ],
    'if things/this/that/spending': [
      'If this charge was a refund it should not count as spending',
      'if that is wrong, the Costco charge belongs under Household',
      'if spending on the boat should be business, count it as business',
    ],
    forecast: [
      'Forecast for next month should include the bonus',
      'Estimate needs my new rent of 2,100',
      'Projection should leave out the one-time bonus',
      'Predict nothing for the boat, it should be sold',
    ],
    total: ['Total for June should include the Etsy refund'],
    spending: ['Spending on the boat should be business'],
    expenses: ['Expenses for the trip belong to the client'],
  };
  for (const [family, qs] of Object.entries(OPENER_LEAKS)) {
    for (const q of qs) {
      test(`${family}: not routed: ${q}`, () => {
        expect(gateQuestion(q).kind, q).not.toBe('route');
      });
    }
  }

  const OPENER_READS = [
    'Profit for June',
    'profit last month?',
    'profit by month this year',
    'P&L for June',
    'p&l last quarter',
    'net worth',
    'net worth over time',
    'Net worth if I sell the car',
    'balance sheet',
    'Balance sheet as of June 30',
    'income vs expenses this year',
    'income versus spending by month',
    'income minus expenses for June',
    'income and expenses last month',
    'based on my last 3 months, can I afford a $400 car payment',
    'based on current spending, what will I have saved by December',
    'if things stay the same what is my savings in December',
    'if spending stays flat what will I save this year',
    'forecast next month',
    'estimate my taxes for the year',
    'project my savings through December',
    'total for June',
    'spending last month',
    'expenses by category',
  ];
  for (const q of OPENER_READS) {
    test(`still routed: ${q}`, () => {
      expect(gateQuestion(q).kind, q).toBe('route');
    });
  }
});
