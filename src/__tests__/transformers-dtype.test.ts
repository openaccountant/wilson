import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fixture from './fixtures/hf-onnx-repos.json';
import {
  clearDtypeMetadataCache,
  configDtypeFor,
  corruptCacheError,
  DTYPE_FALLBACK_CHAIN,
  dtypesFromFileList,
  fetchOnnxTreeSizes,
  findCacheSizeMismatches,
  isCorruptModelFileError,
  onnxFileForDtype,
  pickDtype,
  resolveTransformersDtype,
  TransformersCacheError,
  TransformersDtypeError,
  type DtypeFetch,
} from '../model/transformers-dtype.js';
import { getModelsForProvider, getTransformersCatalogEntry } from '../utils/model.js';
import { getProviderById } from '../providers.js';
import {
  cachedOnnxFileSizes,
  explainModelLoadError,
  listCachedDtypes,
  modelCachePath,
  resolveTransformersDevice,
} from '../model/providers/transformers.js';

/**
 * The shared dtype resolver used by BOTH Transformers.js loaders (server
 * adapter + browser hybrid client). Transformers.js loads exactly
 * onnx/model_<dtype>.onnx and fails with "Could not locate file" when that
 * file is missing (the granite-4.0-micro-ONNX-web / fp16 bug), so every path
 * here is about never requesting a file the repo does not publish.
 */

interface RecordedRepo {
  siblings: string[];
  'transformers.js_config': unknown;
}
const REPOS = (fixture as { repos: Record<string, RecordedRepo> }).repos;

/**
 * A fake Hub serving the recorded fixture (plus any extra repos), counting
 * calls and recording request headers. `status` forces every response to that
 * HTTP status; `tree` serves api/models/<repo>/tree/main/onnx listings.
 */
function fakeHub(
  extra: Record<string, RecordedRepo> = {},
  opts: { down?: boolean; status?: number; tree?: Record<string, unknown[]> } = {},
) {
  const repos = { ...REPOS, ...extra };
  const calls: string[] = [];
  const headers: (Record<string, string> | undefined)[] = [];
  const fetchImpl: DtypeFetch = async (url, init) => {
    calls.push(url);
    headers.push(init?.headers);
    if (opts.down) throw new TypeError('fetch failed');
    if (opts.status) return { ok: opts.status < 300, status: opts.status, json: async () => ({}) };
    const tree = /\/api\/models\/(.+)\/tree\/main\/onnx$/.exec(url);
    if (tree) {
      const listing = opts.tree?.[decodeURIComponent(tree[1])];
      return listing ? { ok: true, status: 200, json: async () => listing } : { ok: false, status: 404, json: async () => ({}) };
    }
    const api = /\/api\/models\/(.+)$/.exec(url);
    const cfg = /^https:\/\/hub\.test\/(.+)\/resolve\/main\/config\.json$/.exec(url);
    const repo = decodeURIComponent((api ?? cfg)?.[1] ?? '');
    const rec = repos[repo];
    if (!rec) return { ok: false, status: 404, json: async () => ({}) };
    if (api) {
      return { ok: true, status: 200, json: async () => ({ siblings: rec.siblings.map((rfilename) => ({ rfilename })) }) };
    }
    return { ok: true, status: 200, json: async () => ({ 'transformers.js_config': rec['transformers.js_config'] }) };
  };
  return { fetchImpl, calls, headers, hubUrl: 'https://hub.test' };
}

beforeEach(() => clearDtypeMetadataCache());

describe('dtypesFromFileList', () => {
  test('maps transformers.js file suffixes and ignores external-data chunks', () => {
    const got = dtypesFromFileList([
      'onnx/model.onnx',
      'onnx/model.onnx_data',
      'onnx/model_fp16.onnx',
      'onnx/model_quantized.onnx',
      'onnx/model_q4f16.onnx',
      'onnx/model_q4f16.onnx_data_1',
      'onnx/model_q4.onnx',
      'onnx/model_q8.onnx', // non-standard name transformers.js cannot request
      'model.onnx', // root-level export, not loadable
      'onnx/decoder_model_merged.onnx',
    ]);
    expect([...got].sort()).toEqual(['fp16', 'fp32', 'q4', 'q4f16', 'q8']);
  });

  test('granite-4.0-micro-ONNX-web publishes only q4f16 (the reported bug)', () => {
    const got = dtypesFromFileList(REPOS['onnx-community/granite-4.0-micro-ONNX-web'].siblings);
    expect([...got]).toEqual(['q4f16']);
    expect(got.has('fp16')).toBe(false);
  });

  test('onnxFileForDtype round-trips', () => {
    expect(onnxFileForDtype('fp32')).toBe('onnx/model.onnx');
    expect(onnxFileForDtype('q8')).toBe('onnx/model_quantized.onnx');
    expect(onnxFileForDtype('q4f16')).toBe('onnx/model_q4f16.onnx');
  });
});

describe('configDtypeFor', () => {
  test('reads the repo default and applies the device_config overlay', () => {
    expect(configDtypeFor({ dtype: 'q4f16' }, 'webgpu')).toBe('q4f16');
    expect(configDtypeFor({ dtype: 'q4', device_config: { webgpu: { dtype: 'q4f16' } } }, 'webgpu')).toBe('q4f16');
    expect(configDtypeFor({ dtype: 'q4', device_config: { webgpu: { dtype: 'q4f16' } } }, 'cpu')).toBe('q4');
    expect(configDtypeFor({ dtype: { model: 'fp16' } }, 'webgpu')).toBe('fp16');
    expect(configDtypeFor({ use_external_data_format: true }, 'cpu')).toBeUndefined();
    expect(configDtypeFor(undefined, 'cpu')).toBeUndefined();
    expect(configDtypeFor({ dtype: 'nonsense' }, 'cpu')).toBeUndefined();
  });
});

describe('pickDtype', () => {
  test('repo-declared default wins when present and suitable', () => {
    expect(pickDtype({ repo: 'r', device: 'cpu', available: ['fp32', 'q4', 'q4f16'], configDtype: 'q4f16' })).toBe('q4f16');
  });

  test('a config default unsuitable for the device is skipped (q8 never on webgpu)', () => {
    expect(pickDtype({ repo: 'r', device: 'webgpu', available: ['q8', 'fp16'], configDtype: 'q8' })).toBe('fp16');
  });

  test('walks the webgpu chain: q4f16 > fp16 > q4 > fp32', () => {
    expect(pickDtype({ repo: 'r', device: 'webgpu', available: ['fp32', 'q4', 'fp16', 'q4f16'] })).toBe('q4f16');
    expect(pickDtype({ repo: 'r', device: 'webgpu', available: ['fp32', 'q4', 'fp16'] })).toBe('fp16');
    expect(pickDtype({ repo: 'r', device: 'webgpu', available: ['fp32', 'q4'] })).toBe('q4');
    expect(pickDtype({ repo: 'r', device: 'webgpu', available: ['fp32', 'int8'] })).toBe('fp32');
  });

  test('walks the cpu chain: q4 > q4f16 > int8 > q8 > uint8 > fp32', () => {
    expect(pickDtype({ repo: 'r', device: 'cpu', available: [...DTYPE_FALLBACK_CHAIN.cpu] })).toBe('q4');
    expect(pickDtype({ repo: 'r', device: 'cpu', available: ['q4f16', 'fp32'] })).toBe('q4f16');
    expect(pickDtype({ repo: 'r', device: 'cpu', available: ['uint8', 'q8'] })).toBe('q8');
  });

  test('a GPU without shader-f16 skips f16 weights', () => {
    expect(pickDtype({ repo: 'r', device: 'webgpu', available: ['q4f16', 'fp16', 'q4'], shaderF16: false })).toBe('q4');
  });

  test('no onnx files → clear error naming the onnx/ folder requirement', () => {
    try {
      pickDtype({ repo: 'ibm-granite/granite-4.1-3b-onnx', device: 'webgpu', available: [] });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(TransformersDtypeError);
      expect((err as TransformersDtypeError).code).toBe('no-onnx-weights');
      expect((err as Error).message).toContain('no ONNX weights for ibm-granite/granite-4.1-3b-onnx');
      expect((err as Error).message).toContain('onnx/');
    }
  });

  test('nothing usable for the device → "no ONNX weights for <repo> in any of: …"', () => {
    expect(() => pickDtype({ repo: 'x/y', device: 'webgpu', available: ['int8', 'uint8'] })).toThrow(
      'no ONNX weights for x/y in any of: q4f16, fp16, q4, fp32',
    );
  });

  test('a q4f16-only repo on a GPU without shader-f16 → requires-shader-f16', () => {
    try {
      pickDtype({ repo: 'onnx-community/granite-4.0-micro-ONNX-web', device: 'webgpu', available: ['q4f16'], shaderF16: false });
      throw new Error('expected throw');
    } catch (err) {
      expect((err as TransformersDtypeError).code).toBe('requires-shader-f16');
      expect((err as Error).message).toContain('shader-f16');
    }
  });
});

describe('resolveTransformersDtype', () => {
  test('catalog hit: returns the pin without any network call', async () => {
    const hub = fakeHub();
    const res = await resolveTransformersDtype('onnx-community/granite-4.0-micro-ONNX-web', 'webgpu', {
      catalogDtype: 'q4f16',
      ...hub,
    });
    expect(res).toEqual({ dtype: 'q4f16', source: 'catalog' });
    expect(hub.calls).toEqual([]);
  });

  test('transformers.js_config hit: granite-micro (uncatalogued call) resolves to its declared q4f16', async () => {
    const hub = fakeHub();
    const res = await resolveTransformersDtype('onnx-community/granite-4.0-micro-ONNX-web', 'webgpu', hub);
    expect(res).toEqual({ dtype: 'q4f16', source: 'config' });
  });

  test('transformers.js_config hit: SmolLM3 declares q4', async () => {
    const res = await resolveTransformersDtype('HuggingFaceTB/SmolLM3-3B-ONNX', 'cpu', fakeHub());
    expect(res).toEqual({ dtype: 'q4', source: 'config' });
  });

  test('fallback walk over a mocked file list (no config dtype)', async () => {
    const hub = fakeHub({
      'someone/custom-ONNX': {
        siblings: ['onnx/model.onnx', 'onnx/model_fp16.onnx', 'onnx/model_q4.onnx'],
        'transformers.js_config': { use_external_data_format: { 'model.onnx': true } },
      },
    });
    expect(await resolveTransformersDtype('someone/custom-ONNX', 'webgpu', hub)).toEqual({ dtype: 'fp16', source: 'fallback' });
    expect(await resolveTransformersDtype('someone/custom-ONNX', 'cpu', hub)).toEqual({ dtype: 'q4', source: 'fallback' });
  });

  test('Hub metadata is fetched once per repo and cached', async () => {
    const hub = fakeHub();
    await resolveTransformersDtype('onnx-community/Qwen3-0.6B-ONNX', 'webgpu', hub);
    await resolveTransformersDtype('onnx-community/Qwen3-0.6B-ONNX', 'cpu', hub);
    expect(hub.calls.filter((u) => u.includes('/api/models/'))).toHaveLength(1);
  });

  test('missing onnx/ folder → clear error, before any model download', async () => {
    const hub = fakeHub({
      'ibm-granite/granite-4.1-3b-genai': {
        siblings: ['genai_config.json', 'model.onnx', 'model.onnx.data', 'tokenizer.json'],
        'transformers.js_config': undefined,
      },
    });
    await expect(resolveTransformersDtype('ibm-granite/granite-4.1-3b-genai', 'webgpu', hub)).rejects.toThrow(
      'no ONNX weights for ibm-granite/granite-4.1-3b-genai',
    );
  });

  test('no shader-f16: a catalog q4f16 pin downgrades to q4 when the repo has it', async () => {
    const res = await resolveTransformersDtype('onnx-community/Qwen3-0.6B-ONNX', 'webgpu', {
      catalogDtype: 'q4f16',
      shaderF16: false,
      ...fakeHub(),
    });
    expect(res.dtype).toBe('q4');
  });

  test('no shader-f16: granite-micro (q4f16 only) fails with a clear shader-f16 message', async () => {
    await expect(
      resolveTransformersDtype('onnx-community/granite-4.0-micro-ONNX-web', 'webgpu', {
        catalogDtype: 'q4f16',
        shaderF16: false,
        ...fakeHub(),
      }),
    ).rejects.toThrow('shader-f16');
  });

  test('Hub unreachable: walks the chain over locally cached dtypes', async () => {
    const res = await resolveTransformersDtype('someone/offline-ONNX', 'webgpu', {
      ...fakeHub({}, { down: true }),
      localDtypes: async () => ['fp32', 'fp16'],
    });
    expect(res).toEqual({ dtype: 'fp16', source: 'local-cache' });
  });

  test("Hub unreachable and nothing cached: 'auto' (transformers.js honours the config dtype)", async () => {
    const res = await resolveTransformersDtype('someone/offline-ONNX', 'cpu', {
      ...fakeHub({}, { down: true }),
      localDtypes: async () => [],
    });
    expect(res).toEqual({ dtype: 'auto', source: 'auto' });
  });

  test('a failed Hub fetch is not cached', async () => {
    const down = fakeHub({}, { down: true });
    await resolveTransformersDtype('onnx-community/Qwen3-0.6B-ONNX', 'webgpu', down);
    const up = fakeHub();
    expect(await resolveTransformersDtype('onnx-community/Qwen3-0.6B-ONNX', 'webgpu', up)).toEqual({
      dtype: 'q4f16',
      source: 'fallback',
    });
  });
});

describe('catalog pin vs. the local cache (offline)', () => {
  const QWEN = 'onnx-community/Qwen3-0.6B-ONNX'; // default fastModel, pinned q4f16 on webgpu

  test('pin already cached: returned without any network call', async () => {
    const hub = fakeHub();
    const res = await resolveTransformersDtype(QWEN, 'webgpu', {
      catalogDtype: 'q4f16',
      ...hub,
      localDtypes: async () => ['q4f16', 'q4'],
    });
    expect(res).toEqual({ dtype: 'q4f16', source: 'catalog' });
    expect(hub.calls).toEqual([]);
  });

  test('pin not cached, Hub reachable: still the pin (online behaviour unchanged)', async () => {
    const hub = fakeHub();
    const res = await resolveTransformersDtype(QWEN, 'webgpu', {
      catalogDtype: 'q4f16',
      ...hub,
      localDtypes: async () => ['fp32', 'q4'],
    });
    expect(res).toEqual({ dtype: 'q4f16', source: 'catalog' });
    expect(hub.calls.filter((u) => u.includes('/api/models/'))).toHaveLength(1);
  });

  test('pin not cached, Hub unreachable: loads the cached dtype, walking the device chain', async () => {
    // The verifier's case: cache holds model.onnx + model_q4.onnx, pin is q4f16.
    const res = await resolveTransformersDtype(QWEN, 'webgpu', {
      catalogDtype: 'q4f16',
      ...fakeHub({}, { down: true }),
      localDtypes: async () => ['fp32', 'q4'],
    });
    expect(res).toEqual({ dtype: 'q4', source: 'local-cache' });
  });

  test('pin not cached, Hub 5xx: same offline fallback', async () => {
    const res = await resolveTransformersDtype(QWEN, 'cpu', {
      catalogDtype: 'q4',
      ...fakeHub({}, { status: 503 }),
      localDtypes: async () => ['fp32', 'q8'],
    });
    expect(res).toEqual({ dtype: 'q8', source: 'local-cache' });
  });

  test('pin not cached, offline, nothing usable cached: falls back to the pin', async () => {
    const res = await resolveTransformersDtype(QWEN, 'webgpu', {
      catalogDtype: 'q4f16',
      ...fakeHub({}, { down: true }),
      localDtypes: async () => ['int8'],
    });
    expect(res).toEqual({ dtype: 'q4f16', source: 'catalog' });
  });

  test('a throwing cache probe counts as "nothing cached"', async () => {
    const res = await resolveTransformersDtype(QWEN, 'webgpu', {
      catalogDtype: 'q4f16',
      ...fakeHub({}, { down: true }),
      localDtypes: async () => {
        throw new Error('EACCES');
      },
    });
    expect(res).toEqual({ dtype: 'q4f16', source: 'catalog' });
  });

  test('pin not cached and the repo is gone (404): clear error instead of a doomed download', async () => {
    await expect(
      resolveTransformersDtype('someone/deleted-ONNX', 'webgpu', {
        catalogDtype: 'q4f16',
        ...fakeHub(),
        localDtypes: async () => [],
      }),
    ).rejects.toThrow('repo not found or gated: someone/deleted-ONNX');
  });
});

describe('server cache listing (listCachedDtypes / cachedOnnxFileSizes)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oa-models-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const repo = 'onnx-community/Qwen3-0.6B-ONNX';
  const onnx = join(dir, repo, 'onnx');
  mkdirSync(onnx, { recursive: true });
  writeFileSync(join(onnx, 'model.onnx'), 'x'.repeat(10));
  writeFileSync(join(onnx, 'model.onnx_data'), 'x'.repeat(50));
  writeFileSync(join(onnx, 'model_q4.onnx'), 'x'.repeat(20));
  writeFileSync(join(onnx, 'model_q4f16.onnx.tmp.123.abc'), 'partial'); // in-flight download

  test('lists dtypes from the cache folder, ignoring in-flight temp files', async () => {
    expect((await listCachedDtypes(repo, dir)).sort()).toEqual(['fp32', 'q4']);
    expect(await listCachedDtypes(`transformers:${repo}`, dir)).toHaveLength(2);
    expect(await listCachedDtypes('nobody/nothing', dir)).toEqual([]);
  });

  test('sizes every cached onnx/ file, skipping temp files', async () => {
    const sizes = await cachedOnnxFileSizes(repo, dir);
    expect(Object.fromEntries(sizes)).toEqual({
      'onnx/model.onnx': 10,
      'onnx/model.onnx_data': 50,
      'onnx/model_q4.onnx': 20,
    });
  });

  test('modelCachePath mirrors the transformers.js FileCache layout', () => {
    expect(modelCachePath(`transformers:${repo}`, dir)).toBe(join(dir, repo));
  });
});

describe('damaged cache diagnosis', () => {
  // Verbatim shape of the ORT error for a 770 MB copy of a 2.09 GB file.
  const ORT_TRUNCATED = new Error(
    'Deserialize tensor model.layers.27.mlp.down_proj.MatMul.weight_Q4 failed.tensorprotoutils.cc:1067 ' +
      'GetExtDataFromTensorProto External initializer: model.layers.27.mlp.down_proj.MatMul.weight_Q4 ' +
      'offset: 2071986176 size to read: 4718592 given file_length: 770703360 are out of bounds or can not be read in full.',
  );

  test('recognises truncated/corrupt model errors and nothing else', () => {
    expect(isCorruptModelFileError(ORT_TRUNCATED)).toBe(true);
    expect(isCorruptModelFileError(new Error('Load model from x failed:Protobuf parsing failed.'))).toBe(true);
    expect(isCorruptModelFileError(new Error('Could not locate file: "https://hub/x/onnx/model_fp16.onnx".'))).toBe(false);
    expect(isCorruptModelFileError(new TypeError('fetch failed'))).toBe(false);
    expect(isCorruptModelFileError(undefined)).toBe(false);
  });

  test('the error names the repo and the folder to delete, and lists size mismatches', () => {
    const err = corruptCacheError('onnx-community/granite-4.0-micro-ONNX-web', '/home/u/.openaccountant/models/x', ORT_TRUNCATED, [
      { path: 'onnx/model_q4f16.onnx_data', localSize: 770_703_360, remoteSize: 2_090_000_000 },
    ]);
    expect(err).toBeInstanceOf(TransformersCacheError);
    expect(err.message).toContain('onnx-community/granite-4.0-micro-ONNX-web');
    expect(err.message).toContain('Delete /home/u/.openaccountant/models/x');
    expect(err.message).toContain('onnx/model_q4f16.onnx_data is 770.7 MB, expected 2.09 GB');
    expect(err.message).toContain('out of bounds');
    expect(err.cause).toBe(ORT_TRUNCATED);
  });

  test('fetchOnnxTreeSizes prefers the LFS size; findCacheSizeMismatches compares only known files', async () => {
    const repo = 'onnx-community/granite-4.0-micro-ONNX-web';
    const hub = fakeHub({}, {
      tree: {
        [repo]: [
          { type: 'file', path: 'onnx/model_q4f16.onnx', size: 300 },
          { type: 'file', path: 'onnx/model_q4f16.onnx_data', size: 134, lfs: { size: 2_090_000_000 } },
          { type: 'directory', path: 'onnx/sub' },
        ],
      },
    });
    const remote = await fetchOnnxTreeSizes(repo, hub);
    expect(Object.fromEntries(remote)).toEqual({ 'onnx/model_q4f16.onnx': 300, 'onnx/model_q4f16.onnx_data': 2_090_000_000 });
    const local = new Map([
      ['onnx/model_q4f16.onnx', 300],
      ['onnx/model_q4f16.onnx_data', 770_703_360],
      ['onnx/model_extra.onnx', 1],
    ]);
    expect(findCacheSizeMismatches(local, remote)).toEqual([
      { path: 'onnx/model_q4f16.onnx_data', localSize: 770_703_360, remoteSize: 2_090_000_000 },
    ]);
  });

  test('explainModelLoadError: corrupt → TransformersCacheError with mismatches; other errors pass through', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oa-models-'));
    try {
      const repo = 'someone/truncated-ONNX';
      mkdirSync(join(dir, repo, 'onnx'), { recursive: true });
      writeFileSync(join(dir, repo, 'onnx', 'model_q4.onnx_data'), 'x'.repeat(7));
      const hub = fakeHub({}, { tree: { [repo]: [{ type: 'file', path: 'onnx/model_q4.onnx_data', size: 9 }] } });

      const explained = await explainModelLoadError(repo, ORT_TRUNCATED, { dir, hub });
      expect(explained).toBeInstanceOf(TransformersCacheError);
      expect((explained as Error).message).toContain(`Delete ${join(dir, repo)}`);
      expect((explained as Error).message).toContain('onnx/model_q4.onnx_data is 7 B, expected 9 B');

      // Offline: still a clear message, just without the size list.
      const offline = await explainModelLoadError(repo, ORT_TRUNCATED, { dir, hub: fakeHub({}, { down: true }) });
      expect((offline as Error).message).toContain(`Delete ${join(dir, repo)}`);
      expect((offline as Error).message).not.toContain('Size mismatch');

      const other = new Error('WebGPU is not available');
      expect(await explainModelLoadError(repo, other, { dir, hub })).toBe(other);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Hub 401/404 vs. outages', () => {
  test('404 → repo-not-found error, not a silent fp32 download', async () => {
    try {
      await resolveTransformersDtype('someone/typo-ONNX', 'webgpu', fakeHub());
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(TransformersDtypeError);
      expect((err as TransformersDtypeError).code).toBe('repo-not-found');
      expect((err as Error).message).toContain('repo not found or gated: someone/typo-ONNX');
      expect((err as Error).message).toContain('HF_TOKEN');
    }
  });

  test('401 (unauthenticated / gated) → repo-not-found, even with a local cache probe', async () => {
    await expect(
      resolveTransformersDtype('meta/gated-ONNX', 'cpu', { ...fakeHub({}, { status: 401 }), localDtypes: async () => ['q4'] }),
    ).rejects.toThrow('repo not found or gated: meta/gated-ONNX (Hub answered HTTP 401)');
  });

  test('5xx and 429 are outages: degrade to the cache / auto', async () => {
    expect(await resolveTransformersDtype('a/b', 'webgpu', fakeHub({}, { status: 502 }))).toEqual({ dtype: 'auto', source: 'auto' });
    clearDtypeMetadataCache();
    expect(
      await resolveTransformersDtype('a/b', 'webgpu', { ...fakeHub({}, { status: 429 }), localDtypes: async () => ['fp16'] }),
    ).toEqual({ dtype: 'fp16', source: 'local-cache' });
  });

  test('hubToken is sent as a Bearer header on every Hub request; never without one', async () => {
    const withToken = fakeHub();
    await resolveTransformersDtype('onnx-community/Qwen3-0.6B-ONNX', 'webgpu', { ...withToken, hubToken: 'hf_secret' });
    expect(withToken.headers.length).toBeGreaterThan(0);
    for (const h of withToken.headers) expect(h).toEqual({ Authorization: 'Bearer hf_secret' });

    clearDtypeMetadataCache();
    const anon = fakeHub();
    await resolveTransformersDtype('onnx-community/Qwen3-0.6B-ONNX', 'webgpu', anon);
    for (const h of anon.headers) expect(h).toBeUndefined();
  });
});

describe('model catalog dtype pins', () => {
  const entries = getModelsForProvider('transformers');

  test('every catalog repo has a recorded Hub fixture', () => {
    for (const e of entries) expect(REPOS[e.id.replace(/^transformers:/, '')]).toBeDefined();
  });

  for (const entry of entries) {
    const repo = entry.id.replace(/^transformers:/, '');

    test(`${repo}: pins a device and a dtype the repo actually publishes`, () => {
      expect(entry.device).toBeDefined();
      expect(entry.dtype).toBeDefined();
      const published = REPOS[repo].siblings;
      expect(published).toContain(onnxFileForDtype(entry.dtype!));
    });

    test(`${repo}: the pin is what the resolver itself would choose from the Hub`, () => {
      const available = dtypesFromFileList(REPOS[repo].siblings);
      const configDtype = configDtypeFor(REPOS[repo]['transformers.js_config'], entry.device!);
      expect(pickDtype({ repo, device: entry.device!, available, configDtype })).toBe(entry.dtype!);
    });

    test(`${repo}: 'webgpu' tag agrees with device, and the server routes it there`, () => {
      expect(entry.tags?.includes('webgpu') ?? false).toBe(entry.device === 'webgpu');
      expect(resolveTransformersDevice(repo)).toBe(entry.device!);
      expect(resolveTransformersDevice(entry.id)).toBe(entry.device!);
    });
  }

  test('fastModel is a webgpu entry with a WebGPU-suitable dtype', () => {
    const fast = getTransformersCatalogEntry(getProviderById('transformers')!.fastModel!);
    expect(fast?.device).toBe('webgpu');
    expect(DTYPE_FALLBACK_CHAIN.webgpu as readonly string[]).toContain(fast!.dtype!);
  });

  test('uncatalogued repos fall back to the legacy name patterns', () => {
    expect(resolveTransformersDevice('someone/thing-ONNX-web')).toBe('webgpu');
    expect(resolveTransformersDevice('someone/thing-ONNX')).toBe('cpu');
  });
});
