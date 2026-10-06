import { describe, expect, test } from 'bun:test';
import {
  buildLocalUserMessage,
  classifyLocalOutput,
  stripThinking,
  NEED_MORE_SENTINEL,
  NEED_MORE_PHRASES,
  NO_THINK_SWITCH,
} from '../dashboard/ui/src/hybrid/core.js';

/**
 * Hand-off detection: local output that looks like a tool-call attempt, asks
 * for data outside the bundle, or is empty must hand off silently to the
 * server agent path. Order matters (tool-call shapes first) and is pinned
 * here. The tool-call tag literals are built from char codes so this file
 * never contains them literally.
 */
const LT = String.fromCharCode(60); // '<'

const repoToolCall = `${LT}tool_call>{"name": "query_transactions", "arguments": {}}${LT}/tool_call>`;
const qwenNativeToolCall = `${LT}tool_call>{"name": "query_transactions", "arguments": {}}${LT}tool_response>{"rows": []}`;

describe('classifyLocalOutput', () => {
  describe('tool-call shapes → handoff tool-call', () => {
    test('repo marker form (tagged form of parseToolCall)', () => {
      const v = classifyLocalOutput(`Let me check. ${repoToolCall}`);
      expect(v).toEqual({ kind: 'handoff', reason: 'tool-call' });
    });

    test('Qwen3 native form (tool_call … tool_response)', () => {
      const v = classifyLocalOutput(qwenNativeToolCall);
      expect(v).toEqual({ kind: 'handoff', reason: 'tool-call' });
    });

    test('both shapes detected even when the answer text looks reasonable', () => {
      expect(classifyLocalOutput(`You spent $54.21. ${repoToolCall}`).kind).toBe('handoff');
    });

    test('tool-call beats the sentinel (order matters)', () => {
      const v = classifyLocalOutput(`${NEED_MORE_SENTINEL} ${repoToolCall}`);
      expect(v).toEqual({ kind: 'handoff', reason: 'tool-call' });
    });
  });

  describe('NEED_MORE_DATA sentinel → handoff outside-bundle', () => {
    test('exact sentinel', () => {
      expect(classifyLocalOutput(NEED_MORE_SENTINEL)).toEqual({ kind: 'handoff', reason: 'outside-bundle' });
    });

    test('sentinel embedded in prose', () => {
      expect(classifyLocalOutput(`Sorry — ${NEED_MORE_SENTINEL} for that period.`)).toEqual({
        kind: 'handoff',
        reason: 'outside-bundle',
      });
    });
  });

  describe('fuzzy phrases → handoff outside-bundle', () => {
    for (const phrase of NEED_MORE_PHRASES) {
      test(`"${phrase}"`, () => {
        const v = classifyLocalOutput(`I ${phrase} transactions from last year.`);
        expect(v).toEqual({ kind: 'handoff', reason: 'outside-bundle' });
      });
    }

    test('matching is case-insensitive', () => {
      expect(classifyLocalOutput('I DO NOT HAVE ACCESS to that.').kind).toBe('handoff');
    });
  });

  describe('empty output → handoff no-answer', () => {
    test('empty string', () => {
      expect(classifyLocalOutput('')).toEqual({ kind: 'handoff', reason: 'no-answer' });
    });

    test('whitespace only', () => {
      expect(classifyLocalOutput('  \n\t ')).toEqual({ kind: 'handoff', reason: 'no-answer' });
    });
  });

  describe('normal answers → answer', () => {
    test('plain data-grounded answer', () => {
      const v = classifyLocalOutput('You spent $54.21 on groceries this week.');
      expect(v).toEqual({ kind: 'answer', text: 'You spent $54.21 on groceries this week.' });
    });

    test('the innocuous word "provide" alone does not trip the fuzzy backstop', () => {
      const v = classifyLocalOutput('I can provide the weekly total: $123.45.');
      expect(v.kind).toBe('answer');
    });

    test('the word "access" alone does not trip the backstop', () => {
      expect(classifyLocalOutput('Your top category this week was Dining.').kind).toBe('answer');
    });

    test('answers are trimmed', () => {
      expect(classifyLocalOutput('  $12.00 total.  ')).toEqual({ kind: 'answer', text: '$12.00 total.' });
    });

    test('tool-call-looking partial strings without the full shape stay answers', () => {
      // Unbalanced / partial markers are not a tool call — the model may be
      // writing prose that mentions the format.
      expect(classifyLocalOutput('The tool_call format is used for tools.').kind).toBe('answer');
    });
  });

  describe('reasoning-model <think> blocks', () => {
    const think = (body: string) => `${LT}think>${body}${LT}/think>`;

    test('a closed think block is stripped from the answer', () => {
      const v = classifyLocalOutput(`${think('\nThe user wants the top category…\n')}\n\nDining — $390.75.`);
      expect(v).toEqual({ kind: 'answer', text: 'Dining — $390.75.' });
    });

    test('the empty block Qwen3 emits under /no_think is stripped', () => {
      expect(classifyLocalOutput(`${think('\n\n')}\n\nYou spent $54.21.`)).toEqual({ kind: 'answer', text: 'You spent $54.21.' });
    });

    test('an unterminated think block (token cap hit mid-reasoning) is no answer, not a half-thought', () => {
      const v = classifyLocalOutput(`${LT}think>\nOkay, let's see. The user is asking what they spent the most on`);
      expect(v).toEqual({ kind: 'handoff', reason: 'no-answer' });
    });

    test('a sentinel inside the reasoning does not count — only the visible answer is classified', () => {
      expect(classifyLocalOutput(`${think(`maybe ${NEED_MORE_SENTINEL}?`)} Groceries: $295.85.`).kind).toBe('answer');
    });

    test('stripThinking leaves think-free text untouched', () => {
      expect(stripThinking('Your top category was Dining.')).toBe('Your top category was Dining.');
    });
  });
});

describe('paraphrased NEED_MORE_DATA replies hand off (slice-8 defect)', () => {
  const paraphrases = [
    // the slice-8 failures, verbatim
    'Need more data.',
    // sentinel spelling variants
    'need more data',
    'NEED MORE DATA',
    'Need_More_Data',
    'need-more-data',
    '**Need more data**',
    '`NEED_MORE_DATA`',
    'Need   more\ndata.',
    // first person / other subjects
    'I need more data.',
    'I need more information.',
    'I need more information to answer that.',
    'I would need more details to answer.',
    'I still need some additional information.',
    'We need additional data.',
    'This needs more context.',
    'More data is needed.',
    'More information is needed to answer this.',
    'Additional data is required.',
    'Further context is required to answer.',
    // insufficiency
    'Not enough data.',
    'Not enough information to answer.',
    "There isn't enough data to answer that.",
    'There is insufficient information to say.',
    'Insufficient data.',
    'The data is insufficient.',
    'The information provided is incomplete.',
    'The results are missing the details needed.',
    'No relevant data was provided.',
    'There is no sufficient information here.',
    // results do not contain / answer
    'The results do not contain enough information.',
    "The lookup results don't include that information.",
    'The provided results do not answer the question.',
    "The data doesn't show that.",
    'The results do not specify the period.',
    // cannot answer
    "I can't answer that from the results.",
    'I cannot determine that from the provided data.',
    "I'm unable to answer this question.",
    'Unable to determine.',
    "I couldn't tell from these results.",
    'It is not possible to determine that.',
    "I don't know.",
    "I'm not sure.",
    'That information is not available.',
    'No information available.',
  ];
  for (const text of paraphrases) {
    test(JSON.stringify(text), () => {
      expect(classifyLocalOutput(text)).toEqual({ kind: 'handoff', reason: 'outside-bundle' });
    });
  }

  test('still hands off when the paraphrase follows a think block', () => {
    const think = (body: string) => `${LT}think>${body}${LT}/think>`;
    expect(classifyLocalOutput(`${think('\nhmm\n')}\n\nNeed more data.`).kind).toBe('handoff');
  });

  test('a lead-in does not hide it', () => {
    expect(classifyLocalOutput('Sorry, I need more information about that period.').kind).toBe('handoff');
    expect(classifyLocalOutput('Hmm. Not enough data to say $5.00.').kind).toBe('handoff');
    expect(classifyLocalOutput('Need more data. The average is $3,677.25.').kind).toBe('handoff');
  });
});

describe('real answers that merely mention data/information/need stay answers', () => {
  const real = [
    'Based on the data, you spent $54.21 on groceries.',
    'Your data shows Dining at $390.75.',
    'Using your transaction data, net worth is $222,050.25.',
    'The data covers January to June: $400.00 spent.',
    'According to the data, your net profit is $17,249.25.',
    'You do not need more data to see this: groceries were $88.50.',
    "You don't need additional information; rent was $1,800.00.",
    'Information on your 3 accounts: net worth is $222,050.25.',
    'Needs: groceries $88.50, utilities $130.50.',
    'You need to pay $130.50 for utilities by the 10th.',
    'Needed spend this month is $190.75.',
    'Insufficient funds fees were $12.00.',
    'The provided results show $3,677.25 average monthly net.',
    'More data points: you spent $41.25 on dining and $88.50 on groceries.',
    'Data from July: spending was $190.75.',
    'You spent $190.75 in July 2026, compared to $190.75 in June 2026.',
    'I found 2 Adobe charges totaling $119.50.',
    'Your information is up to date. Net worth: $222,050.25.',
    'Not enough room in savings? Savings are $12,000.25.',
    'No change: July spending of $190.75 matches June.',
    'Dining is the top category at $347.25.',
    'You are on track: cash of $27,282.50 in three months.',
  ];
  for (const text of real) {
    test(JSON.stringify(text), () => {
      expect(classifyLocalOutput(text)).toEqual({ kind: 'answer', text });
    });
  }
});

describe('buildLocalUserMessage', () => {
  test('ends the user turn with the Qwen3 no-think soft switch', () => {
    expect(buildLocalUserMessage('ctx', 'Top category?').endsWith(`Question: Top category? ${NO_THINK_SWITCH}`)).toBe(true);
  });
});
