import { describe, expect, test, beforeAll, afterAll, afterEach } from 'bun:test';
import { createOpenAI } from '@ai-sdk/openai';
import { ensureTestProfile } from './helpers.js';
import { VercelAiAdapter } from '../model/providers/vercel-ai.js';
import { callLlm, withRetry } from '../model/llm.js';
import { getLocalLlmTimeoutMs } from '../model/local-timeout.js';

// Stub OpenAI-compatible server that holds every response for `delayMs`
// (a slow local model), counting the requests it receives.
let delayMs = 5_000;
let requests = 0;
let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    idleTimeout: 0,
    async fetch() {
      requests++;
      await Bun.sleep(delayMs);
      // OpenAI Responses-API shape (what createOpenAI()(model) calls).
      return Response.json({
        id: 'resp_1',
        object: 'response',
        created_at: 0,
        model: 'm',
        output: [
          {
            type: 'message',
            id: 'msg_1',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'late', annotations: [] }],
          },
        ],
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    },
  });
});

afterAll(() => server.stop(true));

const savedEnv = { base: process.env.OLLAMA_BASE_URL, timeout: process.env.OA_LOCAL_LLM_TIMEOUT_MS };
afterEach(() => {
  requests = 0;
  delayMs = 5_000;
  if (savedEnv.base === undefined) delete process.env.OLLAMA_BASE_URL;
  else process.env.OLLAMA_BASE_URL = savedEnv.base;
  if (savedEnv.timeout === undefined) delete process.env.OA_LOCAL_LLM_TIMEOUT_MS;
  else process.env.OA_LOCAL_LLM_TIMEOUT_MS = savedEnv.timeout;
});

function stubAdapter() {
  return new VercelAiAdapter((m) =>
    createOpenAI({ apiKey: 'k', baseURL: `http://localhost:${server.port}/v1` })(m),
  );
}

describe('getLocalLlmTimeoutMs', () => {
  test('defaults to a long explicit value, overridable by env, 0 disables', () => {
    delete process.env.OA_LOCAL_LLM_TIMEOUT_MS;
    expect(getLocalLlmTimeoutMs()).toBeGreaterThan(5 * 60_000);
    process.env.OA_LOCAL_LLM_TIMEOUT_MS = '1234';
    expect(getLocalLlmTimeoutMs()).toBe(1234);
    process.env.OA_LOCAL_LLM_TIMEOUT_MS = '0';
    expect(getLocalLlmTimeoutMs()).toBeUndefined();
    process.env.OA_LOCAL_LLM_TIMEOUT_MS = 'junk';
    expect(getLocalLlmTimeoutMs()).toBeGreaterThan(5 * 60_000);
  });
});

describe('VercelAiAdapter timeoutMs', () => {
  test('aborts a slow response with a timeout error at the configured limit', async () => {
    const t0 = Date.now();
    const err = await stubAdapter()
      .call({ model: 'm', systemPrompt: 's', userPrompt: 'u', timeoutMs: 150 })
      .catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(String(err.message)).toMatch(/timed out/i);
    expect(Date.now() - t0).toBeLessThan(2_000);
  });

  test('a caller abort still wins and is not reported as a timeout', async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(new Error('user cancelled')), 100);
    const err = await stubAdapter()
      .call({ model: 'm', systemPrompt: 's', userPrompt: 'u', timeoutMs: 60_000, signal: ac.signal })
      .catch((e) => e);
    expect(String(err?.message ?? err)).not.toMatch(/timed out/i);
  });

  test('a response inside the limit succeeds', async () => {
    delayMs = 50;
    const res = await stubAdapter().call({ model: 'm', systemPrompt: 's', userPrompt: 'u', timeoutMs: 5_000 });
    expect(res.content).toBe('late');
  });
});

describe('callLlm local timeout', () => {
  test('a client-side timeout against ollama is not retried', async () => {
    ensureTestProfile();
    process.env.OLLAMA_BASE_URL = `http://localhost:${server.port}`;
    process.env.OA_LOCAL_LLM_TIMEOUT_MS = '150';
    const err = await callLlm('hi', { model: 'ollama:stub-model' }).catch((e) => e);
    expect(String(err.message)).toMatch(/timed out/i);
    expect(requests).toBe(1);
  });

  test('aborting the caller signal stops callLlm without retrying', async () => {
    ensureTestProfile();
    process.env.OLLAMA_BASE_URL = `http://localhost:${server.port}`;
    process.env.OA_LOCAL_LLM_TIMEOUT_MS = '60000';
    const ac = new AbortController();
    setTimeout(() => ac.abort(new Error('user cancelled')), 100);
    const t0 = Date.now();
    await callLlm('hi', { model: 'ollama:stub-model', signal: ac.signal }).catch(() => {});
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(requests).toBe(1);
  });
});

describe('withRetry slow local failures', () => {
  // What ended the #202 calls at 5–6 min is not known; Ollama may answer with
  // a plain 500 that no pattern classifies. Elapsed time is the signal.
  const failAfter = (ms: number, message: string) => {
    let calls = 0;
    const fn = async () => {
      calls++;
      await Bun.sleep(ms);
      throw new Error(message);
    };
    return { fn, calls: () => calls };
  };

  test('a slow failure with an unclassified message is not retried', async () => {
    const f = failAfter(120, 'Internal Server Error');
    const err = await withRetry(f.fn, 'Ollama', 3, { noRetryAfterMs: 100 }).catch((e) => e);
    expect(String(err.message)).toContain('Internal Server Error');
    expect(f.calls()).toBe(1);
  });

  test('a fast failure is still retried', async () => {
    const f = failAfter(0, 'Internal Server Error');
    await withRetry(f.fn, 'Ollama', 3, { noRetryAfterMs: 100 }).catch(() => {});
    expect(f.calls()).toBe(3);
  });

  test('without noRetryAfterMs a slow failure is retried as before', async () => {
    const f = failAfter(120, 'context canceled');
    await withRetry(f.fn, 'OpenAI', 2).catch(() => {});
    expect(f.calls()).toBe(2);
  });
});
