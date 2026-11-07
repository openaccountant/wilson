import { afterEach, describe, expect, test } from 'bun:test';
import fixture from './fixtures/hf-onnx-repos.json';
import { ensureTestProfile } from './helpers.js';
import { setSetting } from '../utils/config.js';
import { getModelsForProvider, getTransformersCatalogEntry } from '../utils/model.js';
import {
  BROWSER_CHAT_MODEL_KEY,
  MODEL_CACHE_COS_KEY,
  getBrowserChatModelSetting,
  getLocalChatModelConfig,
} from '../model/local-chat.js';
import { createModelEngine, BENCH_MAX_NEW_TOKENS, type TransformersModule } from '../dashboard/ui/src/hybrid/model-engine.js';
import type { CacheLike } from '../dashboard/ui/src/hybrid/model-cache.js';
import { benchStorageKey, isMainToWorker } from '../dashboard/ui/src/hybrid/worker-protocol.js';

/**
 * specs/model-manager.md M2 (revision pins), M3 (LFM3), M4 wiring (custom cache,
 * persist, COS flag), M5 (Browser model setting) and M6 (bench).
 */

const REPOS = (fixture as unknown as { repos: Record<string, { sha: string; files: Record<string, { size: number; sha256?: string }> }> }).repos;
const SHA = /^[0-9a-f]{40}$/;

describe('M2: catalog revision pins', () => {
  for (const entry of getModelsForProvider('transformers')) {
    const repo = entry.id.replace(/^transformers:/, '');
    test(`${repo} pins the commit its fixture was recorded at`, () => {
      expect(entry.revision).toMatch(SHA);
      expect(REPOS[repo]?.sha).toBe(entry.revision!);
    });
  }

  test('every LFS weight file in the fixture carries a sha256 (the COS key)', () => {
    for (const [repo, rec] of Object.entries(REPOS)) {
      for (const [path, f] of Object.entries(rec.files)) {
        if (f.size > 10_000_000) expect({ repo, path, sha256: f.sha256 }).toMatchObject({ sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
      }
    }
  });
});

describe('M3: LFM3 1.7B', () => {
  test('is catalogued as a q4f16 WebGPU model whose weights are external data (no single-file cap)', () => {
    const e = getTransformersCatalogEntry('onnx-community/LFM3-1.7B-ONNX');
    expect(e).toMatchObject({ device: 'webgpu', dtype: 'q4f16' });
    const files = REPOS['onnx-community/LFM3-1.7B-ONNX'].files;
    expect(files['onnx/model_q4f16.onnx'].size).toBeLessThan(1_000_000);
    expect(files['onnx/model_q4f16.onnx_data'].size).toBeGreaterThan(1_000_000_000);
  });
});

describe('local-chat config: revision, cache flag and the Browser model setting', () => {
  ensureTestProfile();
  const prevCos = process.env.WILSON_MODEL_COS;
  afterEach(() => {
    setSetting(BROWSER_CHAT_MODEL_KEY, null);
    setSetting(MODEL_CACHE_COS_KEY, false);
    if (prevCos === undefined) delete process.env.WILSON_MODEL_COS;
    else process.env.WILSON_MODEL_COS = prevCos;
  });

  test('the fastModel path carries the catalog revision and COS off by default', () => {
    const cfg = getLocalChatModelConfig();
    expect(cfg.source).toBe('fastModel');
    expect(cfg.revision).toBe(getTransformersCatalogEntry(cfg.repo)!.revision!);
    expect(cfg.cache).toEqual({ crossOriginStorage: false });
  });

  test('the COS flag comes from the setting, or WILSON_MODEL_COS=1 for local testing', () => {
    setSetting(MODEL_CACHE_COS_KEY, true);
    expect(getLocalChatModelConfig().cache.crossOriginStorage).toBe(true);
    setSetting(MODEL_CACHE_COS_KEY, false);
    process.env.WILSON_MODEL_COS = '1';
    expect(getLocalChatModelConfig().cache.crossOriginStorage).toBe(true);
    process.env.WILSON_MODEL_COS = 'true';
    expect(getLocalChatModelConfig().cache.crossOriginStorage).toBe(false);
  });

  test('a saved Browser model wins over fastModel, revision and dtype included', () => {
    setSetting(BROWSER_CHAT_MODEL_KEY, { repo: 'someone/Custom-ONNX', revision: 'c'.repeat(40), dtype: 'q4', downloadSize: '~1.0GB' });
    const cfg = getLocalChatModelConfig();
    expect(cfg).toMatchObject({
      enabled: true,
      source: 'setting',
      repo: 'someone/Custom-ONNX',
      id: 'transformers:someone/Custom-ONNX',
      revision: 'c'.repeat(40),
      dtype: 'q4',
      downloadSize: '~1.0GB',
      displayName: 'someone/Custom-ONNX',
    });
  });

  test('a malformed setting is ignored, never trusted', () => {
    for (const bad of [
      { repo: 'no-slash', revision: 'c'.repeat(40), dtype: 'q4' },
      { repo: 'a/b', revision: 'main', dtype: 'q4' },
      { repo: 'a/b', revision: 'c'.repeat(40), dtype: 'q9' },
      'a/b',
    ]) {
      setSetting(BROWSER_CHAT_MODEL_KEY, bad);
      expect(getBrowserChatModelSetting()).toBeNull();
      expect(getLocalChatModelConfig().source).toBe('fastModel');
    }
  });
});

// ── Engine wiring ───────────────────────────────────────────────────────────

const PINNED = 'd'.repeat(40);
const MODEL = {
  repo: 'onnx-community/Qwen3-0.6B-ONNX',
  displayName: 'Qwen3',
  catalogDtype: 'q4f16',
  revision: PINNED,
  crossOriginStorage: false,
};

class MemCache implements CacheLike {
  readonly m = new Map<string, Response>();
  async match(k: string) {
    return this.m.get(k)?.clone();
  }
  async put(k: string, r: Response) {
    this.m.set(k, r);
  }
  async delete(k: string) {
    return this.m.delete(k);
  }
  async keys() {
    return [...this.m.keys()].map((url) => ({ url }));
  }
}

function fakeTransformers(opts: { tokensPerStep?: number } = {}) {
  const pipelineCalls: Array<{ repo: string; o: Record<string, unknown> }> = [];
  const env: Record<string, unknown> = { remoteHost: 'https://huggingface.co', version: '4.3.2', backends: { onnx: {} } };
  const tokenizer = {
    apply_chat_template: () => Array.from({ length: 300 }, (_, i) => i),
  };
  class FakeStreamer {
    constructor(
      readonly tok: unknown,
      readonly o: { token_callback_function?: (t: bigint[]) => void },
    ) {}
  }
  const mod = {
    env,
    TextStreamer: FakeStreamer,
    pipeline: async (_task: string, repo: string, o: Record<string, unknown>) => {
      pipelineCalls.push({ repo, o });
      const pipe = async (_messages: unknown, callOpts: { streamer?: FakeStreamer }) => {
        const cb = callOpts.streamer?.o.token_callback_function;
        if (cb) for (let i = 0; i < 10; i++) cb(Array.from({ length: opts.tokensPerStep ?? 1 }, () => 1n));
        return [{ generated_text: [{ role: 'assistant', content: 'OK' }] }];
      };
      return Object.assign(pipe, { tokenizer });
    },
  } as unknown as TransformersModule;
  return { mod, env, pipelineCalls };
}

describe('engine: revision, custom cache, persist, bench', () => {
  test('loads the pinned revision through the custom cache and reports persist()', async () => {
    const f = fakeTransformers();
    const cache = new MemCache();
    let persistCalls = 0;
    const engine = createModelEngine({
      loadTransformers: async () => f.mod,
      openCache: async () => cache,
      storage: () => ({ persisted: async () => false, persist: async () => (++persistCalls, true) }),
      manifestFetch: async () => new Response('[]'),
    });
    engine.setModel(MODEL, 'http://127.0.0.1:3000');
    const res = await engine.load();
    expect(f.pipelineCalls[0].o.revision).toBe(PINNED);
    expect(f.env.useCustomCache).toBe(true);
    expect(typeof (f.env.customCache as { match?: unknown }).match).toBe('function');
    expect(res.cache).toMatchObject({ cosActive: false, persisted: true });
    // A second load in the same worker neither re-asks persist() nor re-reports.
    const again = await engine.load();
    expect(persistCalls).toBe(1);
    expect(again.loadFresh).toBe(false);
    expect(again.cache).toBeUndefined();
  });

  test('without a pin the engine loads main (older servers) and passes no revision', async () => {
    const f = fakeTransformers();
    const engine = createModelEngine({ loadTransformers: async () => f.mod, openCache: null });
    engine.setModel({ ...MODEL, revision: null }, 'http://127.0.0.1:3000');
    await engine.load();
    expect('revision' in f.pipelineCalls[0].o).toBe(false);
    expect(f.env.useCustomCache).toBeUndefined();
  });

  test('COS is offered to the cache only when the config enables it', async () => {
    const f = fakeTransformers();
    let cosAsked = 0;
    const engine = createModelEngine({
      loadTransformers: async () => f.mod,
      openCache: async () => new MemCache(),
      cos: () => (++cosAsked, { getFileHandle: async () => { throw Object.assign(new Error(), { name: 'NotFoundError' }); } }),
      storage: () => undefined,
      manifestFetch: async () => new Response('[]'),
    });
    engine.setModel(MODEL, 'http://127.0.0.1:3000');
    expect((await engine.load()).cache?.cosActive).toBe(false);
    expect(cosAsked).toBe(0);
    engine.setModel({ ...MODEL, repo: 'onnx-community/LFM3-1.7B-ONNX', crossOriginStorage: true }, 'http://127.0.0.1:3000');
    expect((await engine.load()).cache).toMatchObject({ cosActive: true, persisted: null });
    expect(cosAsked).toBe(1);
  });

  test('bench measures first token and decode rate from the streamer', async () => {
    const f = fakeTransformers();
    let t = 0;
    const engine = createModelEngine({
      loadTransformers: async () => f.mod,
      openCache: null,
      // Each clock read advances 10 ms: t0, then 10 token callbacks, then tEnd.
      now: () => (t += 10),
    });
    engine.setModel(MODEL, 'http://127.0.0.1:3000');
    const r = await engine.bench();
    expect(r).toMatchObject({
      repo: MODEL.repo,
      revision: PINNED,
      dtype: 'q4f16',
      promptTokens: 300,
      newTokens: 10,
      firstTokenMs: 10,
      transformersVersion: '4.3.2',
    });
    // 9 tokens after the first, over 90 ms.
    expect(r.decodeTokPerSec).toBeCloseTo(100, 5);
    expect(BENCH_MAX_NEW_TOKENS).toBe(128);
  });

  test('cacheStats and cacheClear work before any load', async () => {
    const f = fakeTransformers();
    const cache = new MemCache();
    const url = `https://huggingface.co/${MODEL.repo}/resolve/${PINNED}/onnx/model_q4f16.onnx`;
    await cache.put(url, new Response('xx', { headers: { 'content-length': '2' } }));
    const engine = createModelEngine({ loadTransformers: async () => f.mod, openCache: async () => cache, manifestFetch: async () => new Response('[]') });
    engine.setModel(MODEL, 'http://127.0.0.1:3000');
    const s = await engine.cacheStats();
    expect(s.groups[0]).toMatchObject({ repo: MODEL.repo, revision: PINNED, bytes: 2 });
    expect(await engine.cacheClear(MODEL.repo)).toEqual({ removed: 1 });
    expect((await engine.cacheStats()).groups).toEqual([]);
  });
});

describe('protocol', () => {
  test('new messages validate; a non-sha revision is refused', () => {
    expect(isMainToWorker({ t: 'cacheStats', id: 1 })).toBe(true);
    expect(isMainToWorker({ t: 'bench', id: 1 })).toBe(true);
    expect(isMainToWorker({ t: 'cacheClear', id: 1, repo: 'a/b' })).toBe(true);
    expect(isMainToWorker({ t: 'cacheClear', id: 1, repo: '' })).toBe(false);
    const init = { t: 'init', v: 1, origin: 'http://x', model: { ...MODEL } };
    expect(isMainToWorker(init)).toBe(true);
    expect(isMainToWorker({ ...init, model: { ...MODEL, revision: 'main' } })).toBe(false);
    expect(isMainToWorker({ ...init, model: { ...MODEL, crossOriginStorage: 'yes' } })).toBe(false);
  });

  test('bench storage key names repo, revision and dtype', () => {
    expect(benchStorageKey('a/b', PINNED, 'q4')).toBe(`wilson-bench:v1:a/b@${PINNED}:q4`);
    expect(benchStorageKey('a/b', null, null)).toBe('wilson-bench:v1:a/b@main:auto');
  });
});
