import { describe, expect, test } from 'bun:test';
import {
  parseCategorizationDecision,
  buildVerdictLine,
  LOCAL_BROWSER_LABEL,
  LOCAL_SERVER_LABEL,
  CLOUD_LIVE_LABEL,
  CLOUD_SIMULATED_LABEL,
  CONTRAST_CAPTION,
} from '../dashboard/ui/src/demo/core.js';
// Server-side constants are imported in the same process so the mirrored
// label strings are pinned against drift.
import {
  LOCAL_BROWSER_LABEL as SERVER_LOCAL_BROWSER_LABEL,
  LOCAL_SERVER_LABEL as SERVER_LOCAL_SERVER_LABEL,
  CLOUD_LIVE_LABEL as SERVER_CLOUD_LIVE_LABEL,
  CLOUD_SIMULATED_LABEL as SERVER_CLOUD_SIMULATED_LABEL,
} from '../demo/showdown.js';

describe('parseCategorizationDecision', () => {
  const clean = '{"transactions":[{"id":2,"category":"Health","confidence":0.95}]}';

  test('parses clean JSON', () => {
    const parsed = parseCategorizationDecision(clean);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.decision).toEqual({ id: 2, category: 'Health', confidence: 0.95 });
  });

  test('parses fenced JSON (```json ... ```)', () => {
    const fenced = '```json\n{"transactions":[{"id":7,"category":"Fees & Interest","confidence":0.9}]}\n```';
    const parsed = parseCategorizationDecision(fenced);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.decision.category).toBe('Fees & Interest');
  });

  test('parses a blob with prefixed junk and trailing junk', () => {
    const messy = 'Sure, here it is: {"transactions":[{"id":1,"category":"Groceries","confidence":0.9}]} hope that helps!';
    const parsed = parseCategorizationDecision(messy);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.decision.id).toBe(1);
      expect(parsed.decision.category).toBe('Groceries');
    }
  });

  test('garbage without a JSON blob fails honestly with the raw text', () => {
    const parsed = parseCategorizationDecision('I cannot categorize that.');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.raw).toBe('I cannot categorize that.');
  });

  test('malformed JSON blobs fail honestly', () => {
    expect(parseCategorizationDecision('{"transactions": [').ok).toBe(false);
    expect(parseCategorizationDecision('{"wrong": "shape"}').ok).toBe(false);
    expect(parseCategorizationDecision('{"transactions":[]}').ok).toBe(false);
  });

  test('clamps confidence into [0, 1] and preserves id', () => {
    const high = parseCategorizationDecision('{"transactions":[{"id":5,"category":"Dining","confidence":1.5}]}');
    expect(high.ok).toBe(true);
    if (high.ok) expect(high.decision.confidence).toBe(1);

    const low = parseCategorizationDecision('{"transactions":[{"id":5,"category":"Dining","confidence":-0.2}]}');
    expect(low.ok).toBe(true);
    if (low.ok) expect(low.decision.confidence).toBe(0);
  });
});

describe('label parity between the server constants and the UI chunk', () => {
  test('the four labels are string-identical on both sides', () => {
    expect(LOCAL_BROWSER_LABEL).toBe(SERVER_LOCAL_BROWSER_LABEL);
    expect(LOCAL_SERVER_LABEL).toBe(SERVER_LOCAL_SERVER_LABEL);
    expect(CLOUD_LIVE_LABEL).toBe(SERVER_CLOUD_LIVE_LABEL);
    expect(CLOUD_SIMULATED_LABEL).toBe(SERVER_CLOUD_SIMULATED_LABEL);
    expect(LOCAL_BROWSER_LABEL).toBe('in your browser, on your GPU');
    expect(LOCAL_SERVER_LABEL).toBe('on this machine');
    expect(CLOUD_LIVE_LABEL).toBe('live call to OpenRouter');
    expect(CLOUD_SIMULATED_LABEL).toBe('simulated round-trip — no network');
  });
});

describe('buildVerdictLine', () => {
  test('local wins in live mode: ms delta and × ratio', () => {
    const line = buildVerdictLine({ decisionMs: 100 }, { mode: 'live', decisionMs: 900 });
    expect(line).toBe('Local won by 800 ms (9.0× faster)');
  });

  test('cloud wins in live mode, stated honestly', () => {
    const line = buildVerdictLine({ decisionMs: 900 }, { mode: 'live', decisionMs: 100 });
    expect(line).toBe('Cloud won by 800 ms (9.0× faster)');
  });

  test('equal times are a dead heat', () => {
    expect(buildVerdictLine({ decisionMs: 250 }, { mode: 'live', decisionMs: 250.2 })).toBe('Dead heat');
  });

  test('simulated mode never presents the number as network latency', () => {
    const line = buildVerdictLine({ decisionMs: 100 }, { mode: 'simulated', decisionMs: 12 });
    expect(line).toContain('Simulated cloud arm');
    expect(line).toContain('no network call was made');
    expect(line).toContain('(local decision: 100 ms)');
    expect(line).not.toContain('won by');
  });

  test('failed arms get their own honest lines', () => {
    expect(buildVerdictLine({ decisionMs: null }, { mode: 'live', decisionMs: 500 })).toBe(
      'Local arm failed — see its card for the error.',
    );
    expect(buildVerdictLine({ decisionMs: 120 }, { mode: 'live', decisionMs: null })).toBe(
      'Cloud arm failed — see its card for the error.',
    );
    expect(buildVerdictLine({ decisionMs: null }, { mode: 'simulated', decisionMs: null })).toBe(
      'Both arms failed — see their cards for the errors.',
    );
  });
});

describe('contrast caption', () => {
  test('names jev-ultrafast, the ~178 ms external benchmark, and the privacy tradeoff', () => {
    expect(CONTRAST_CAPTION).toContain('jev-ultrafast');
    expect(CONTRAST_CAPTION).toContain('~178 ms');
    expect(CONTRAST_CAPTION).toContain('not privacy-preserving');
    expect(CONTRAST_CAPTION).toContain('OpenRouter');
  });
});