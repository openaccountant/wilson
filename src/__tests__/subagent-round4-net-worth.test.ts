import { describe, expect, test } from 'bun:test';
import { CATEGORIES } from '../tools/categorize/categories.js';
import { fillArgs } from '../dashboard/ui/src/hybrid/subagent-args.js';
import { renderTemplate } from '../dashboard/ui/src/hybrid/subagent-templates.js';
import { ok, rig } from './subagent-round3-rig.js';

/** Round 4 (specs/DECISIONS.md "Round 4", "Bugs to fix"). */

const NOW = new Date('2026-07-15T12:00:00');
const NET_WORTH = ok({
  netWorth: 52000,
  totalAssets: 60000,
  totalLiabilities: 8000,
  assets: [{ subtype: 'Checking', total: 60000, count: 1 }],
  liabilities: [{ subtype: 'Credit Card', total: -8000, count: 1 }],
});

describe('(2) net_worth never states a date the data does not hold', () => {
  test('the template has no "as of" when the result carries no snapshot date', () => {
    const t = renderTemplate('net_worth', NET_WORTH.servable ? NET_WORTH.data : null, { today: '2026-07-15' })!;
    expect(t).toContain('Net worth: $52,000.00 (assets $60,000.00, liabilities $8,000.00).');
    expect(t).not.toMatch(/as of|2026-07-15|today/i);
  });
  test('it does state the date when the result carries one', () => {
    const t = renderTemplate('net_worth', { netWorth: 100, asOf: '2026-06-30', assets: [], liabilities: [] }, { today: '2026-07-15' })!;
    expect(t).toContain('Net worth as of 2026-06-30: $100.00.');
    expect(t).not.toContain('2026-07-15');
  });
  test('end to end: a plain net worth question is answered without a date', async () => {
    const out = await rig(NET_WORTH).run('what is my net worth');
    expect(out.kind).toBe('answer');
    if (out.kind === 'answer') expect(out.text).not.toMatch(/as of|2026-07-15/);
  });

  const TIME_QUALIFIED = [
    'net worth last month',
    'what was my net worth last month',
    'net worth 3 months ago',
    'what was my net worth three months ago',
    'net worth a year ago',
    'net worth two weeks ago',
    'what was my net worth in June',
    'net worth on 2026-06-30',
    'what was my net worth at the end of last year',
    'net worth at the start of the year',
    'net worth last quarter',
    'net worth last week',
    'net worth yesterday',
    'net worth this year',
    'net worth ytd',
    'net worth as of last friday',
    'balance sheet last month',
    'balance sheet as of june 30',
  ];
  for (const q of TIME_QUALIFIED) {
    test(`hands off: ${q}`, async () => {
      expect(fillArgs('net_worth', q, NOW, CATEGORIES).ok, q).toBe(false);
      const r = rig(NET_WORTH);
      const out = await r.run(q);
      expect(out.kind, q).toBe('handoff');
      expect(r.reads, q).toEqual([]);
    });
  }

  for (const q of ['What is my net worth?', 'net worth right now', "what's my net worth today", 'what is my net worth as of today', 'what is my current net worth', 'Give me my balance sheet with assets and liabilities']) {
    test(`still answered locally: ${q}`, async () => {
      expect(fillArgs('net_worth', q, NOW, CATEGORIES).ok, q).toBe(true);
      const out = await rig(NET_WORTH).run(q);
      expect(out.kind, q).toBe('answer');
    });
  }
});

