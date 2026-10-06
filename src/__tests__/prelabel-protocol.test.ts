/** S2: worker protocol validation (specs/open-jev-labeler.md §5). */
import { describe, test, expect } from 'bun:test';
import {
  MAX_RUN_ITEMS,
  parseFromWorker,
  parseToWorker,
  type FromWorker,
  type PrelabelPins,
  type ToWorker,
} from '../dashboard/ui/src/prelabel/protocol.js';

const pins: PrelabelPins = {
  repo: 'onnx-community/open-jev-deberta-v3-large-ONNX',
  dtype: 'q4f16',
  device: 'webgpu',
  temperature: 1.05,
  templateVersion: 'prelabel-tmpl-v1',
  modelId: 'onnx-community/open-jev-deberta-v3-large-ONNX:q4f16',
  revision: '7c79f25b5ac496089f448a969c801872ad59d31c',
  configSha: '2ec35432332ee6b5880509eefe44e6279fd9d3543f6ba96098119ffe0b0c2d5e',
};

const okRow = {
  txnId: 7,
  ok: true as const,
  choice: 'Groceries',
  p1: 0.4,
  p2: 0.24,
  margin: 0.16,
  top2: [['Groceries', 0.4], ['Shopping', 0.24]] as [[string, number], [string, number]],
  ms: 81.2,
  stateTokens: 21,
  truncated: false,
};

const toWorker: ToWorker[] = [
  { v: 1, type: 'init', pins, labels: ['Dining', 'Groceries', 'Other'], labelSetVersion: 'cat-18-0f7b02225108', assetBase: '/assets/' },
  { v: 1, type: 'probe' },
  { v: 1, type: 'info' },
  { v: 1, type: 'load' },
  { v: 1, type: 'run', runId: 'r1', items: [{ txnId: 1, description: 'RENT', amount: -1800, date: '2026-06-02' }] },
  { v: 1, type: 'run', runId: 'r2', items: [] },
  { v: 1, type: 'cancel', runId: 'r1' },
  { v: 1, type: 'dispose' },
];

const fromWorker: FromWorker[] = [
  { v: 1, type: 'capability', verdict: 'ready', reason: null, adapter: { vendor: 'apple', architecture: 'metal-3', shaderF16: true, isFallback: false } },
  { v: 1, type: 'capability', verdict: 'unavailable', reason: 'no_webgpu', adapter: null },
  { v: 1, type: 'capability', verdict: 'failed', reason: 'load', adapter: null },
  { v: 1, type: 'info', isCached: false, downloadSize: 357050727 },
  { v: 1, type: 'progress', phase: 'download', loaded: 10, total: 100 },
  { v: 1, type: 'progress', phase: 'session', loaded: 1, total: 1 },
  { v: 1, type: 'progress', phase: 'warmup', loaded: 1, total: 3 },
  {
    v: 1, type: 'loaded', loadMs: 1200, fromCache: true, firstDecisionMs: 200,
    runtime: { transformers: '4.3.0', ort: '1.31.0', openJev: '0.1.2', device: 'webgpu', dtype: 'q4f16' },
    configSha: pins.configSha,
  },
  { v: 1, type: 'results', runId: 'r1', rows: [okRow, { txnId: 8, ok: false, reason: 'decide_error' }, { txnId: 9, ok: false, reason: 'empty_description' }, { txnId: 10, ok: false, reason: 'bad_amount' }] },
  { v: 1, type: 'results', runId: 'r1', rows: [] },
  { v: 1, type: 'done', runId: 'r1', n: 49, skipped: 1, cancelled: false, p50Ms: 81, p95Ms: 88, wallMs: 4100 },
  { v: 1, type: 'error', fatal: true, code: 'model_mismatch', detail: 'configSha differs' },
  { v: 1, type: 'error', fatal: false, code: 'decide', detail: 'boom' },
  { v: 1, type: 'error', fatal: true, code: 'load', detail: '' },
  { v: 1, type: 'error', fatal: true, code: 'label_set_too_large', detail: '250 tokens' },
  { v: 1, type: 'error', fatal: false, code: 'locked', detail: 'other tab' },
];

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

describe('parseToWorker', () => {
  test.each(toWorker.map((m, i) => [`${m.type} #${i}`, m] as const))('round-trips %s', (_n, m) => {
    expect(parseToWorker(clone(m))).toEqual(m);
  });

  test('non-objects and arrays -> null', () => {
    for (const x of [null, undefined, 1, 'init', true, [], [{ v: 1, type: 'probe' }]]) {
      expect(parseToWorker(x)).toBeNull();
    }
  });

  test('wrong or missing version -> null', () => {
    expect(parseToWorker({ type: 'probe' })).toBeNull();
    expect(parseToWorker({ v: 2, type: 'probe' })).toBeNull();
    expect(parseToWorker({ v: '1', type: 'probe' })).toBeNull();
    expect(parseToWorker({ v: 0, type: 'probe' })).toBeNull();
  });

  test('unknown type -> null', () => {
    expect(parseToWorker({ v: 1, type: 'reboot' })).toBeNull();
    expect(parseToWorker({ v: 1 })).toBeNull();
    expect(parseToWorker({ v: 1, type: 5 })).toBeNull();
  });

  test('extra keys at any level -> null', () => {
    for (const m of toWorker) {
      expect(parseToWorker({ ...clone(m), extra: 1 })).toBeNull();
    }
    const init = clone(toWorker[0]) as any;
    init.pins.sneaky = 'x';
    expect(parseToWorker(init)).toBeNull();
    const run = clone(toWorker[4]) as any;
    run.items[0].merchant = 'x';
    expect(parseToWorker(run)).toBeNull();
  });

  test('missing keys -> null', () => {
    const init = clone(toWorker[0]) as any;
    delete init.assetBase;
    expect(parseToWorker(init)).toBeNull();
    const run = clone(toWorker[4]) as any;
    delete run.runId;
    expect(parseToWorker(run)).toBeNull();
    const cancel = clone(toWorker[6]) as any;
    delete cancel.runId;
    expect(parseToWorker(cancel)).toBeNull();
  });

  test('malformed pins -> null (revision/configSha/repo end up in URLs and checks)', () => {
    const bad: Array<[string, unknown]> = [
      ['revision', 'main'],
      ['revision', '7c79f25b5ac496089f448a969c801872ad59d31'], // 39 chars
      ['revision', '7C79F25B5AC496089F448A969C801872AD59D31C'], // upper-case
      ['revision', '../../x'],
      ['configSha', 'abc'],
      ['configSha', 'z'.repeat(64)],
      ['repo', 'no-slash'],
      ['repo', 'a/b/../../c'],
      ['repo', 'a/b?x=1'],
      ['dtype', 'fp16'],
      ['dtype', 'auto'],
      ['device', 'cpu'],
      ['temperature', '1.05'],
      ['temperature', Number.NaN],
      ['templateVersion', 'prelabel-tmpl-v2'],
      ['modelId', 'has space'],
      ['modelId', 'x'.repeat(65)],
      ['modelId', ''],
    ];
    for (const [k, v] of bad) {
      const init = clone(toWorker[0]) as any;
      init.pins[k] = v;
      expect(parseToWorker(init)).toBeNull();
    }
  });

  test('the fp32/wasm pin shape is accepted structurally (policy lives in the engine)', () => {
    const init = clone(toWorker[0]) as any;
    init.pins.dtype = 'fp32';
    init.pins.device = 'wasm';
    expect(parseToWorker(init)).not.toBeNull();
  });

  test('init labels must be non-empty strings', () => {
    for (const labels of [[], ['a', 1], ['a', ''], 'a', null]) {
      const init = clone(toWorker[0]) as any;
      init.labels = labels;
      expect(parseToWorker(init)).toBeNull();
    }
  });

  test('run: item field types, txnId integer, <= MAX_RUN_ITEMS', () => {
    const mk = (items: unknown) => ({ v: 1, type: 'run', runId: 'r', items });
    const item = { txnId: 1, description: 'd', amount: 1, date: '2026-01-01' };
    expect(parseToWorker(mk([item]))).not.toBeNull();
    expect(parseToWorker(mk([{ ...item, txnId: 1.5 }]))).toBeNull();
    expect(parseToWorker(mk([{ ...item, txnId: '1' }]))).toBeNull();
    expect(parseToWorker(mk([{ ...item, description: 3 }]))).toBeNull();
    expect(parseToWorker(mk([{ ...item, amount: '1' }]))).toBeNull();
    expect(parseToWorker(mk([{ ...item, date: null }]))).toBeNull();
    expect(parseToWorker(mk('nope'))).toBeNull();
    expect(MAX_RUN_ITEMS).toBe(2000);
    expect(parseToWorker(mk(Array.from({ length: MAX_RUN_ITEMS }, (_, i) => ({ ...item, txnId: i }))))).not.toBeNull();
    expect(parseToWorker(mk(Array.from({ length: MAX_RUN_ITEMS + 1 }, (_, i) => ({ ...item, txnId: i }))))).toBeNull();
  });

  test('run: non-finite amounts survive parsing so the engine can report bad_amount', () => {
    const msg = structuredClone({ v: 1, type: 'run', runId: 'r', items: [{ txnId: 1, description: 'd', amount: Number.NaN, date: '2026-01-01' }] });
    expect(parseToWorker(msg)).not.toBeNull();
  });

  test('runId must be a non-empty string', () => {
    expect(parseToWorker({ v: 1, type: 'cancel', runId: '' })).toBeNull();
    expect(parseToWorker({ v: 1, type: 'cancel', runId: 5 })).toBeNull();
  });
});

describe('parseFromWorker', () => {
  test.each(fromWorker.map((m, i) => [`${m.type} #${i}`, m] as const))('round-trips %s', (_n, m) => {
    expect(parseFromWorker(clone(m))).toEqual(m);
  });

  test('non-objects and arrays -> null', () => {
    for (const x of [null, undefined, 0, 'done', [], [{ v: 1 }]]) expect(parseFromWorker(x)).toBeNull();
  });

  test('wrong or missing version -> null', () => {
    for (const m of fromWorker) {
      expect(parseFromWorker({ ...clone(m), v: 2 })).toBeNull();
      const { v: _v, ...rest } = clone(m) as any;
      expect(parseFromWorker(rest)).toBeNull();
    }
  });

  test('extra keys at any level -> null', () => {
    for (const m of fromWorker) expect(parseFromWorker({ ...clone(m), extra: true })).toBeNull();
    const cap = clone(fromWorker[0]) as any;
    cap.adapter.deviceId = 'x';
    expect(parseFromWorker(cap)).toBeNull();
    const loaded = clone(fromWorker[7]) as any;
    loaded.runtime.gpu = 'x';
    expect(parseFromWorker(loaded)).toBeNull();
    const results = clone(fromWorker[8]) as any;
    results.rows[0].description = 'leak';
    expect(parseFromWorker(results)).toBeNull();
    const bad = clone(fromWorker[8]) as any;
    bad.rows[1].choice = 'x';
    expect(parseFromWorker(bad)).toBeNull();
  });

  test('enum and type violations -> null', () => {
    const tweak = (i: number, f: (m: any) => void) => {
      const m = clone(fromWorker[i]) as any;
      f(m);
      return parseFromWorker(m);
    };
    expect(tweak(0, (m) => { m.verdict = 'maybe'; })).toBeNull();
    expect(tweak(0, (m) => { m.reason = 5; })).toBeNull();
    expect(tweak(0, (m) => { m.adapter.shaderF16 = 'yes'; })).toBeNull();
    expect(tweak(3, (m) => { m.isCached = 1; })).toBeNull();
    expect(tweak(3, (m) => { m.downloadSize = '5'; })).toBeNull();
    expect(tweak(4, (m) => { m.phase = 'upload'; })).toBeNull();
    expect(tweak(7, (m) => { m.runtime.openJev = '0.1.3'; })).toBeNull();
    expect(tweak(7, (m) => { m.fromCache = 'true'; })).toBeNull();
    expect(tweak(8, (m) => { m.rows[0].top2 = [['a', 1]]; })).toBeNull();
    expect(tweak(8, (m) => { m.rows[0].top2 = [['a', 1], ['b', '2']]; })).toBeNull();
    expect(tweak(8, (m) => { m.rows[0].truncated = 0; })).toBeNull();
    expect(tweak(8, (m) => { m.rows[1].reason = 'timeout'; })).toBeNull();
    expect(tweak(8, (m) => { m.rows[0].txnId = 1.2; })).toBeNull();
    expect(tweak(8, (m) => { m.rows = 'x'; })).toBeNull();
    expect(tweak(8, (m) => { m.rows[0].ok = 'true'; })).toBeNull();
    expect(tweak(10, (m) => { m.cancelled = undefined; })).toBeNull();
    expect(tweak(11, (m) => { m.code = 'oops'; })).toBeNull();
    expect(tweak(11, (m) => { m.fatal = 'yes'; })).toBeNull();
    expect(tweak(11, (m) => { m.detail = 5; })).toBeNull();
  });

  test('unknown type -> null', () => {
    expect(parseFromWorker({ v: 1, type: 'telemetry' })).toBeNull();
  });

  test('shape only: non-finite scores parse, so the main thread can count and drop them (acceptResults)', () => {
    const msg = structuredClone({
      v: 1, type: 'results', runId: 'r',
      rows: [{ ...okRow, p1: Number.NaN, p2: 2, margin: Number.POSITIVE_INFINITY }],
    });
    expect(parseFromWorker(msg)).not.toBeNull();
  });
});
