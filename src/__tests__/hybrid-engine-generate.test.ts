import { describe, expect, test } from 'bun:test';
import { createModelEngine, type TransformersModule } from '../dashboard/ui/src/hybrid/model-engine.js';

/**
 * ModelEngine.generate: the one primitive the subagent loop needs (system +
 * user in, assistant text out) with a token cap and an interrupt. Driven with a
 * fake transformers module; the real InterruptableStoppingCriteria is a
 * transformers.js class, so the fake mirrors its `interrupt()` contract.
 */

const MODEL = { repo: 'onnx-community/Qwen3-0.6B-ONNX', displayName: 'Qwen3', catalogDtype: 'q4f16' };

class FakeCriteria {
  interrupted = false;
  interrupt() {
    this.interrupted = true;
  }
}

function fake(opts: { onCall?: (messages: unknown, o: Record<string, unknown>) => void; text?: string; failOn?: number } = {}) {
  const criteria: FakeCriteria[] = [];
  let calls = 0;
  const mod = {
    env: { remoteHost: 'https://hub.test', backends: { onnx: {} } },
    InterruptableStoppingCriteria: class extends FakeCriteria {
      constructor() {
        super();
        criteria.push(this);
      }
    },
    pipeline: async () => async (messages: unknown, o: Record<string, unknown>) => {
      calls++;
      if (opts.failOn !== undefined && calls === opts.failOn) throw new Error('OrtRun failed');
      opts.onCall?.(messages, o);
      return [{ generated_text: [{ role: 'assistant', content: opts.text ?? 'ANSWER' }] }];
    },
  } as unknown as TransformersModule;
  return { mod, criteria };
}

async function engineFor(f: ReturnType<typeof fake>) {
  const engine = createModelEngine({ loadTransformers: async () => f.mod });
  engine.setModel(MODEL, 'http://127.0.0.1:3000');
  await engine.load();
  return engine;
}

describe('engine.generate', () => {
  test('sends system + user, greedy, with the requested token cap, and returns the assistant text', async () => {
    let seen: { messages: unknown; o: Record<string, unknown> } | null = null;
    const f = fake({ text: 'profit_loss', onCall: (messages, o) => (seen = { messages, o }) });
    // warmup is call 1; only the generate call is recorded after load.
    const engine = await engineFor(f);
    seen = null;
    const out = await engine.generate({ system: 'SYS', user: 'USR', maxNewTokens: 12 });
    expect(out).toBe('profit_loss');
    expect(seen!.messages).toEqual([
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'USR' },
    ]);
    expect(seen!.o.max_new_tokens).toBe(12);
    expect(seen!.o.do_sample).toBe(false);
  });

  test('aborting the signal interrupts generation through InterruptableStoppingCriteria', async () => {
    const f = fake();
    const engine = await engineFor(f);
    const ac = new AbortController();
    const p = engine.generate({ system: 's', user: 'u', maxNewTokens: 5, signal: ac.signal });
    ac.abort();
    await p;
    expect(f.criteria.length).toBe(1);
    expect(f.criteria[0].interrupted).toBe(true);
  });

  test('an already-aborted signal interrupts immediately', async () => {
    const f = fake();
    const engine = await engineFor(f);
    const ac = new AbortController();
    ac.abort();
    await engine.generate({ system: 's', user: 'u', maxNewTokens: 5, signal: ac.signal });
    expect(f.criteria[0].interrupted).toBe(true);
  });

  test('a module without InterruptableStoppingCriteria still generates (no interrupt support)', async () => {
    const f = fake();
    delete (f.mod as unknown as { InterruptableStoppingCriteria?: unknown }).InterruptableStoppingCriteria;
    const engine = await engineFor(f);
    const ac = new AbortController();
    expect(await engine.generate({ system: 's', user: 'u', maxNewTokens: 5, signal: ac.signal })).toBe('ANSWER');
  });

  test('a generation failure is an EngineError with phase generate', async () => {
    const f = fake({ failOn: 2 }); // call 1 = warmup
    const engine = await engineFor(f);
    await expect(engine.generate({ system: 's', user: 'u', maxNewTokens: 5 })).rejects.toMatchObject({
      info: { phase: 'generate', message: 'OrtRun failed' },
    });
  });
});
