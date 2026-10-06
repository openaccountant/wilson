import { describe, expect, test } from 'bun:test';
import { chooseToolWithHost } from '../dashboard/ui/src/openjev/choose-tool.js';
import type { ChooseOutcome, ChooseRequest, OpenJevHost } from '../dashboard/ui/src/openjev/host.js';
import { OPEN_JEV_ROUTE_OPTIONS, OPEN_JEV_ROUTE_QUESTION } from '../dashboard/ui/src/hybrid/openjev-route.js';

const PINS = {
  repo: 'onnx-community/open-jev-deberta-v3-large-ONNX',
  dtype: 'q4f16' as const,
  device: 'webgpu' as const,
  temperature: 1.05,
  templateVersion: 'prelabel-tmpl-v1' as const,
  modelId: 'onnx-community/open-jev-deberta-v3-large-ONNX:q4f16',
  revision: '7c79f25b5ac496089f448a969c801872ad59d31c',
  configSha: '2ec35432332ee6b5880509eefe44e6279fd9d3543f6ba96098119ffe0b0c2d5e',
};

function fakeHost(result: ChooseOutcome | null | 'throw') {
  const calls: { req: ChooseRequest; opts: unknown }[] = [];
  const configured: unknown[] = [];
  const host = {
    configure: (p: unknown) => void configured.push(p),
    choose: async (req: ChooseRequest, opts: unknown) => {
      calls.push({ req, opts });
      if (result === 'throw') throw new Error('x');
      return result;
    },
  } as unknown as OpenJevHost;
  return { host, calls, configured };
}

const outcome = (choice: string): ChooseOutcome => ({ choice, p1: 0.75, p2: 0.25, margin: 0.5, top2: [[choice, 0.75], ['forecast', 0.25]], ms: 80 });

describe('chooseToolWithHost', () => {
  test('configures the host with the server pins and asks the frozen question over the five read tools with their descriptions', async () => {
    const f = fakeHost(outcome('net_worth'));
    const r = await chooseToolWithHost(f.host, { question: 'how rich am I', pins: PINS });
    expect(f.configured).toEqual([PINS]);
    expect(f.calls[0].req).toEqual({
      state: 'how rich am I',
      question: OPEN_JEV_ROUTE_QUESTION,
      options: Object.keys(OPEN_JEV_ROUTE_OPTIONS),
      descriptions: { ...OPEN_JEV_ROUTE_OPTIONS },
    });
    expect(f.calls[0].req.options).not.toContain('none');
    expect(r).toEqual({ tool: 'net_worth', p1: 0.75, p2: 0.25, margin: 0.5, top2: [['net_worth', 0.75], ['forecast', 0.25]] });
  });

  test('the state is cut to 512 characters', async () => {
    const f = fakeHost(outcome('net_worth'));
    await chooseToolWithHost(f.host, { question: 'x'.repeat(2000), pins: PINS });
    expect(f.calls[0].req.state).toHaveLength(512);
  });

  test('null from the host, a throw, or a non-tool answer all give null', async () => {
    expect(await chooseToolWithHost(fakeHost(null).host, { question: 'q', pins: PINS })).toBeNull();
    expect(await chooseToolWithHost(fakeHost('throw').host, { question: 'q', pins: PINS })).toBeNull();
    expect(await chooseToolWithHost(fakeHost(outcome('none')).host, { question: 'q', pins: PINS })).toBeNull();
  });

  test('the abort signal is forwarded', async () => {
    const f = fakeHost(outcome('net_worth'));
    const ac = new AbortController();
    await chooseToolWithHost(f.host, { question: 'q', pins: PINS, signal: ac.signal });
    expect((f.calls[0].opts as { signal: unknown }).signal).toBe(ac.signal);
  });

  test('an empty question gives null without asking', async () => {
    const f = fakeHost(outcome('net_worth'));
    expect(await chooseToolWithHost(f.host, { question: '   ', pins: PINS })).toBeNull();
    expect(f.calls).toHaveLength(0);
  });
});
