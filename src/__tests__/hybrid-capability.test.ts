import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import {
  capabilityKey,
  classifyLoadFailure,
  describeLoadFailure,
  HYBRID_RESOLVER_VERSION,
  parsePersistedCapability,
  restoreCapability,
} from '../dashboard/ui/src/hybrid/capability.js';
import { localUnavailableNotice } from '../dashboard/ui/src/hybrid/core.js';
import {
  CAPABILITY_STORAGE_KEY,
  createHybridChat,
  type LocalChatConfigResponse,
  type TransformersModule,
} from '../dashboard/ui/src/hybrid/client.js';
import { clearDtypeMetadataCache, TransformersDtypeError, type DtypeFetch } from '../model/transformers-dtype.js';
import { installLocalChatOptIn } from './local-chat-optin-helper.js';

/**
 * Browser hybrid chat: which local-model failures stick for the session, how
 * the persisted verdict is keyed, and that every failure carries its reason.
 *
 * Background: the old client persisted `{verdict:'failed', repo}` for ANY load
 * failure and swallowed the cause, so a tab that hit the pre-resolver fp16 bug
 * kept local chat disabled after the fix, with nothing in the console.
 */

const REPO = 'onnx-community/Qwen3-0.6B-ONNX';
const CFG: LocalChatConfigResponse = {
  enabled: true,
  id: `transformers:${REPO}`,
  repo: REPO,
  displayName: 'Qwen3 0.6B',
  downloadSize: '~570MB',
  dtype: 'q4f16',
  bundle: { days: 30, limit: 200, maxChars: 6000 },
};
const KEY = capabilityKey(CFG);

// ── pure helpers ─────────────────────────────────────────────────────────

describe('verdict keying', () => {
  test('the key covers resolver version, repo and catalog dtype', () => {
    expect(KEY).toBe(`v${HYBRID_RESOLVER_VERSION}|${REPO}|q4f16`);
    expect(capabilityKey({ repo: REPO, dtype: 'q4' })).not.toBe(KEY);
    expect(capabilityKey({ repo: 'other/repo', dtype: 'q4f16' })).not.toBe(KEY);
    expect(capabilityKey({ repo: REPO, dtype: null })).toBe(`v${HYBRID_RESOLVER_VERSION}|${REPO}|resolve`);
  });

  test("a 'failed' verdict only sticks for the exact config it was recorded for", () => {
    const failed = { verdict: 'failed' as const, key: KEY, detail: 'requires shader-f16' };
    expect(restoreCapability(failed, KEY)).toBe('failed');
    expect(restoreCapability(failed, capabilityKey({ repo: REPO, dtype: 'q4' }))).toBe('unknown');
    expect(restoreCapability(failed, null)).toBe('unknown');
  });

  test("legacy unkeyed records (the old fp16 bug) are dropped; 'unavailable' always sticks", () => {
    const legacy = parsePersistedCapability(JSON.stringify({ verdict: 'failed', repo: REPO }));
    expect(legacy?.key).toBeNull();
    expect(restoreCapability(legacy, KEY)).toBe('unknown');
    const noGpu = parsePersistedCapability(JSON.stringify({ verdict: 'unavailable', repo: null }));
    expect(restoreCapability(noGpu, null)).toBe('unavailable');
    expect(restoreCapability(noGpu, KEY)).toBe('unavailable');
  });

  test('malformed storage is ignored', () => {
    expect(parsePersistedCapability(null)).toBeNull();
    expect(parsePersistedCapability('{nope')).toBeNull();
    expect(parsePersistedCapability(JSON.stringify({ verdict: 'unknown' }))).toBeNull();
  });
});

describe('classifyLoadFailure', () => {
  const dtypeErr = (code: ConstructorParameters<typeof TransformersDtypeError>[1]) =>
    new TransformersDtypeError('x', code, REPO);

  test('dtype capability errors stick; repo-not-found retries', () => {
    expect(classifyLoadFailure(dtypeErr('requires-shader-f16'), 'resolve')).toBe('capability');
    expect(classifyLoadFailure(dtypeErr('no-usable-dtype'), 'resolve')).toBe('capability');
    expect(classifyLoadFailure(dtypeErr('no-onnx-weights'), 'resolve')).toBe('capability');
    expect(classifyLoadFailure(dtypeErr('repo-not-found'), 'resolve')).toBe('transient');
  });

  test('network, 404 and damaged-cache failures retry', () => {
    expect(classifyLoadFailure(new TypeError('Failed to fetch'), 'load')).toBe('transient');
    expect(classifyLoadFailure(new Error('Could not locate file: "https://huggingface.co/x/onnx/model_fp16.onnx".'), 'load')).toBe(
      'transient',
    );
    expect(classifyLoadFailure(new Error('HTTP status 503'), 'load')).toBe('transient');
    expect(classifyLoadFailure(new Error('Deserialize tensor w failed … are out of bounds or can not be read in full.'), 'load')).toBe(
      'transient',
    );
    expect(classifyLoadFailure(new Error('anything'), 'resolve')).toBe('transient');
  });

  test('wasm memory and shape errors are not mistaken for a damaged cache or HTTP failure', () => {
    expect(classifyLoadFailure(new RangeError('memory access out of bounds'), 'load')).toBe('capability');
    expect(classifyLoadFailure(new RangeError('offset is out of bounds'), 'load')).toBe('capability');
    expect(classifyLoadFailure(new Error('input dims 500 mismatched'), 'load')).toBe('capability');
  });

  test('session-creation and warmup failures are capability failures', () => {
    expect(classifyLoadFailure(new Error('no available backend found. ERR: [webgpu] ...'), 'load')).toBe('capability');
    expect(classifyLoadFailure(new Error('Failed to fetch'), 'warmup')).toBe('capability');
  });

  test('describeLoadFailure is human-readable', () => {
    expect(describeLoadFailure(dtypeErr('requires-shader-f16'), REPO, null)).toBe('x');
    expect(describeLoadFailure(new Error('boom\nstack'), REPO, 'q4f16')).toBe(`failed to load ${REPO} (q4f16): boom`);
    expect(describeLoadFailure(new Error('Deserialize tensor w failed … can not be read in full.'), REPO, 'q4f16')).toContain('incomplete or corrupt');
  });

  test('localUnavailableNotice formats and clips the chat note', () => {
    expect(localUnavailableNotice(undefined)).toBeNull();
    expect(localUnavailableNotice('  ')).toBeNull();
    expect(localUnavailableNotice('requires shader-f16')).toBe('Local model unavailable: requires shader-f16');
    const long = localUnavailableNotice('x'.repeat(500), 50)!;
    expect(long.endsWith('…')).toBe(true);
    expect(long.length).toBeLessThan(80);
  });
});

// ── client integration (browser globals stubbed) ─────────────────────────

class MemoryStorage {
  data = new Map<string, string>();
  getItem(k: string) {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.data.set(k, v);
  }
  removeItem(k: string) {
    this.data.delete(k);
  }
}

let storage: MemoryStorage;
const savedNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
const savedStorage = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');

function setGpu(shaderF16: boolean): void {
  const adapter = { features: { has: (f: string) => f === 'shader-f16' && shaderF16 } };
  Object.defineProperty(globalThis, 'navigator', {
    value: { gpu: { requestAdapter: async () => adapter } },
    configurable: true,
    writable: true,
  });
}

let optIn: ReturnType<typeof installLocalChatOptIn>;
beforeEach(() => {
  // This browser opted in to on-device chat (consent.ts); the server config says enabled.
  optIn = installLocalChatOptIn(REPO);
  clearDtypeMetadataCache();
  storage = new MemoryStorage();
  Object.defineProperty(globalThis, 'sessionStorage', { value: storage, configurable: true, writable: true });
  setGpu(true);
});

afterEach(() => {
  if (savedNavigator) Object.defineProperty(globalThis, 'navigator', savedNavigator);
  if (savedStorage) Object.defineProperty(globalThis, 'sessionStorage', savedStorage);
  else delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
  optIn.restore();
});

/** Dashboard API stub: config + an (empty) bundle + local-chat recording. */
function dashboardFetch(cfg: LocalChatConfigResponse = CFG) {
  return async (input: string): Promise<Response> => {
    if (input.endsWith('/api/config/local-chat')) return Response.json(cfg);
    if (input.includes('/api/transactions')) return Response.json([]);
    if (input.endsWith('/api/weekly-summary')) {
      return Response.json({ thisWeek: { total: 0 }, lastWeek: { total: 0 }, change: { amount: 0, percent: 0 } });
    }
    if (input.endsWith('/api/chat/local')) return Response.json({ sessionId: 's1' });
    return new Response('not found', { status: 404 });
  };
}

/** Fake transformers.js: `failWith` throws from pipeline() (load) or from the warmup generation. */
function fakeTransformers(opts: { failWith?: unknown; failAt?: 'load' | 'warmup' } = {}) {
  const loads: { repo: string; dtype: unknown }[] = [];
  const mod: TransformersModule = {
    env: { remoteHost: 'https://hub.test', backends: { onnx: {} } },
    pipeline: async (_task: string, repo: string, o: { dtype: unknown }) => {
      loads.push({ repo, dtype: o.dtype });
      if (opts.failWith && (opts.failAt ?? 'load') === 'load') throw opts.failWith;
      let calls = 0;
      return async () => {
        calls += 1;
        if (calls === 1 && opts.failWith && opts.failAt === 'warmup') throw opts.failWith;
        return [{ generated_text: [{ role: 'assistant', content: 'You spent $0 this week.' }] }];
      };
    },
  };
  return { loads, loadTransformers: async () => mod };
}

function stored() {
  return parsePersistedCapability(storage.getItem(CAPABILITY_STORAGE_KEY));
}

describe('createHybridChat load failures', () => {
  test('a stale unkeyed failed verdict (old fp16 bug) is retried and succeeds', async () => {
    storage.setItem(CAPABILITY_STORAGE_KEY, JSON.stringify({ verdict: 'failed', repo: REPO }));
    const tf = fakeTransformers();
    const chat = createHybridChat({ baseUrl: '', fetchImpl: dashboardFetch(), loadTransformers: tf.loadTransformers });

    const r = await chat.tryLocal('how much did I spend?');
    expect(r.ok).toBe(true);
    expect(tf.loads).toEqual([{ repo: REPO, dtype: 'q4f16' }]);
    expect(stored()).toMatchObject({ verdict: 'ready', key: KEY });
  });

  test('a failed verdict for THIS config short-circuits and still reports why', async () => {
    storage.setItem(
      CAPABILITY_STORAGE_KEY,
      JSON.stringify({ verdict: 'failed', key: KEY, repo: REPO, detail: 'needs shader-f16' }),
    );
    const tf = fakeTransformers();
    const chat = createHybridChat({ baseUrl: '', fetchImpl: dashboardFetch(), loadTransformers: tf.loadTransformers });

    expect(await chat.tryLocal('q')).toEqual({ ok: false, detail: 'needs shader-f16' });
    expect(tf.loads).toEqual([]);
  });

  test('a failed verdict for a different dtype is retried', async () => {
    storage.setItem(
      CAPABILITY_STORAGE_KEY,
      JSON.stringify({ verdict: 'failed', key: capabilityKey({ repo: REPO, dtype: 'fp16' }), detail: 'old' }),
    );
    const tf = fakeTransformers();
    const chat = createHybridChat({ baseUrl: '', fetchImpl: dashboardFetch(), loadTransformers: tf.loadTransformers });
    expect((await chat.tryLocal('q')).ok).toBe(true);
    expect(tf.loads).toHaveLength(1);
  });

  test('a network failure is warned, carried as detail, NOT persisted — the next attempt retries', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const tf = fakeTransformers({ failWith: new TypeError('Failed to fetch') });
      const chat = createHybridChat({ baseUrl: '', fetchImpl: dashboardFetch(), loadTransformers: tf.loadTransformers });

      const r1 = await chat.tryLocal('q');
      expect(r1.ok).toBe(false);
      expect(!r1.ok && r1.detail).toContain('Failed to fetch');
      expect(warn).toHaveBeenCalled();
      expect(String(warn.mock.calls[0][0])).toContain('local model load failed');
      expect(stored()?.verdict).not.toBe('failed');

      await chat.tryLocal('q');
      expect(tf.loads).toHaveLength(2);
    } finally {
      warn.mockRestore();
    }
  });

  test('a warmup (capability) failure persists failed keyed to the config, with its detail', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const tf = fakeTransformers({ failWith: new Error('GPU device lost'), failAt: 'warmup' });
      const chat = createHybridChat({ baseUrl: '', fetchImpl: dashboardFetch(), loadTransformers: tf.loadTransformers });

      const r1 = await chat.tryLocal('q');
      expect(!r1.ok && r1.detail).toContain('GPU device lost');
      expect(stored()).toMatchObject({ verdict: 'failed', key: KEY });

      const r2 = await chat.tryLocal('q');
      expect(!r2.ok && r2.detail).toContain('GPU device lost');
      expect(tf.loads).toHaveLength(1);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  test('no shader-f16 + q4f16-only repo: the shader-f16 reason reaches the caller', async () => {
    setGpu(false);
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const granite = 'onnx-community/granite-4.0-micro-ONNX-web';
      // The opt-in is per repo: this browser agreed to download this model too.
      optIn.restore();
      optIn = installLocalChatOptIn(REPO, granite);
      const hubFetch: DtypeFetch = async (url) =>
        url.includes('/api/models/')
          ? { ok: true, status: 200, json: async () => ({ siblings: [{ rfilename: 'onnx/model_q4f16.onnx' }] }) }
          : { ok: false, status: 404, json: async () => ({}) };
      const tf = fakeTransformers();
      const chat = createHybridChat({
        baseUrl: '',
        fetchImpl: dashboardFetch({ ...CFG, repo: granite, dtype: 'q4f16' }),
        loadTransformers: tf.loadTransformers,
        hubFetch,
      });

      const r = await chat.tryLocal('q');
      expect(!r.ok && r.detail).toContain('shader-f16');
      expect(tf.loads).toEqual([]);
      expect(stored()?.verdict).toBe('failed');
    } finally {
      warn.mockRestore();
    }
  });

  test('categorizeSample carries the same detail', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const tf = fakeTransformers({ failWith: new Error('Could not locate file: "x"') });
      const chat = createHybridChat({ baseUrl: '', fetchImpl: dashboardFetch(), loadTransformers: tf.loadTransformers });
      const res = await chat.categorizeSample({ systemPrompt: 's', userPrompt: 'u' });
      expect(res.ok).toBe(false);
      expect(res.reason).toBe('failed');
      expect(res.detail).toContain('Could not locate file');
    } finally {
      warn.mockRestore();
    }
  });
});
