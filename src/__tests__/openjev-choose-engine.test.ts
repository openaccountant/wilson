/** Round 4, R4-4: the engine's `choose` request and the single decide queue (fake OpenJev). */
import { describe, test, expect } from 'bun:test';
import { createPrelabelEngine, type PrelabelEngineDeps } from '../dashboard/ui/src/prelabel/worker-core.js';
import type { FromWorker, PrelabelItem, PrelabelPins, ToWorker } from '../dashboard/ui/src/prelabel/protocol.js';
import { OPEN_JEV_ROUTE_OPTIONS, OPEN_JEV_ROUTE_QUESTION } from '../dashboard/ui/src/hybrid/openjev-route.js';

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
const ROUTE_NAMES = Object.keys(OPEN_JEV_ROUTE_OPTIONS);

interface Rig {
  engine: ReturnType<typeof createPrelabelEngine>;
  out: FromWorker[];
  decides: { state: string; question: any; opts: any }[];
  maxInFlight: () => number;
  send(m: ToWorker): Promise<void>;
}

function make(o: { tokens?: (t: string) => number; probs?: (opts: string[]) => Record<string, number>; delayMs?: number; failChoose?: boolean } = {}): Rig {
  const out: FromWorker[] = [];
  const decides: Rig['decides'] = [];
  let inFlight = 0;
  let max = 0;
  let clock = 1000;
  const jev = {
    runtime: { model: pins.repo, family: 'open-jev', device: 'webgpu', dtype: 'q4f16' },
    countTokens: (t: string) => (o.tokens ? o.tokens(t) : Math.ceil(t.length / 4)),
    decide: async (state: string, questions: any, opts: any) => {
      inFlight++;
      max = Math.max(max, inFlight);
      decides.push({ state, question: questions[0], opts });
      try {
        await new Promise((r) => setTimeout(r, o.delayMs ?? 1));
        clock += 80;
        if (o.failChoose && state.startsWith('CHOOSE')) throw new Error('decide boom');
        const names = questions[0].options as string[];
        const probabilities = o.probs ? o.probs(names) : Object.fromEntries(names.map((n, k) => [n, k === 1 ? 0.6 : 0.4 / (names.length - 1)]));
        return [{ type: 'choice', choice: names[1], confidence: 0.6, probabilities }];
      } finally {
        inFlight--;
      }
    },
    dispose: async () => {},
  };
  const env: any = { version: '4.3.0', remoteHost: 'https://huggingface.co/', backends: { onnx: { wasm: {}, versions: { web: '1.31.0' } } } };
  const deps: PrelabelEngineDeps = {
    loadOpenJev: async () => ({
      OpenJev: { info: async () => ({ isCached: true, downloadSize: 1 }), load: async () => jev } as any,
      env,
      ortVersion: '1.31.0',
    }),
    now: () => clock,
    gpu: { requestAdapter: async () => ({ features: { has: (f: string) => f === 'shader-f16' }, info: { vendor: 'apple', architecture: 'metal-3', isFallbackAdapter: false } }) } as any,
    fetchConfigSha: async () => pins.configSha,
    yieldTick: async () => {},
    post: (m) => out.push(m),
  };
  const engine = createPrelabelEngine(deps);
  return { engine, out, decides, maxInFlight: () => max, send: (m) => engine.handle(m) };
}

const initWithLabels: ToWorker = { v: 1, type: 'init', pins, labels, labelSetVersion: 'cat-4-x', assetBase: '/assets/' };
const initChatOnly: ToWorker = { v: 1, type: 'init', pins, labelSetVersion: '', assetBase: '/assets/' };
const items = (n: number): PrelabelItem[] =>
  Array.from({ length: n }, (_, i) => ({ txnId: i + 1, description: `MERCHANT ${i}`, amount: -(i + 1), date: '2026-06-02T10:00:00Z' }));
const chosen = (out: FromWorker[]) => out.filter((m) => m.type === 'chosen') as Extract<FromWorker, { type: 'chosen' }>[];

const chooseMsg = (reqId: string, over: Partial<Extract<ToWorker, { type: 'choose' }>> = {}): ToWorker => ({
  v: 1, type: 'choose', reqId, state: `CHOOSE ${reqId}`, question: OPEN_JEV_ROUTE_QUESTION, options: ROUTE_NAMES,
  descriptions: { ...OPEN_JEV_ROUTE_OPTIONS }, ...over,
});

describe('choose', () => {
  test('before load -> chosen ok:false not_loaded, and no decide', async () => {
    const r = make();
    await r.send(initChatOnly);
    await r.send(chooseMsg('c1'));
    expect(chosen(r.out)).toEqual([{ v: 1, type: 'chosen', reqId: 'c1', ok: false, reason: 'not_loaded' }]);
    expect(r.decides).toHaveLength(0);
  });

  test('before init too (nothing is loaded)', async () => {
    const r = make();
    await r.send(chooseMsg('c1'));
    expect(chosen(r.out)[0]).toMatchObject({ ok: false, reason: 'not_loaded' });
  });

  test('after load: answers with top1, p1, p2, margin, top2 and ms; decide gets the question, options, descriptions and temperature', async () => {
    const r = make({ probs: (n) => Object.fromEntries(n.map((x, k) => [x, [0.1, 0.55, 0.2, 0.1, 0.05][k]])) });
    await r.send(initChatOnly);
    await r.send({ v: 1, type: 'load' });
    r.decides.length = 0;
    await r.send(chooseMsg('c1'));
    const c = chosen(r.out)[0];
    expect(c).toMatchObject({ reqId: 'c1', ok: true, choice: 'spending_summary', p1: 0.55, p2: 0.2 });
    if (!c.ok) throw new Error('unreachable');
    expect(c.margin).toBeCloseTo(0.35, 10);
    expect(c.top2).toEqual([['spending_summary', 0.55], ['profit_loss', 0.2]]);
    expect(c.ms).toBeGreaterThanOrEqual(0);
    expect(r.decides).toHaveLength(1);
    expect(r.decides[0].state).toBe('CHOOSE c1');
    expect(r.decides[0].question).toEqual({ type: 'choice', instructions: OPEN_JEV_ROUTE_QUESTION, options: ROUTE_NAMES, descriptions: { ...OPEN_JEV_ROUTE_OPTIONS } });
    expect(r.decides[0].opts).toEqual({ temperature: 1.05, truncation: 'cut' });
  });

  test('without descriptions the question carries none', async () => {
    const r = make();
    await r.send(initChatOnly);
    await r.send({ v: 1, type: 'load' });
    r.decides.length = 0;
    await r.send({ v: 1, type: 'choose', reqId: 'c2', state: 's', question: 'q', options: ['a', 'b', 'c'] });
    expect(r.decides[0].question).toEqual({ type: 'choice', instructions: 'q', options: ['a', 'b', 'c'] });
  });

  test('an option set over 200 tokens is refused with options_too_large (descriptions count)', async () => {
    const r = make({ tokens: (t) => t.length }); // 1 token per char
    await r.send(initChatOnly);
    await r.send({ v: 1, type: 'load' });
    r.decides.length = 0;
    await r.send(chooseMsg('c1'));
    expect(chosen(r.out)[0]).toEqual({ v: 1, type: 'chosen', reqId: 'c1', ok: false, reason: 'options_too_large' });
    expect(r.decides).toHaveLength(0);
  });

  test('a decide error becomes chosen ok:false decide_error and the engine keeps serving', async () => {
    const r = make({ failChoose: true });
    await r.send(initChatOnly);
    await r.send({ v: 1, type: 'load' });
    await r.send(chooseMsg('c1'));
    expect(chosen(r.out)[0]).toMatchObject({ ok: false, reason: 'decide_error' });
    await r.send({ v: 1, type: 'choose', reqId: 'c2', state: 'fine', question: 'q', options: ['a', 'b'] });
    expect(chosen(r.out)[1]).toMatchObject({ reqId: 'c2', ok: true });
  });

  test('fewer than two probabilities -> decide_error', async () => {
    const r = make({ probs: () => ({ only: 1 }) });
    await r.send(initChatOnly);
    await r.send({ v: 1, type: 'load' });
    await r.send(chooseMsg('c1'));
    expect(chosen(r.out)[0]).toMatchObject({ ok: false, reason: 'decide_error' });
  });

  test('dispose then choose -> not_loaded', async () => {
    const r = make();
    await r.send(initChatOnly);
    await r.send({ v: 1, type: 'load' });
    await r.send({ v: 1, type: 'dispose' });
    await r.send(chooseMsg('c1'));
    expect(chosen(r.out)[0]).toMatchObject({ ok: false, reason: 'not_loaded' });
  });
});

describe('chat-only init (no labels)', () => {
  test('load warms up on the route question (not a category question) and posts loaded', async () => {
    const r = make();
    await r.send(initChatOnly);
    await r.send({ v: 1, type: 'load' });
    expect(r.out.some((m) => m.type === 'loaded')).toBe(true);
    expect(r.decides).toHaveLength(1);
    expect(r.decides[0].question.instructions).toBe(OPEN_JEV_ROUTE_QUESTION);
    expect(r.decides[0].question.options).toEqual(ROUTE_NAMES);
  });

  test('a labelled init still warms up on the category question, unchanged', async () => {
    const r = make();
    await r.send(initWithLabels);
    await r.send({ v: 1, type: 'load' });
    expect(r.decides[0].question.options).toEqual(labels);
  });

  test('a run with no labels is refused (not crashed) and nothing is scored', async () => {
    const r = make();
    await r.send(initChatOnly);
    await r.send({ v: 1, type: 'load' });
    r.decides.length = 0;
    await r.send({ v: 1, type: 'run', runId: 'r1', items: items(2) });
    expect(r.out.filter((m) => m.type === 'error').at(-1)).toMatchObject({ code: 'decide', fatal: false });
    expect(r.decides).toHaveLength(0);
  });
});

describe('one decide queue with choose priority', () => {
  test('a choose sent during a 200-row run is answered after at most the in-flight row, and no two decides overlap', async () => {
    const r = make({ delayMs: 2 });
    await r.send(initWithLabels);
    await r.send({ v: 1, type: 'load' });
    r.decides.length = 0;
    const run = r.send({ v: 1, type: 'run', runId: 'r1', items: items(200) });
    // Let a few rows go by, then ask while a row is in flight (the shim does not await handle()).
    await new Promise((res) => setTimeout(res, 12));
    const rowsBefore = r.decides.length;
    expect(rowsBefore).toBeGreaterThan(0);
    expect(rowsBefore).toBeLessThan(200);
    const ask = r.send(chooseMsg('c1'));
    await ask;
    const chooseAt = r.decides.findIndex((d) => d.state === 'CHOOSE c1');
    // The in-flight row (index rowsBefore - 1) may finish first; the choose is the very next decide.
    expect(chooseAt).toBe(rowsBefore);
    expect(chosen(r.out)).toHaveLength(1);
    // The run is nowhere near done when the answer lands.
    expect(r.out.some((m) => m.type === 'done')).toBe(false);
    await run;
    expect(r.maxInFlight()).toBe(1);
    const d = r.out.find((m) => m.type === 'done') as Extract<FromWorker, { type: 'done' }>;
    expect(d).toMatchObject({ n: 200, cancelled: false });
  });

  test('several chooses are served in order, each ahead of the remaining rows', async () => {
    const r = make({ delayMs: 2 });
    await r.send(initWithLabels);
    await r.send({ v: 1, type: 'load' });
    r.decides.length = 0;
    const run = r.send({ v: 1, type: 'run', runId: 'r1', items: items(60) });
    await new Promise((res) => setTimeout(res, 8));
    const before = r.decides.length;
    await Promise.all([r.send(chooseMsg('c1')), r.send(chooseMsg('c2')), r.send(chooseMsg('c3'))]);
    expect(r.decides.slice(before, before + 3).map((d) => d.state)).toEqual(['CHOOSE c1', 'CHOOSE c2', 'CHOOSE c3']);
    await run;
    expect(r.maxInFlight()).toBe(1);
    expect(chosen(r.out).map((c) => c.reqId)).toEqual(['c1', 'c2', 'c3']);
  });

  test('concurrent chooses never overlap on the session', async () => {
    const r = make({ delayMs: 3 });
    await r.send(initChatOnly);
    await r.send({ v: 1, type: 'load' });
    await Promise.all([r.send(chooseMsg('a')), r.send(chooseMsg('b')), r.send(chooseMsg('c'))]);
    expect(r.maxInFlight()).toBe(1);
    expect(chosen(r.out)).toHaveLength(3);
  });

  test('cancel still stops a run within one row while chooses are being served', async () => {
    const r = make({ delayMs: 2 });
    await r.send(initWithLabels);
    await r.send({ v: 1, type: 'load' });
    const run = r.send({ v: 1, type: 'run', runId: 'r1', items: items(100) });
    await new Promise((res) => setTimeout(res, 8));
    const ask = r.send(chooseMsg('c1'));
    await r.send({ v: 1, type: 'cancel', runId: 'r1' });
    await run;
    await ask;
    expect(r.out.find((m) => m.type === 'done')).toMatchObject({ cancelled: true });
    expect(chosen(r.out)).toHaveLength(1);
  });
});
