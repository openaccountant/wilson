import { describe, expect, test } from 'bun:test';
import { detectComparisonIntent } from '../dashboard/ui/src/hybrid/subagent-intent.js';
import { PNL, rig } from './subagent-round3-rig.js';

/**
 * Round 3 (specs/DECISIONS.md "Empty results"): what-if and comparison phrasing the single-call
 * templates cannot express hands off before any tool read.
 */

describe('what-if / comparison / trend phrasing hands off before any tool read', () => {
  const QUESTIONS = [
    'spending vs last month',
    'Are we spending more than last month?',
    "how's my spending trending vs last month",
    'forecast without golf dues',
    'What would my savings be if I cancel Netflix?',
    'P&L for the last 3 months',
  ];
  for (const q of QUESTIONS) {
    test(`${q}`, async () => {
      expect(detectComparisonIntent(q), 'fixture must trip the detector').not.toBeNull();
      const r = rig(PNL);
      const out = await r.run(q);
      expect(out.kind).toBe('handoff');
      if (out.kind !== 'handoff') return;
      expect(out.reason).toBe('router-none');
      expect(out.handoff.steps).toEqual([]);
      expect(r.reads).toEqual([]);
      expect(r.gens).toEqual([]);
    });
  }

  test('also in model mode', async () => {
    const r = rig(PNL);
    const out = await r.run('spending vs last month', { compose: 'model' });
    expect(out.kind === 'handoff' && out.reason).toBe('router-none');
    expect(r.reads).toEqual([]);
  });

  test('an unseeded mirror still falls back to bundle mode (the detector does not pre-empt precheck)', async () => {
    const r = rig(PNL, { unseeded: true });
    const out = await r.run('spending vs last month');
    expect(out.kind).toBe('bundle-fallback');
  });
});
