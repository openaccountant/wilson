import { beforeEach, describe, expect, test } from 'bun:test';
import fixture from './fixtures/hf-onnx-repos.json';
import {
  clearDtypeMetadataCache,
  configDtypeFor,
  DTYPE_FALLBACK_CHAIN,
  dtypesFromFileList,
  onnxFileForDtype,
  pickDtype,
  resolveTransformersDtype,
  TransformersDtypeError,
  type DtypeFetch,
} from '../model/transformers-dtype.js';
import { getModelsForProvider, getTransformersCatalogEntry } from '../utils/model.js';
import { getProviderById } from '../providers.js';
import { resolveTransformersDevice } from '../model/providers/transformers.js';

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

/** A fake Hub serving the recorded fixture (plus any extra repos), counting calls. */
function fakeHub(extra: Record<string, RecordedRepo> = {}, opts: { down?: boolean } = {}) {
  const repos = { ...REPOS, ...extra };
  const calls: string[] = [];
  const fetchImpl: DtypeFetch = async (url) => {
    calls.push(url);
    if (opts.down) throw new TypeError('fetch failed');
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
  return { fetchImpl, calls, hubUrl: 'https://hub.test' };
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
