import { afterEach, describe, expect, test } from 'bun:test';
import fixture from './fixtures/hf-onnx-repos.json';
import { ensureTestProfile } from './helpers.js';
import {
  checkBrowserModelUpdates,
  filesForDtype,
  formatBytes,
  resetBrowserModel,
  saveBrowserModel,
  textGenerationDtypes,
  validateBrowserModel,
  type HubFetch,
} from '../model/browser-models.js';
import { getLocalChatModelConfig } from '../model/local-chat.js';
import { extractCausalLmTypes, readInstalledTransformers, TFJS_MODEL_TYPES } from '../model/tfjs-model-types.js';
import { getTransformersCatalogEntry } from '../utils/model.js';

/** specs/model-manager.md M5: validate any public Hub repo for the in-tab WebGPU path. */

interface Rec {
  sha: string;
  files: Record<string, { size: number; sha256?: string }>;
  model_type: string | null;
  'transformers.js_config': unknown;
  license: string | null;
  pipeline_tag: string | null;
}
const REPOS = (fixture as unknown as { repos: Record<string, Rec> }).repos;
const base = REPOS['onnx-community/Qwen3-0.6B-ONNX'];

const json = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

/** A fake Hub serving the recorded fixture, plus overrides, counting requests. */
function fakeHub(extra: Record<string, Partial<Rec> & { status?: number; gated?: boolean; private?: boolean; mainSha?: string }> = {}) {
  const urls: string[] = [];
  const fetch: HubFetch = async (url) => {
    urls.push(url);
    const m = /^https:\/\/huggingface\.co\/(?:api\/models\/)?([^/]+\/[^/]+)\/(revision|tree|resolve)\/([^/?]+)/.exec(url);
    if (!m) return json(404, {});
    const [, repo, kind, rev] = m;
    const over = extra[repo];
    const base = REPOS[repo];
    if (!base && !over) return json(404, { error: 'Repository not found' });
    if (over?.status) return json(over.status, {});
    const rec = { ...(base ?? {}), ...(over ?? {}) } as Rec & { gated?: boolean; private?: boolean; mainSha?: string };
    const sha = rev === 'main' ? (rec.mainSha ?? rec.sha) : rev;
    if (kind === 'revision') {
      return json(200, { sha, pipeline_tag: rec.pipeline_tag ?? undefined, cardData: rec.license ? { license: rec.license } : {}, gated: rec.gated ?? false, private: rec.private ?? false });
    }
    if (kind === 'tree') {
      return json(200, Object.entries(rec.files ?? {}).map(([path, f]) => ({ type: 'file', path, size: f.size, ...(f.sha256 ? { lfs: { oid: f.sha256, size: f.size } } : {}) })));
    }
    return json(200, { model_type: rec.model_type, 'transformers.js_config': rec['transformers.js_config'] ?? undefined });
  };
  return { fetch, urls };
}

describe('validateBrowserModel', () => {
  test('LFM3 1.7B: pinned to the commit, q4f16 sharded, size and license reported', async () => {
    const hub = fakeHub();
    const v = await validateBrowserModel({ repo: 'onnx-community/LFM3-1.7B-ONNX' }, { fetch: hub.fetch });
    expect(v.errors).toEqual([]);
    expect(v).toMatchObject({
      ok: true,
      revision: REPOS['onnx-community/LFM3-1.7B-ONNX'].sha,
      dtype: 'q4f16',
      modelType: 'lfm3',
      license: 'other',
      downloadSize: '~1.1GB',
      catalog: true,
    });
    // Everything after the first request is read at the resolved sha, never main.
    expect(hub.urls.slice(1).every((u) => u.includes(v.revision!))).toBe(true);
  });

  test('every catalog WebGPU repo validates to its catalog dtype at its pin', async () => {
    const hub = fakeHub();
    for (const repo of ['onnx-community/Qwen3-0.6B-ONNX', 'LiquidAI/LFM2.5-1.2B-Instruct-ONNX', 'onnx-community/granite-4.0-350m-ONNX-web', 'onnx-community/gemma-4-E2B-it-ONNX']) {
      const pin = getTransformersCatalogEntry(repo)!;
      const v = await validateBrowserModel({ repo, revision: pin.revision }, { fetch: hub.fetch });
      expect({ repo, errors: v.errors }).toEqual({ repo, errors: [] });
      expect({ repo, rev: v.revision }).toEqual({ repo, rev: pin.revision! });
    }
  });

  test('Qwen3 1.7B q4f16 is refused: one 1.4 GB file (#154)', async () => {
    const v = await validateBrowserModel({ repo: 'onnx-community/Qwen3-1.7B-ONNX' }, { fetch: fakeHub().fetch });
    expect(v.ok).toBe(false);
    expect(v.errors[0]).toContain('single');
    expect(v.errors[0]).toContain('#154');
  });

  test('accepts a pasted huggingface.co URL', async () => {
    const v = await validateBrowserModel({ repo: 'https://huggingface.co/onnx-community/Qwen3-0.6B-ONNX/' }, { fetch: fakeHub().fetch });
    expect(v).toMatchObject({ ok: true, repo: 'onnx-community/Qwen3-0.6B-ONNX' });
  });

  const cases: Array<[string, Record<string, Partial<Rec> & { status?: number; gated?: boolean; private?: boolean }>, string, string]> = [
    ['missing repo', {}, 'nobody/nothing-ONNX', 'not found'],
    ['gated', { 'x/gated': { ...base, gated: true } }, 'x/gated', 'gated'],
    ['private (Hub 401)', { 'x/priv': { status: 401 } }, 'x/priv', 'private'],
    ['Hub outage', { 'x/down': { status: 503 } }, 'x/down', 'HTTP 503'],
    ['not a chat model', { 'x/asr': { ...base, pipeline_tag: 'automatic-speech-recognition' } }, 'x/asr', 'automatic-speech-recognition'],
    ['unsupported architecture', { 'x/arch': { ...base, model_type: 'not_a_real_arch' } }, 'x/arch', 'not_a_real_arch'],
    ['no ONNX weights', { 'x/none': { ...base, files: { 'onnx/README.md': { size: 1 } } } }, 'x/none', 'no onnx/model'],
    ['only CPU dtypes', { 'x/q8': { ...base, files: { 'onnx/model_quantized.onnx': { size: 10 } } } }, 'x/q8', 'run on WebGPU'],
  ];
  for (const [name, extra, repo, msg] of cases) {
    test(`refuses: ${name}`, async () => {
      const v = await validateBrowserModel({ repo }, { fetch: fakeHub(extra).fetch });
      expect(v.ok).toBe(false);
      expect(v.errors.join(' ')).toContain(msg);
    });
  }

  test('bad input never reaches the Hub', async () => {
    const hub = fakeHub();
    for (const repo of ['', 'noslash', '../etc/passwd', 'a/b/c']) {
      expect((await validateBrowserModel({ repo }, { fetch: hub.fetch })).ok).toBe(false);
    }
    expect((await validateBrowserModel({ repo: 'a/b', revision: 'v1' }, { fetch: hub.fetch })).ok).toBe(false);
    expect(hub.urls).toEqual([]);
  });

  test('multimodal tags pass when the architecture runs as text generation (Gemma 4 is any-to-any)', async () => {
    const v = await validateBrowserModel({ repo: 'x/mm' }, { fetch: fakeHub({ 'x/mm': { ...base, pipeline_tag: 'image-text-to-text' } }).fetch });
    expect(v.ok).toBe(true);
    expect(v.warnings.join(' ')).toContain('text only');
  });

  test('a repo with no license is allowed with a warning', async () => {
    const v = await validateBrowserModel({ repo: 'x/nolicense' }, { fetch: fakeHub({ 'x/nolicense': { ...base, license: null } }).fetch });
    expect(v.ok).toBe(true);
    expect(v.warnings.join(' ')).toContain('no license');
  });
});

describe('save, reset and update check', () => {
  ensureTestProfile();
  afterEach(() => resetBrowserModel());

  test('saving a catalog repo keeps its vetted pin, dtype and display name', async () => {
    const r = await saveBrowserModel({ repo: 'onnx-community/LFM3-1.7B-ONNX' }, { fetch: fakeHub().fetch });
    expect(r.ok).toBe(true);
    const cfg = getLocalChatModelConfig();
    expect(cfg).toMatchObject({ source: 'setting', repo: 'onnx-community/LFM3-1.7B-ONNX', dtype: 'q4f16', displayName: 'LFM3 1.7B (WebGPU)' });
    expect(cfg.revision).toBe(getTransformersCatalogEntry('onnx-community/LFM3-1.7B-ONNX')!.revision!);
  });

  test('a custom repo is pinned to the sha main pointed at when it was added', async () => {
    const hub = fakeHub({ 'me/custom': { ...base, mainSha: 'e'.repeat(40) } });
    const r = await saveBrowserModel({ repo: 'me/custom' }, { fetch: hub.fetch });
    expect(r.ok).toBe(true);
    expect(getLocalChatModelConfig()).toMatchObject({ repo: 'me/custom', revision: 'e'.repeat(40), dtype: 'q4f16', downloadSize: '~570MB' });
  });

  test('an invalid repo is not saved', async () => {
    const r = await saveBrowserModel({ repo: 'onnx-community/Qwen3-1.7B-ONNX' }, { fetch: fakeHub().fetch });
    expect(r.ok).toBe(false);
    expect(getLocalChatModelConfig().source).toBe('fastModel');
  });

  test('updates: reports a newer main commit without changing the pin', async () => {
    await saveBrowserModel({ repo: 'me/custom' }, { fetch: fakeHub({ 'me/custom': { ...base, mainSha: 'e'.repeat(40) } }).fetch });
    const later = fakeHub({ 'me/custom': { ...base, mainSha: 'f'.repeat(40) } });
    expect(await checkBrowserModelUpdates({ fetch: later.fetch })).toEqual([
      { repo: 'me/custom', pinned: 'e'.repeat(40), latest: 'f'.repeat(40), updateAvailable: true },
    ]);
    expect(getLocalChatModelConfig().revision).toBe('e'.repeat(40));
  });
});

describe('helpers', () => {
  test('text-generation dtypes cover single- and multi-session exports', () => {
    expect([...textGenerationDtypes(['onnx/model_q4f16.onnx', 'onnx/model_q4f16.onnx_data', 'onnx/model.onnx'])].sort()).toEqual(['fp32', 'q4f16']);
    expect([...textGenerationDtypes(['onnx/decoder_model_merged_q4.onnx', 'onnx/embed_tokens_q4.onnx'])]).toEqual(['q4']);
  });

  test('filesForDtype includes external-data shards and both text sessions', () => {
    expect(filesForDtype(['onnx/model_q4f16.onnx', 'onnx/model_q4f16.onnx_data', 'onnx/model_q4f16.onnx_data_1', 'onnx/model_q4.onnx'], 'q4f16')).toEqual([
      'onnx/model_q4f16.onnx',
      'onnx/model_q4f16.onnx_data',
      'onnx/model_q4f16.onnx_data_1',
    ]);
    expect(filesForDtype(['onnx/embed_tokens_q4.onnx', 'onnx/decoder_model_merged_q4.onnx', 'onnx/vision_encoder_q4.onnx'], 'q4')).toEqual([
      'onnx/embed_tokens_q4.onnx',
      'onnx/decoder_model_merged_q4.onnx',
    ]);
  });

  test('formatBytes', () => {
    expect(formatBytes(1_088_085_770)).toBe('~1.1GB');
    expect(formatBytes(569_789_750)).toBe('~570MB');
  });

  test('tfjs-model-types.json matches the installed transformers.js (run scripts/gen-tfjs-model-types.ts after a bump)', () => {
    const { version, dist } = readInstalledTransformers();
    expect(TFJS_MODEL_TYPES.version).toBe(version);
    expect(TFJS_MODEL_TYPES.causalLm).toEqual(extractCausalLmTypes(dist));
    for (const t of ['lfm3', 'qwen3', 'gemma4', 'granitemoehybrid']) expect(TFJS_MODEL_TYPES.causalLm).toContain(t);
  });
});
