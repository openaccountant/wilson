import { describe, expect, test } from 'bun:test';
import {
  HYBRID_PROTOCOL_VERSION,
  checkWorkerOrigin,
  createPendingTable,
  isMainToWorker,
  isWorkerToMain,
  shouldAbort,
  shouldStart,
  workerErrorToCause,
  clampSubagentLimits,
  DEFAULT_SUBAGENT_LIMITS,
  SUBAGENT_MAX_STEPS_HARD,
  type WorkerError,
} from '../dashboard/ui/src/hybrid/worker-protocol.js';
import { classifyLoadFailure, describeLoadFailure } from '../dashboard/ui/src/hybrid/capability.js';

/**
 * Model-worker protocol (browser-subagent spec section 4.1, slice 1). Pure:
 * no Worker, no DOM, no transformers.js. The worker itself and the client
 * proxy are exercised in live Chrome; everything decidable without a browser
 * is pinned here.
 */

const MODEL = { repo: 'onnx-community/Qwen3-0.6B-ONNX', displayName: 'Qwen3 0.6B', catalogDtype: 'q4f16' };

describe('isMainToWorker', () => {
  test('accepts every well-formed request', () => {
    expect(isMainToWorker({ t: 'init', v: HYBRID_PROTOCOL_VERSION, origin: 'http://127.0.0.1:3000', model: MODEL })).toBe(true);
    expect(isMainToWorker({ t: 'init', v: 1, origin: 'http://x', model: { ...MODEL, catalogDtype: null } })).toBe(true);
    expect(isMainToWorker({ t: 'probe', id: 1 })).toBe(true);
    expect(isMainToWorker({ t: 'load', id: 2 })).toBe(true);
    expect(
      isMainToWorker({ t: 'bundleAnswer', id: 3, runId: 1, query: 'q', bundleText: 'b', today: '2026-10-02' }),
    ).toBe(true);
    expect(isMainToWorker({ t: 'categorize', id: 4, opts: { systemPrompt: 's', userPrompt: 'u' } })).toBe(true);
    expect(isMainToWorker({ t: 'cancel', runId: 5 })).toBe(true);
  });

  test('rejects wrong versions, unknown tags and malformed fields', () => {
    expect(isMainToWorker({ t: 'init', v: 2, origin: 'http://x', model: MODEL })).toBe(false);
    expect(isMainToWorker({ t: 'init', v: 1, origin: 5, model: MODEL })).toBe(false);
    expect(isMainToWorker({ t: 'init', v: 1, origin: 'http://x', model: { repo: '' } })).toBe(false);
    expect(isMainToWorker({ t: 'init', v: 1, origin: 'http://x', model: { ...MODEL, catalogDtype: 7 } })).toBe(false);
    expect(isMainToWorker({ t: 'probe' })).toBe(false);
    expect(isMainToWorker({ t: 'load', id: '2' })).toBe(false);
    expect(isMainToWorker({ t: 'bundleAnswer', id: 3, runId: 1, query: 'q' })).toBe(false);
    expect(isMainToWorker({ t: 'categorize', id: 4, opts: { systemPrompt: 's' } })).toBe(false);
    expect(isMainToWorker({ t: 'cancel' })).toBe(false);
    expect(isMainToWorker({ t: 'nope', id: 1 })).toBe(false);
    expect(isMainToWorker(null)).toBe(false);
    expect(isMainToWorker('init')).toBe(false);
    expect(isMainToWorker(undefined)).toBe(false);
  });
});

describe('isWorkerToMain', () => {
  test('accepts progress, ok results and error results', () => {
    expect(isWorkerToMain({ t: 'progress', label: 'Downloading local model… 5%' })).toBe(true);
    expect(isWorkerToMain({ t: 'progress', id: 4, label: 'x' })).toBe(true);
    expect(isWorkerToMain({ t: 'result', id: 1, ok: true, result: 'ready' })).toBe(true);
    expect(isWorkerToMain({ t: 'result', id: 1, ok: true, result: null })).toBe(true);
    expect(
      isWorkerToMain({ t: 'result', id: 2, ok: false, error: { phase: 'load', message: 'boom' } }),
    ).toBe(true);
    expect(
      isWorkerToMain({
        t: 'result',
        id: 2,
        ok: false,
        error: { phase: 'resolve', code: 'requires-shader-f16', message: 'x', dtype: 'q4f16' },
      }),
    ).toBe(true);
  });

  test('rejects malformed replies', () => {
    expect(isWorkerToMain({ t: 'progress' })).toBe(false);
    expect(isWorkerToMain({ t: 'result', ok: true, result: 1 })).toBe(false);
    expect(isWorkerToMain({ t: 'result', id: 1, ok: false })).toBe(false);
    expect(isWorkerToMain({ t: 'result', id: 1, ok: false, error: { phase: 'bogus', message: 'x' } })).toBe(false);
    expect(isWorkerToMain({ t: 'result', id: 1, ok: false, error: { phase: 'load' } })).toBe(false);
    expect(isWorkerToMain({ t: 'ready' })).toBe(false);
    expect(isWorkerToMain(null)).toBe(false);
  });
});

describe('runId supersession', () => {
  test('shouldStart only for a strictly newer run', () => {
    expect(shouldStart(1, 0)).toBe(true);
    expect(shouldStart(5, 4)).toBe(true);
    expect(shouldStart(4, 4)).toBe(false); // duplicate post
    expect(shouldStart(3, 4)).toBe(false); // late, out-of-order post
  });

  test('shouldAbort once another run owns the slot', () => {
    expect(shouldAbort(4, 4)).toBe(false);
    expect(shouldAbort(4, 5)).toBe(true);
    // a cancel bumps active past the cancelled id (activeRunId = runId + 1)
    expect(shouldAbort(4, 4 + 1)).toBe(true);
  });
});

describe('WorkerError -> classifyLoadFailure mapping', () => {
  const REPO = MODEL.repo;
  const err = (e: WorkerError) => workerErrorToCause(e);

  test('resolve phase: dtype capability codes stick, repo-not-found and bare failures retry', () => {
    for (const code of ['requires-shader-f16', 'no-usable-dtype', 'no-onnx-weights']) {
      expect(classifyLoadFailure(err({ phase: 'resolve', code, message: 'x' }), 'resolve')).toBe('capability');
    }
    expect(classifyLoadFailure(err({ phase: 'resolve', code: 'repo-not-found', message: 'x' }), 'resolve')).toBe(
      'transient',
    );
    expect(classifyLoadFailure(err({ phase: 'resolve', message: 'Hub is down' }), 'resolve')).toBe('transient');
  });

  test('load phase: network, 404 and damaged cache retry; session-creation failures stick', () => {
    expect(classifyLoadFailure(err({ phase: 'load', message: 'Failed to fetch' }), 'load')).toBe('transient');
    expect(classifyLoadFailure(err({ phase: 'load', message: 'HTTP status 503' }), 'load')).toBe('transient');
    expect(
      classifyLoadFailure(err({ phase: 'load', message: 'Deserialize tensor w failed … can not be read in full.' }), 'load'),
    ).toBe('transient');
    expect(
      classifyLoadFailure(err({ phase: 'load', message: 'no available backend found. ERR: [webgpu]' }), 'load'),
    ).toBe('capability');
  });

  test('warmup phase is always a capability failure', () => {
    expect(classifyLoadFailure(err({ phase: 'warmup', message: 'Failed to fetch' }), 'warmup')).toBe('capability');
    expect(classifyLoadFailure(err({ phase: 'warmup', message: 'GPU device lost' }), 'warmup')).toBe('capability');
  });

  test('the rebuilt cause keeps the human-readable description of the original', () => {
    expect(describeLoadFailure(err({ phase: 'resolve', code: 'requires-shader-f16', message: 'needs shader-f16' }), REPO, null)).toBe(
      'needs shader-f16',
    );
    expect(describeLoadFailure(err({ phase: 'load', message: 'boom\nstack' }), REPO, 'q4f16')).toBe(
      `failed to load ${REPO} (q4f16): boom`,
    );
    expect(
      describeLoadFailure(err({ phase: 'load', message: 'Deserialize tensor w failed … can not be read in full.' }), REPO, 'q4f16'),
    ).toContain('incomplete or corrupt');
  });
});

describe('pending-call table (crash rejects everything in flight)', () => {
  test('ids are unique and a result settles exactly its own call', async () => {
    const table = createPendingTable<unknown>();
    const a = table.add();
    const b = table.add();
    expect(a.id).not.toBe(b.id);
    expect(table.size).toBe(2);

    expect(table.settle(b.id, { ok: true, value: 'B' })).toBe(true);
    expect(await b.promise).toBe('B');
    expect(table.size).toBe(1);

    // a duplicate or unknown settle is ignored
    expect(table.settle(b.id, { ok: true, value: 'again' })).toBe(false);
    expect(table.settle(999, { ok: true, value: 'x' })).toBe(false);

    expect(table.settle(a.id, { ok: false, error: { phase: 'load', message: 'nope' } })).toBe(true);
    await expect(a.promise).rejects.toMatchObject({ phase: 'load', message: 'nope' });
    expect(table.size).toBe(0);
  });

  test('rejectAll fails every pending call and empties the table', async () => {
    const table = createPendingTable<unknown>();
    const calls = [table.add(), table.add(), table.add()];
    const settled = calls.map((c) => c.promise.then(() => 'resolved', (e) => (e as WorkerError).message));
    table.rejectAll({ phase: 'protocol', message: 'model worker crashed' });
    expect(await Promise.all(settled)).toEqual(['model worker crashed', 'model worker crashed', 'model worker crashed']);
    expect(table.size).toBe(0);
    // a late reply from the dead worker is ignored
    expect(table.settle(calls[0].id, { ok: true, value: 'late' })).toBe(false);
  });

  test('ids keep increasing across a crash so a respawned worker never reuses one', () => {
    const table = createPendingTable<unknown>();
    const first = table.add();
    first.promise.catch(() => {});
    table.rejectAll({ phase: 'protocol', message: 'crash' });
    const second = table.add();
    expect(second.id).toBeGreaterThan(first.id);
  });
});

describe('checkWorkerOrigin (opaque-origin workers never run)', () => {
  test('a worker on the page origin may proceed', () => {
    expect(checkWorkerOrigin('http://127.0.0.1:3000', 'http://127.0.0.1:3000')).toEqual({ ok: true });
  });

  test('a data: URL worker (origin "null") is refused', () => {
    const r = checkWorkerOrigin('null', 'http://127.0.0.1:3000');
    expect(r.ok).toBe(false);
  });

  test('any other mismatch, or a missing origin, is refused', () => {
    expect(checkWorkerOrigin('http://evil.test', 'http://127.0.0.1:3000').ok).toBe(false);
    expect(checkWorkerOrigin(undefined, 'http://127.0.0.1:3000').ok).toBe(false);
    expect(checkWorkerOrigin('http://127.0.0.1:3000', 'null').ok).toBe(false);
    expect(checkWorkerOrigin('', '').ok).toBe(false);
  });
});


describe('subagentRun protocol (spec section 4.1)', () => {
  const run = {
    t: 'subagentRun',
    id: 7,
    runId: 3,
    query: 'Did I get charged twice by Adobe?',
    nowIso: '2026-10-03T12:00:00.000Z',
    expectedProfile: 'default',
    priorLocalTurns: [{ q: 'a', a: 'b' }],
    limits: DEFAULT_SUBAGENT_LIMITS,
    port: {},
  };

  test('isMainToWorker accepts a well-formed subagentRun and rejects malformed ones', () => {
    expect(isMainToWorker(run)).toBe(true);
    expect(isMainToWorker({ ...run, priorLocalTurns: [] })).toBe(true);
    expect(isMainToWorker({ ...run, id: 'x' })).toBe(false);
    expect(isMainToWorker({ ...run, runId: undefined })).toBe(false);
    expect(isMainToWorker({ ...run, query: 5 })).toBe(false);
    expect(isMainToWorker({ ...run, nowIso: 5 })).toBe(false);
    expect(isMainToWorker({ ...run, expectedProfile: null })).toBe(false);
    expect(isMainToWorker({ ...run, priorLocalTurns: [{ q: 1, a: 'b' }] })).toBe(false);
    expect(isMainToWorker({ ...run, priorLocalTurns: 'no' })).toBe(false);
    expect(isMainToWorker({ ...run, limits: { ...DEFAULT_SUBAGENT_LIMITS, maxSteps: 'many' } })).toBe(false);
    expect(isMainToWorker({ ...run, limits: null })).toBe(false);
    expect(isMainToWorker({ ...run, port: undefined })).toBe(false);
    expect(isMainToWorker({ ...run, port: 'port' })).toBe(false);
  });

  test('the step message is a valid worker-to-main message', () => {
    expect(isWorkerToMain({ t: 'step', id: 7, runId: 3, event: { kind: 'compose' } })).toBe(true);
    expect(isWorkerToMain({ t: 'step', id: 7, runId: 3, event: { kind: 'route', tool: 'none', via: 'llm' } })).toBe(true);
    expect(isWorkerToMain({ t: 'step', id: 'x', runId: 3, event: { kind: 'compose' } })).toBe(false);
    expect(isWorkerToMain({ t: 'step', id: 7, runId: 3, event: null })).toBe(false);
    expect(isWorkerToMain({ t: 'step', id: 7, runId: 3, event: { nokind: true } })).toBe(false);
  });

  test('Round 4: an optional routeHint {tool, margin, cut, hits} is accepted; a malformed one or an extra key is rejected', () => {
    const routeHint = { tool: 'profit_loss', margin: 0.42, cut: 0.35, hits: [] };
    expect(isMainToWorker({ ...run, routeHint })).toBe(true);
    expect(isMainToWorker({ ...run, routeHint: { ...routeHint, hits: ['profit_loss', 'spending_summary'] } })).toBe(true);
    expect(isMainToWorker({ ...run, routeHint: { ...routeHint, extra: 1 } })).toBe(false);
    expect(isMainToWorker({ ...run, routeHint: { ...routeHint, margin: '0.4' } })).toBe(false);
    expect(isMainToWorker({ ...run, routeHint: { ...routeHint, margin: Number.NaN } })).toBe(false);
    expect(isMainToWorker({ ...run, routeHint: { ...routeHint, cut: null } })).toBe(false);
    expect(isMainToWorker({ ...run, routeHint: { ...routeHint, tool: 7 } })).toBe(false);
    expect(isMainToWorker({ ...run, routeHint: { ...routeHint, hits: 'profit_loss' } })).toBe(false);
    expect(isMainToWorker({ ...run, routeHint: { ...routeHint, hits: [1] } })).toBe(false);
    const { cut: _cut, ...noCut } = routeHint;
    expect(isMainToWorker({ ...run, routeHint: noCut })).toBe(false);
    expect(isMainToWorker({ ...run, routeHint: null })).toBe(false);
    expect(isMainToWorker({ ...run, routeHint: undefined })).toBe(true);
  });

  test('Round 4: a route step event may carry via openjev with margin and cut (and why on a rejected hint)', () => {
    const step = (event: unknown) => ({ t: 'step', id: 7, runId: 3, event });
    expect(isWorkerToMain(step({ kind: 'route', tool: 'net_worth', via: 'openjev', margin: 0.5, cut: 0.35 }))).toBe(true);
    expect(isWorkerToMain(step({ kind: 'route', tool: 'none', via: 'openjev', margin: 0.1, cut: 0.35, why: 'low-margin' }))).toBe(true);
    expect(isWorkerToMain(step({ kind: 'route', tool: 'net_worth', via: 'keyword' }))).toBe(true);
    expect(isWorkerToMain(step({ kind: 'route', tool: 'net_worth', via: 'magic' }))).toBe(false);
    expect(isWorkerToMain(step({ kind: 'route', tool: 'net_worth', via: 'openjev', margin: 'high' }))).toBe(false);
    expect(isWorkerToMain(step({ kind: 'route', tool: 'net_worth', via: 'openjev', cut: 'x' }))).toBe(false);
    expect(isWorkerToMain(step({ kind: 'route', tool: 3, via: 'keyword' }))).toBe(false);
  });

  test('a subagentRun result rides the ordinary result envelope', () => {
    const result = { outcome: { kind: 'cancelled' }, deviceFault: false };
    expect(isWorkerToMain({ t: 'result', id: 7, ok: true, result })).toBe(true);
  });

  test('clampSubagentLimits keeps maxSteps in 1..4 and the other bounds finite', () => {
    expect(clampSubagentLimits({ maxSteps: 3 }).maxSteps).toBe(3);
    expect(clampSubagentLimits({ maxSteps: 99 }).maxSteps).toBe(SUBAGENT_MAX_STEPS_HARD);
    expect(clampSubagentLimits({ maxSteps: 0 }).maxSteps).toBe(1);
    expect(clampSubagentLimits({ maxSteps: Number.NaN }).maxSteps).toBe(DEFAULT_SUBAGENT_LIMITS.maxSteps);
    expect(clampSubagentLimits(undefined)).toEqual(DEFAULT_SUBAGENT_LIMITS);
    // Other fields are not overridable through the config knob.
    expect(clampSubagentLimits({ maxSteps: 2 }).runDeadlineMs).toBe(DEFAULT_SUBAGENT_LIMITS.runDeadlineMs);
  });

  test('Round 3: compose is "template" by default and "model" only when asked, in the clamp and the wire guard', () => {
    expect(DEFAULT_SUBAGENT_LIMITS.compose).toBe('template');
    expect(clampSubagentLimits({ maxSteps: 3 }).compose).toBe('template');
    expect(clampSubagentLimits({ compose: 'model' }).compose).toBe('model');
    expect(clampSubagentLimits({ compose: 'template' }).compose).toBe('template');
    expect(clampSubagentLimits({ compose: 'anything-else' }).compose).toBe('template');
    const run = { t: 'subagentRun', id: 7, runId: 3, query: 'q', nowIso: '2026-07-15T12:00:00.000Z', expectedProfile: 'default', priorLocalTurns: [], port: {} };
    expect(isMainToWorker({ ...run, limits: { ...DEFAULT_SUBAGENT_LIMITS, compose: 'model' } })).toBe(true);
    const { compose: _c, ...legacy } = DEFAULT_SUBAGENT_LIMITS;
    expect(isMainToWorker({ ...run, limits: legacy })).toBe(true); // older callers omit it
    expect(isMainToWorker({ ...run, limits: { ...DEFAULT_SUBAGENT_LIMITS, compose: 'free-text' } })).toBe(false);
  });
});
