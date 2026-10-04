import { describe, expect, test } from 'bun:test';
// @ts-expect-error plain mjs
import { checkChangeCard, humanScript } from '../../demos/rig/beats/b5-propose.mjs';

const card = (text: string, cat = ['Category', 'Uncategorized', 'Shopping'], extra: string[][] = []) => ({
  innerText: async () => text,
  locator: () => ({ evaluateAll: async () => [[], cat, ...extra] }),
});
const text = (desc: string, tx: string, cat = 'Shopping') =>
  `Confirm: Categorize Transaction × Requested by: x #${tx} ${desc} -$240.00 Category Uncategorized ${cat}`;

describe('b5 human identity check', () => {
  test('exports', () => expect(typeof humanScript).toBe('function'));
  // TARGET is set by humanScript/preState; set via a throwaway call path: checkChangeCard reads module TARGET, so prime it.
  test('target id must match, text alone is not enough', async () => {
    // prime TARGET by calling humanScript with a stub that fails right after TARGET assignment
    await humanScript({}, { h: {}, log() {}, opts: {} }).catch(() => {});
    const ok = await checkChangeCard(card(text('SQ *KILN & CO STUDIO', '279')), '279');
    expect(ok.problems).toEqual([]);
    const forged = await checkChangeCard(card(text('AMZN SQ *KILN & CO STUDIO', '298', 'SQ *KILN & CO STUDIO')), '279');
    expect(forged.problems.join(' ')).toContain('not the target row #279');
    const none = await checkChangeCard(card(text('SQ *KILN & CO STUDIO', '279')), null);
    expect(none.problems.length).toBeGreaterThan(0);
  });
  test('a card that changes anything besides the category is rejected (e.g. an entity reassignment)', async () => {
    await humanScript({}, { h: {}, log() {}, opts: {} }).catch(() => {});
    const r = await checkChangeCard(card(text('SQ *KILN & CO STUDIO', '279'), undefined, [['entity_id', '—', '3']]), '279');
    expect(r.problems.join(' ')).toContain('changes more than the category');
  });
});
