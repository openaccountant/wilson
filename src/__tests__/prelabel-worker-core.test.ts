/** S4: worker engine with a fake OpenJev, fake transformers env, fake gpu and injectable clock. */
import { describe, test, expect } from 'bun:test';
import { createPrelabelEngine, type PrelabelEngineDeps } from '../dashboard/ui/src/prelabel/worker-core.js';
import { formatState } from '../dashboard/ui/src/prelabel/core.js';
import type { FromWorker, PrelabelPins, PrelabelItem, ToWorker } from '../dashboard/ui/src/prelabel/protocol.js';

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
const labels = ['Dining', 'Groceries', 'Shopping', 'Other'];

type Call = string;

interface Harness {
  engine: ReturnType<typeof createPrelabelEngine>;
  out: FromWorker[];
  calls: Call[];
  env: any;
  decideCalls: { state: string; questions: any; options: any }[];
  clock: { t: number };
  send(msg: ToWorker): Promise<void>;
  jev: any;
}

function adapter(over: Record<string, unknown> = {}) {
  return {
    features: { has: (f: string) => f === 'shader-f16' },
    info: { vendor: 'apple', architecture: 'metal-3', description: '', device: '', isFallbackAdapter: false },
    ...over,
  };
}

function make(opts: {
  gpu?: any;
  decide?: (state: string, i: number) => any;
  configSha?: string;
  onDecide?: (i: number, h: Harness) => void;
  tokens?: (t: string) => number;
  loadThrows?: boolean;
  runtime?: any;
} = {}): Harness {
  const calls: Call[] = [];
  const out: FromWorker[] = [];
  const decideCalls: Harness['decideCalls'] = [];
  const clock = { t: 1000 };
  const env: any = {
    version: '4.3.0',
    remoteHost: 'https://huggingface.co/',
    backends: { onnx: { wasm: {}, versions: { web: '1.31.0' } } },
  };
  // Record the moment remotePathTemplate is assigned relative to info()/load().
  let template = '';
  Object.defineProperty(env, 'remotePathTemplate', {
    get: () => template,
    set: (v: string) => { calls.push('set:remotePathTemplate'); template = v; },
  });
  let n = 0;
  let h!: Harness;
  const jev = {
    runtime: opts.runtime ?? { model: pins.repo, family: 'open-jev', device: 'webgpu', dtype: 'q4f16' },
    countTokens: (t: string) => (opts.tokens ? opts.tokens(t) : Math.ceil(t.length / 4)),
    decide: async (state: string, questions: any, options: any) => {
      const i = n++;
      decideCalls.push({ state, questions, options });
      clock.t += 80;
      opts.onDecide?.(i, h);
      if (opts.decide) return opts.decide(state, i);
      const o = questions[0].options as string[];
      const probabilities: Record<string, number> = {};
      o.forEach((l, k) => (probabilities[l] = k === 1 ? 0.6 : 0.4 / (o.length - 1)));
      return [{ type: 'choice', choice: o[1], confidence: 0.6, probabilities }];
    },
    dispose: async () => { calls.push('dispose'); },
  };
  const OpenJev = {
    info: async (o: any) => { calls.push('info'); return { isCached: false, downloadSize: 357050727, files: [], ...o }; },
    load: async (o: any) => {
      calls.push('load');
      if (opts.loadThrows) throw new Error('boom');
      o.onProgress?.({ progress: 0.5, loaded: 50, total: 100 });
      o.onProgress?.({ progress: 1, loaded: 100, total: 100 });
      return jev;
    },
  };
  const deps: PrelabelEngineDeps = {
    loadOpenJev: async () => ({ OpenJev: OpenJev as any, env, ortVersion: '1.31.0' }),
    now: () => clock.t,
    gpu: opts.gpu === undefined ? { requestAdapter: async () => adapter() } : opts.gpu === null ? undefined : opts.gpu,
    fetchConfigSha: async (url: string) => { calls.push(`fetchConfigSha:${url}`); return opts.configSha ?? pins.configSha; },
    yieldTick: async () => {},
    post: (m) => out.push(m),
  };
  const engine = createPrelabelEngine(deps);
  h = { engine, out, calls, env, decideCalls, clock, jev, send: (m) => engine.handle(m) };
  return h;
}

const init: ToWorker = { v: 1, type: 'init', pins, labels, labelSetVersion: 'cat-4-x', assetBase: '/assets/' };
const items = (n: number): PrelabelItem[] =>
  Array.from({ length: n }, (_, i) => ({ txnId: i + 1, description: `MERCHANT ${i}`, amount: -(i + 1) * 1.5, date: '2026-06-02T10:00:00Z' }));
const caps = (o: FromWorker[]) => o.filter((m) => m.type === 'capability') as Extract<FromWorker, { type: 'capability' }>[];
const errs = (o: FromWorker[]) => o.filter((m) => m.type === 'error') as Extract<FromWorker, { type: 'error' }>[];
const results = (o: FromWorker[]) => o.filter((m) => m.type === 'results') as Extract<FromWorker, { type: 'results' }>[];
const done = (o: FromWorker[]) => o.find((m) => m.type === 'done') as Extract<FromWorker, { type: 'done' }>;

async function ready(h: Harness) {
  await h.send(init);
  await h.send({ v: 1, type: 'load' });
}

describe('capability ladder', () => {
  test('navigator.gpu undefined -> unavailable:no_webgpu, never throws', async () => {
    const h = make({ gpu: null });
    await h.send(init);
    await h.send({ v: 1, type: 'probe' });
    expect(caps(h.out)).toEqual([{ v: 1, type: 'capability', verdict: 'unavailable', reason: 'no_webgpu', adapter: null }]);
  });

  test('requestAdapter returns null or throws -> unavailable:no_webgpu', async () => {
    for (const requestAdapter of [async () => null, async () => { throw new Error('nope'); }]) {
      const h = make({ gpu: { requestAdapter } });
      await h.send(init);
      await h.send({ v: 1, type: 'probe' });
      expect(caps(h.out)[0]).toMatchObject({ verdict: 'unavailable', reason: 'no_webgpu' });
    }
  });

  test('adapter.info.isFallbackAdapter is honoured', async () => {
    const h = make({ gpu: { requestAdapter: async () => adapter({ info: { vendor: 'x', architecture: 'y', isFallbackAdapter: true } }) } });
    await h.send(init);
    await h.send({ v: 1, type: 'probe' });
    expect(caps(h.out)[0]).toMatchObject({ verdict: 'unavailable', reason: 'no_webgpu', adapter: { isFallback: true } });
  });

  test('falls back to the deprecated top-level isFallbackAdapter when info lacks it', async () => {
    const h = make({
      gpu: { requestAdapter: async () => ({ features: { has: () => true }, info: { vendor: 'x', architecture: 'y' }, isFallbackAdapter: true }) },
    });
    await h.send(init);
    await h.send({ v: 1, type: 'probe' });
    expect(caps(h.out)[0]).toMatchObject({ verdict: 'unavailable', reason: 'no_webgpu' });
  });

  test('a null isFallbackAdapter (the spike saw this) does not count as fallback', async () => {
    const h = make({ gpu: { requestAdapter: async () => adapter({ info: { vendor: 'apple', architecture: 'metal-3', isFallbackAdapter: null } }) } });
    await h.send(init);
    await h.send({ v: 1, type: 'probe' });
    expect(caps(h.out)[0]).toMatchObject({ verdict: 'ready', reason: null });
  });

  test('SwiftShader vendor or architecture -> unavailable:no_webgpu', async () => {
    for (const info of [
      { vendor: 'Google', architecture: 'swiftshader', isFallbackAdapter: false },
      { vendor: 'SwiftShader', architecture: '', isFallbackAdapter: false },
    ]) {
      const h = make({ gpu: { requestAdapter: async () => adapter({ info }) } });
      await h.send(init);
      await h.send({ v: 1, type: 'probe' });
      expect(caps(h.out)[0]).toMatchObject({ verdict: 'unavailable', reason: 'no_webgpu' });
    }
  });

  test('no shader-f16 -> unavailable:no_shader_f16 (no wasm fallback)', async () => {
    const h = make({ gpu: { requestAdapter: async () => adapter({ features: { has: () => false } }) } });
    await h.send(init);
    await h.send({ v: 1, type: 'probe' });
    expect(caps(h.out)[0]).toMatchObject({ verdict: 'unavailable', reason: 'no_shader_f16', adapter: { shaderF16: false } });
    await h.send({ v: 1, type: 'load' });
    expect(h.calls).not.toContain('load');
    expect(caps(h.out).at(-1)).toMatchObject({ verdict: 'unavailable', reason: 'no_shader_f16' });
  });

  test('healthy adapter -> ready with adapter details', async () => {
    const h = make();
    await h.send(init);
    await h.send({ v: 1, type: 'probe' });
    expect(caps(h.out)[0]).toEqual({
      v: 1, type: 'capability', verdict: 'ready', reason: null,
      adapter: { vendor: 'apple', architecture: 'metal-3', shaderF16: true, isFallback: false },
    });
    // probe is local: no network, no module load side effects on the model
    expect(h.calls).toEqual([]);
  });

  test('a wasm or fp32 pin is refused (OQ6: the wasm override is not built)', async () => {
    for (const bad of [{ ...pins, device: 'wasm' as const }, { ...pins, dtype: 'fp32' as const }]) {
      const h = make();
      await h.send({ ...init, pins: bad } as ToWorker);
      expect(caps(h.out)[0]).toMatchObject({ verdict: 'unavailable', reason: 'unsupported_pins' });
      await h.send({ v: 1, type: 'load' });
      expect(h.calls).not.toContain('load');
    }
  });

  test('messages before init are refused, not crashed', async () => {
    const h = make();
    await h.send({ v: 1, type: 'load' });
    await h.send({ v: 1, type: 'run', runId: 'r', items: items(1) });
    expect(errs(h.out).length).toBe(2);
    expect(h.calls).toEqual([]);
  });
});

describe('consent, pinning and load', () => {
  test('info() is never called unless an info message arrives', async () => {
    const h = make();
    await ready(h);
    expect(h.calls).not.toContain('info');
    await h.send({ v: 1, type: 'info' });
    expect(h.calls.filter((c) => c === 'info').length).toBe(1);
    expect(h.out.find((m) => m.type === 'info')).toEqual({ v: 1, type: 'info', isCached: false, downloadSize: 357050727 });
  });

  test('nothing touches the network before a load or info message', async () => {
    const h = make();
    await h.send(init);
    await h.send({ v: 1, type: 'probe' });
    expect(h.calls).toEqual([]);
  });

  test('env.remotePathTemplate is pinned to the revision BEFORE info() and BEFORE load()', async () => {
    const h = make();
    await h.send(init);
    await h.send({ v: 1, type: 'info' });
    await h.send({ v: 1, type: 'load' });
    const iTemplate = h.calls.indexOf('set:remotePathTemplate');
    expect(iTemplate).toBeGreaterThanOrEqual(0);
    expect(iTemplate).toBeLessThan(h.calls.indexOf('info'));
    expect(iTemplate).toBeLessThan(h.calls.indexOf('load'));
    expect(h.env.remotePathTemplate).toBe(`{model}/resolve/${pins.revision}/`);
    expect(h.env.allowLocalModels).toBe(false);
    expect(h.env.backends.onnx.wasm.wasmPaths).toBe('/assets/ort/');
  });

  test('assetBase without a trailing slash still yields <base>/ort/', async () => {
    const h = make();
    await h.send({ ...init, assetBase: '/wilson/assets' } as ToWorker);
    await h.send({ v: 1, type: 'info' });
    expect(h.env.backends.onnx.wasm.wasmPaths).toBe('/wilson/assets/ort/');
  });

  test('config.json is fetched at the pinned revision and verified before the weights load', async () => {
    const h = make();
    await ready(h);
    const iFetch = h.calls.findIndex((c) => c.startsWith('fetchConfigSha:'));
    expect(h.calls[iFetch]).toBe(`fetchConfigSha:https://huggingface.co/${pins.repo}/resolve/${pins.revision}/config.json`);
    expect(iFetch).toBeLessThan(h.calls.indexOf('load'));
  });

  test('configSha mismatch -> failed:model_mismatch, fatal error, weights never loaded', async () => {
    const h = make({ configSha: 'f'.repeat(64) });
    await ready(h);
    expect(h.calls).not.toContain('load');
    expect(caps(h.out).at(-1)).toMatchObject({ verdict: 'failed', reason: 'model_mismatch' });
    expect(errs(h.out).at(-1)).toMatchObject({ fatal: true, code: 'model_mismatch' });
    expect(h.out.find((m) => m.type === 'loaded')).toBeUndefined();
    // and the engine refuses to run afterwards
    await h.send({ v: 1, type: 'run', runId: 'r', items: items(1) });
    expect(h.decideCalls.length).toBe(0);
  });

  test('loaded reports runtime, configSha and the first-decision time', async () => {
    const h = make();
    await ready(h);
    const seen: any = h.out.find((m) => m.type === 'loaded');
    expect(seen).toMatchObject({
      v: 1, type: 'loaded', configSha: pins.configSha,
      runtime: { transformers: '4.3.0', ort: '1.31.0', openJev: '0.1.2', device: 'webgpu', dtype: 'q4f16' },
    });
    // warmup decision happened with the real labels and measured the first decision time
    expect(h.decideCalls.length).toBe(1);
    expect(seen.firstDecisionMs).toBe(80);
    expect(h.out.filter((m) => m.type === 'progress').map((m: any) => m.phase)).toEqual(
      expect.arrayContaining(['download', 'session', 'warmup']),
    );
  });

  test('a runtime that is not webgpu/q4f16 is disposed and reported as a load failure', async () => {
    const h = make({ runtime: { model: pins.repo, family: 'open-jev', device: 'wasm', dtype: 'q4f16' } });
    await ready(h);
    expect(h.calls).toContain('dispose');
    expect(errs(h.out).at(-1)).toMatchObject({ fatal: true, code: 'load' });
    expect(h.out.find((m) => m.type === 'loaded')).toBeUndefined();
  });

  test('a load failure reports failed:load and a fatal load error', async () => {
    const h = make({ loadThrows: true });
    await ready(h);
    expect(caps(h.out).at(-1)).toMatchObject({ verdict: 'failed', reason: 'load' });
    expect(errs(h.out).at(-1)).toMatchObject({ fatal: true, code: 'load', detail: 'boom' });
  });

  test('a second load message re-reports loaded without loading twice', async () => {
    const h = make();
    await ready(h);
    await h.send({ v: 1, type: 'load' });
    expect(h.calls.filter((c) => c === 'load').length).toBe(1);
    expect(h.out.filter((m) => m.type === 'loaded').length).toBe(2);
  });
});

describe('run', () => {
  test('decide receives temperature 1.05, truncation cut and bare options in label order', async () => {
    const h = make();
    await ready(h);
    h.decideCalls.length = 0;
    await h.send({ v: 1, type: 'run', runId: 'r1', items: items(1) });
    const c = h.decideCalls[0];
    expect(c.options).toEqual({ temperature: 1.05, truncation: 'cut' });
    expect(c.questions).toEqual([
      { type: 'choice', instructions: 'Which spending category does this transaction belong to?', options: labels },
    ]);
    expect(c.questions[0].descriptions).toBeUndefined();
    expect(c.state).toBe(formatState({ description: 'MERCHANT 0', amount: -1.5, date: '2026-06-02T10:00:00Z' }));
    expect(c.state).toBe('description: MERCHANT 0 | amount: -1.50 | date: 2026-06-02');
  });

  test('result rows carry choice, p1, p2, margin, top2, ms, stateTokens, truncated', async () => {
    const h = make();
    await ready(h);
    await h.send({ v: 1, type: 'run', runId: 'r1', items: items(1) });
    const row = results(h.out)[0].rows[0] as any;
    expect(row).toMatchObject({ txnId: 1, ok: true, choice: 'Groceries', p1: 0.6, truncated: false, ms: 80 });
    expect(row.p2).toBeCloseTo(0.4 / 3, 10);
    expect(row.margin).toBeCloseTo(0.6 - 0.4 / 3, 10);
    expect(row.top2[0]).toEqual(['Groceries', 0.6]);
    expect(row.top2[1][0]).toBe('Dining');
    expect(row.stateTokens).toBe(Math.ceil('description: MERCHANT 0 | amount: -1.50 | date: 2026-06-02'.length / 4));
  });

  test('results chunk at 5 rows, then every 25, then flush the remainder; done summarises', async () => {
    const h = make();
    await ready(h);
    await h.send({ v: 1, type: 'run', runId: 'r1', items: items(60) });
    expect(results(h.out).map((r) => r.rows.length)).toEqual([5, 25, 25, 5]);
    expect(results(h.out).every((r) => r.runId === 'r1')).toBe(true);
    const d = done(h.out);
    expect(d).toMatchObject({ runId: 'r1', n: 60, skipped: 0, cancelled: false, p50Ms: 80, p95Ms: 80 });
    expect(d.wallMs).toBe(60 * 80);
    // done is the last message of the run
    expect(h.out.at(-1)!.type).toBe('done');
  });

  test('rows are scored in input order', async () => {
    const h = make();
    await ready(h);
    await h.send({ v: 1, type: 'run', runId: 'r1', items: items(7) });
    expect(results(h.out).flatMap((r) => r.rows.map((x) => x.txnId))).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  test('cancel stops within one row and reports cancelled with a flushed partial chunk', async () => {
    const h = make({
      onDecide: (i, hh) => {
        // i counts warmup as decide #0; the 3rd run row is decide #3
        if (i === 3) void hh.send({ v: 1, type: 'cancel', runId: 'r1' });
      },
    });
    await ready(h);
    await h.send({ v: 1, type: 'run', runId: 'r1', items: items(50) });
    const scored = results(h.out).flatMap((r) => r.rows);
    expect(scored.length).toBe(3);
    expect(h.decideCalls.length).toBe(1 + 3);
    expect(done(h.out)).toMatchObject({ runId: 'r1', n: 3, cancelled: true });
  });

  test('cancel with a different runId is ignored', async () => {
    const h = make({ onDecide: (i, hh) => { if (i === 2) void hh.send({ v: 1, type: 'cancel', runId: 'other' }); } });
    await ready(h);
    await h.send({ v: 1, type: 'run', runId: 'r1', items: items(6) });
    expect(done(h.out)).toMatchObject({ n: 6, cancelled: false });
  });

  test('a too-large option set refuses the whole run with label_set_too_large', async () => {
    const h = make({ tokens: (t) => (labels.includes(t) ? 60 : 4) }); // 4 labels x 60 = 240 > 200
    await ready(h);
    h.decideCalls.length = 0;
    await h.send({ v: 1, type: 'run', runId: 'r1', items: items(3) });
    expect(h.decideCalls.length).toBe(0);
    expect(errs(h.out).at(-1)).toMatchObject({ code: 'label_set_too_large', fatal: false });
    expect(results(h.out).length).toBe(0);
  });

  test('exactly 200 option tokens is still allowed', async () => {
    const h = make({ tokens: (t) => (labels.includes(t) ? 50 : 4) });
    await ready(h);
    await h.send({ v: 1, type: 'run', runId: 'r1', items: items(2) });
    expect(done(h.out)).toMatchObject({ n: 2 });
  });

  test('rows whose state would be cut are still scored and flagged truncated', async () => {
    const h = make({ tokens: (t) => (t.startsWith('description: LONG') ? 400 : labels.includes(t) ? 5 : 5) });
    await ready(h);
    await h.send({
      v: 1, type: 'run', runId: 'r1',
      items: [
        { txnId: 1, description: 'LONG ' + 'x'.repeat(50), amount: -1, date: '2026-01-01' },
        { txnId: 2, description: 'short', amount: -1, date: '2026-01-01' },
      ],
    });
    const rows = results(h.out).flatMap((r) => r.rows) as any[];
    expect(rows.map((r) => [r.txnId, r.ok, r.truncated])).toEqual([[1, true, true], [2, true, false]]);
  });

  test('one decide error becomes ok:false and the run continues', async () => {
    const h = make({
      decide: (state, i) => {
        if (i === 3) throw new Error('gpu hiccup'); // 3rd run row (warmup is #0)
        return [{ type: 'choice', choice: 'Dining', confidence: 0.9, probabilities: { Dining: 0.9, Groceries: 0.05, Shopping: 0.03, Other: 0.02 } }];
      },
    });
    await ready(h);
    await h.send({ v: 1, type: 'run', runId: 'r1', items: items(5) });
    const rows = results(h.out).flatMap((r) => r.rows) as any[];
    expect(rows.length).toBe(5);
    expect(rows[2]).toEqual({ txnId: 3, ok: false, reason: 'decide_error' });
    expect(rows.filter((r) => r.ok).length).toBe(4);
    expect(done(h.out)).toMatchObject({ n: 4, skipped: 1, cancelled: false });
  });

  test('empty description and non-finite amount are skipped without calling decide', async () => {
    const h = make();
    await ready(h);
    h.decideCalls.length = 0;
    await h.send({
      v: 1, type: 'run', runId: 'r1',
      items: [
        { txnId: 1, description: '   ', amount: -1, date: '2026-01-01' },
        { txnId: 2, description: 'ok', amount: Number.NaN, date: '2026-01-01' },
        { txnId: 3, description: 'ok', amount: Infinity, date: '2026-01-01' },
        { txnId: 4, description: 'fine', amount: -4, date: '2026-01-01' },
      ],
    });
    const rows = results(h.out).flatMap((r) => r.rows);
    expect(rows[0]).toEqual({ txnId: 1, ok: false, reason: 'empty_description' });
    expect(rows[1]).toEqual({ txnId: 2, ok: false, reason: 'bad_amount' });
    expect(rows[2]).toEqual({ txnId: 3, ok: false, reason: 'bad_amount' });
    expect(rows[3]).toMatchObject({ txnId: 4, ok: true });
    expect(h.decideCalls.length).toBe(1);
    expect(done(h.out)).toMatchObject({ n: 1, skipped: 3 });
  });

  test('p50 and p95 over per-row ms', async () => {
    let i = 0;
    const h = make();
    const orig = h.jev.decide;
    h.jev.decide = async (...a: any[]) => {
      const ms = i === 0 ? 0 : [10, 20, 30, 40, 100][(i - 1) % 5];
      i++;
      const r = await orig(...a);
      h.clock.t += ms - 80; // net ms for the row
      return r;
    };
    await ready(h);
    await h.send({ v: 1, type: 'run', runId: 'r1', items: items(5) });
    const d = done(h.out);
    expect(d.p50Ms).toBe(30);
    expect(d.p95Ms).toBe(100);
  });

  test('a run before load is refused; a second concurrent run is refused', async () => {
    const h = make();
    await h.send(init);
    await h.send({ v: 1, type: 'run', runId: 'r1', items: items(1) });
    expect(errs(h.out).at(-1)).toMatchObject({ code: 'load', fatal: false });

    const h2 = make({ onDecide: (i, hh) => { if (i === 2) void hh.send({ v: 1, type: 'run', runId: 'r2', items: items(1) }); } });
    await ready(h2);
    await h2.send({ v: 1, type: 'run', runId: 'r1', items: items(4) });
    expect(errs(h2.out).some((e) => e.code === 'decide')).toBe(true);
    expect(done(h2.out)).toMatchObject({ runId: 'r1', n: 4 });
  });

  test('dispose releases the session and later runs are refused', async () => {
    const h = make();
    await ready(h);
    await h.send({ v: 1, type: 'dispose' });
    expect(h.calls).toContain('dispose');
    await h.send({ v: 1, type: 'run', runId: 'r1', items: items(1) });
    expect(errs(h.out).at(-1)).toMatchObject({ code: 'load' });
  });
});
