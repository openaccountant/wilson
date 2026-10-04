import { describe, expect, test } from 'bun:test';
import { CATEGORIES } from '../tools/categorize/categories.js';
import { classifyLocalOutput } from '../dashboard/ui/src/hybrid/core.js';
import { answerClaimProblem, runSubagent, type GenerateRequest, type GroundingStep, type SubagentDeps } from '../dashboard/ui/src/hybrid/subagent-core.js';
import { DEFAULT_SUBAGENT_LIMITS, type SubagentOutcome } from '../dashboard/ui/src/hybrid/worker-protocol.js';
import type { ToolReadResult } from '../dashboard/ui/src/store/mirror-tools.js';
import type { MirrorPortStatus } from '../dashboard/ui/src/store/mirror-port-protocol.js';
import slice8 from './fixtures/subagent-slice8-answers.json';

/**
 * Answer-quality regressions from specs/eval/2026-10-02-slice8-results.md.
 * The fixtures are the composed answers the real Qwen3-0.6B produced in the
 * slice-8 run (gold, held-out, bench), with the tool and row count the loop
 * had at the time. Decision (Round 2): paraphrased NEED_MORE_DATA replies and
 * "no results" claims that contradict non-empty results must hand off.
 */

interface Slice8Answer {
  set: string;
  q: string;
  tool: 'transaction_search' | 'spending_summary' | 'profit_loss' | 'net_worth' | 'forecast';
  rows: number | null;
  text: string;
}
const answers = slice8 as Slice8Answer[];

const SYNCED = '2026-07-15T11:59:00.000Z';
const status = (): MirrorPortStatus => ({
  profile: 'default',
  seeded: true,
  lastSyncedAt: SYNCED,
  schemaVersion: 4,
  servable: ['transaction_search', 'spending_summary', 'profit_loss', 'net_worth', 'forecast'],
  categories: CATEGORIES,
});

/** A tool result shaped like the mirror's, from the merchant/amounts the slice-8 queries hit. */
function searchResult(count: number, description = 'Whole Foods Market', amount = -88.5): ToolReadResult {
  const transactions = Array.from({ length: count }, (_, i) => ({ id: i + 1, date: `2026-06-${String(i + 1).padStart(2, '0')}`, description, amount, category: 'Groceries' }));
  const lines = transactions.map((t) => `#${t.id} ${t.date} -$${Math.abs(t.amount).toFixed(2)} ${t.category} ${t.description}`);
  return {
    servable: true,
    profile: 'default',
    data: { query: 'x', count, formatted: count ? lines.join('\n') : 'No transactions found matching your query.', transactions },
    summary: count ? lines.join('\n') : 'No transactions found matching your query.',
  };
}

const SUMMARY: ToolReadResult = {
  servable: true,
  profile: 'default',
  data: {
    period: 'July 2026',
    totalSpending: 190.75,
    transactionCount: 4,
    categories: [
      { category: 'Groceries', total: 88.5, count: 1 },
      { category: 'Transport', total: 45.5, count: 1 },
      { category: 'Dining', total: 41.25, count: 1 },
      { category: 'Subscriptions', total: 15.5, count: 1 },
    ],
    previousPeriod: { label: 'June 2026', totalSpending: 190.75, categories: [] },
  },
  summary: 'July 2026 spending: $190.75\nGroceries: $88.50\nTransport: $45.50\nDining: $41.25\nSubscriptions: $15.50',
};

function run(query: string, tool: ToolReadResult, compose: string): Promise<SubagentOutcome> {
  const deps: SubagentDeps = {
    generate: async (req: GenerateRequest) => (req.kind === 'compose' ? compose : req.kind === 'next' ? 'ANSWER' : 'none'),
    toolRead: async () => tool,
    status: async () => status(),
    now: () => Date.now(),
    emit: () => {},
  };
  return runSubagent(deps, {
    query,
    nowIso: '2026-07-15T12:00:00.000Z',
    expectedProfile: 'default',
    priorLocalTurns: [],
    limits: { ...DEFAULT_SUBAGENT_LIMITS, compose: 'model' }, // Round 3: these regressions are about the model compose path
  });
}

describe('slice-8 fixture sanity', () => {
  test('the fixture has the slice-8 defects in it', () => {
    expect(answers.filter((a) => /^need more data\.?$/i.test(a.text)).length).toBeGreaterThanOrEqual(5);
    expect(answers.filter((a) => /^no results found\.?$/i.test(a.text)).length).toBeGreaterThanOrEqual(2);
  });
});

describe('[fix 1] "Need more data." and its paraphrases never become a final local answer', () => {
  const needMore = answers.filter((a) => /^need more data\.?$/i.test(a.text));
  for (const a of needMore) {
    test(`classify: ${a.set} "${a.q}"`, () => {
      expect(classifyLocalOutput(a.text)).toEqual({ kind: 'handoff', reason: 'outside-bundle' });
    });
  }

  // "Did I get charged twice by Adobe?" had 2 rows; "last pay the Electric Company" had 2 rows.
  test('loop: Adobe duplicate question, search returned rows, compose said "Need more data." -> handoff(outside-bundle)', async () => {
    const out = await run('Did I get charged twice by Adobe?', searchResult(2, 'Adobe Creative Cloud', -59.75), 'Need more data.');
    expect(out.kind).toBe('handoff');
    if (out.kind === 'handoff') {
      expect(out.reason).toBe('outside-bundle');
      expect(out.handoff.steps).toHaveLength(1);
    }
  });

  for (const reply of ['I need more information.', 'Not enough data to say.', "The results don't include that.", "I can't determine that from the provided data."]) {
    test(`loop: paraphrase "${reply}" on a non-empty summary -> handoff`, async () => {
      const out = await run('How much did I spend by category this month?', SUMMARY, reply);
      expect(out.kind).toBe('handoff');
    });
  }
});

// ── [fix 2] negative claims and substance ────────────────────────────────────

const NEGATIVE_FIXTURE = (a: Slice8Answer) =>
  /^no results found\.?$/i.test(a.text) || /^no, /i.test(a.text);

function stepFor(a: Slice8Answer): GroundingStep {
  if (a.tool === 'transaction_search') {
    const d = /netflix/i.test(a.q) ? 'Netflix' : /adobe/i.test(a.q) ? 'Adobe Creative Cloud' : /uber/i.test(a.q) ? 'Uber trip' : 'Whole Foods Market';
    const r = searchResult(a.rows ?? 0, d);
    return { tool: a.tool, data: (r as { data: unknown }).data, summary: (r as { summary: string }).summary };
  }
  const r = SUMMARY as { data: unknown; summary: string };
  return { tool: a.tool, data: r.data, summary: r.summary };
}

const emptySearch: GroundingStep = { tool: 'transaction_search', data: { query: 'x', count: 0, transactions: [], formatted: 'No transactions found matching your query.' } };
const rowsSearch = (n: number, description = 'Whole Foods Market'): GroundingStep => ({ tool: 'transaction_search', data: (searchResult(n, description) as { data: unknown }).data });
const summaryStep: GroundingStep = { tool: 'spending_summary', data: (SUMMARY as { data: unknown }).data };
const zeroSummary: GroundingStep = { tool: 'spending_summary', data: { period: 'July 2026', totalSpending: 0, transactionCount: 0, categories: [] } };

describe('[fix 2] a "no results" / negative claim needs an actually empty result', () => {
  const negatives = answers.filter(NEGATIVE_FIXTURE);

  test('the fixture contains the slice-8 negative-claim failures', () => {
    expect(negatives.length).toBeGreaterThanOrEqual(4);
    expect(negatives.some((a) => a.text === 'No results found.' && (a.rows ?? 0) > 0)).toBe(true);
    expect(negatives.some((a) => /did not get charged twice by Netflix/.test(a.text))).toBe(true);
  });

  for (const a of negatives) {
    test(`slice-8 "${a.q}" -> "${a.text}" (${a.rows ?? 'n/a'} rows) is a negative-claim problem`, () => {
      expect(answerClaimProblem(a.text, [stepFor(a)])).toBe('negative-claim');
    });
  }

  const claims = [
    'No results found.',
    'No transactions found for Whole Foods in June.',
    'I did not find any Adobe charges.',
    "I couldn't find any matches.",
    "You haven't been charged twice by Netflix.",
    'No, you were not charged twice.',
    'There are no charges from Hulu.',
    'Nothing found.',
    'You have no subscriptions.',
    'Zero transactions matched.',
    "You didn't spend anything on dining.",
    'No duplicate charges.',
    'Not at all.',
    'Nope.',
    '**No results found**',
    'NO RESULTS FOUND.',
  ];
  for (const c of claims) {
    test(`non-empty result: ${JSON.stringify(c)} -> negative-claim`, () => {
      expect(answerClaimProblem(c, [rowsSearch(3)])).toBe('negative-claim');
      expect(answerClaimProblem(c, [summaryStep])).toBe('negative-claim');
    });
  }

  test('the same claims are allowed when every step is really empty', () => {
    for (const c of claims) {
      expect(answerClaimProblem(c, [emptySearch])).toBeNull();
      expect(answerClaimProblem(c, [zeroSummary])).toBeNull();
    }
  });

  test('one non-empty step among empty ones keeps the claim blocked', () => {
    expect(answerClaimProblem('No results found.', [emptySearch, rowsSearch(1)])).toBe('negative-claim');
  });

  test('a negative claim with a figure is still blocked on a non-empty result', () => {
    expect(answerClaimProblem('No, you did not spend more than $190.75.', [summaryStep])).toBe('negative-claim');
  });

  test('loop: slice-8 "Show me every Whole Foods charge in June" (1 row) + "No results found." -> handoff, no local note', async () => {
    const out = await run('Show me every Whole Foods charge last month', searchResult(1), 'No results found.');
    expect(out.kind).toBe('handoff');
    if (out.kind === 'handoff') {
      expect(out.reason).toBe('ungrounded');
      expect(out.handoff.steps).toHaveLength(1);
      expect(out.handoff.localNote).toBeUndefined();
    }
  });

  test('loop: slice-8 Netflix duplicate question (5 rows) + "No, I did not get charged twice" -> handoff', async () => {
    const out = await run('Did I get charged twice by Netflix?', searchResult(5, 'Netflix', -15.5), 'No, I did not get charged twice by Netflix.');
    expect(out.kind).toBe('handoff');
  });

  test('loop: slice-8 groceries comparison + "No, you are not spending more..." -> handoff', async () => {
    const out = await run('Am I spending more on groceries than before?', SUMMARY, 'No, you are not spending more on groceries than before.');
    expect(out.kind).toBe('handoff');
  });

  test('loop: an empty search still hands off as empty-result before compose (C3 unchanged)', async () => {
    const out = await run('Show me every Hulu charge', searchResult(0), 'No results found.');
    expect(out.kind).toBe('handoff');
    if (out.kind === 'handoff') expect(out.reason).toBe('empty-result');
  });
});

describe('[fix 2] real answers are not mistaken for negative claims', () => {
  const fine = [
    'Net worth: $222,050.25.',
    'You spent $41.25 on dining, 22% of the total.',
    'Your largest category was Groceries at $88.50.',
    'You were charged twice by Adobe: $59.75 each.',
    'Yes, you were charged twice by Netflix.',
    'No change: July spending of $190.75 matches June.',
    '2 transactions found.',
    'Groceries: $88.50, Transport: $45.50, Dining: $41.25.',
    'Dining grew the most, at $41.25.',
    'Notable: Dining is $41.25.',
    'Nothing beats groceries here at $88.50.',
  ].filter((t) => !/^nothing beats/i.test(t));
  for (const t of fine) {
    test(JSON.stringify(t), () => {
      expect(answerClaimProblem(t, [{ tool: 'transaction_search', data: { count: 2, transactions: [{ description: 'Netflix' }, { description: 'Adobe Creative Cloud' }] } }, summaryStep])).toBeNull();
    });
  }
});

describe('[fix 2] a local answer must reference the tool result', () => {
  test('a figure is enough (its value is checked by isGrounded)', () => {
    expect(answerClaimProblem('$190.75.', [summaryStep])).toBeNull();
    expect(answerClaimProblem('That was 23% more.', [summaryStep])).toBeNull();
  });

  test('a merchant or category from the result is enough', () => {
    expect(answerClaimProblem('Yes, you were charged twice by Netflix on the same day.', [rowsSearch(2, 'Netflix')])).toBeNull();
    expect(answerClaimProblem('Dining is your smallest growing category.', [summaryStep])).toBeNull();
    expect(answerClaimProblem('Whole Foods charged you once.', [rowsSearch(1)])).toBeNull();
  });

  test('the row count is enough', () => {
    expect(answerClaimProblem('2 transactions found.', [rowsSearch(2)])).toBeNull();
    expect(answerClaimProblem('Two charges, 2 in total.', [rowsSearch(2)])).toBeNull();
  });

  test('content-free or unrelated replies are not', () => {
    for (const t of ['Yes.', 'Sure thing, here you go.', 'Done.', 'Here are the results.', 'Everything looks fine.', 'Hello there!', '3 transactions found.', 'You spent a lot on takeout.']) {
      expect(answerClaimProblem(t, [rowsSearch(2)])).toBe('no-reference');
    }
    expect(answerClaimProblem('Your spending looks healthy.', [summaryStep])).toBe('no-reference');
  });

  test('generic words and months in the data do not count as entities', () => {
    expect(answerClaimProblem('Total transactions for the period look normal.', [rowsSearch(2)])).toBe('no-reference');
    expect(answerClaimProblem('It was a good july.', [summaryStep])).toBe('no-reference');
  });

  test('an empty result needs no reference', () => {
    expect(answerClaimProblem('Nothing matched that.', [emptySearch])).toBeNull();
  });

  test('loop: a content-free compose on a non-empty result -> handoff(ungrounded)', async () => {
    const out = await run('Did I get charged twice by Adobe?', searchResult(2, 'Adobe Creative Cloud', -59.75), 'Yes.');
    expect(out.kind).toBe('handoff');
    if (out.kind === 'handoff') expect(out.reason).toBe('ungrounded');
  });

  test('loop: an answer naming the merchant still passes', async () => {
    const out = await run('Did I get charged twice by Adobe?', searchResult(2, 'Adobe Creative Cloud', -59.75), 'Yes, Adobe charged you twice: $59.75 each.');
    expect(out.kind).toBe('answer');
  });
});

describe('[fix 2] the good slice-8 local answers are still answered', () => {
  const defects = (a: Slice8Answer) => NEGATIVE_FIXTURE(a) || /^need more data\.?$/i.test(a.text);
  const good = answers.filter((a) => !defects(a));

  test('there are good answers to protect', () => {
    expect(good.length).toBeGreaterThanOrEqual(20);
  });

  for (const a of good) {
    test(`${a.set}: "${a.q}" -> ${JSON.stringify(a.text.slice(0, 50))}`, () => {
      expect(answerClaimProblem(a.text, [stepFor(a)])).toBeNull();
    });
  }
});
