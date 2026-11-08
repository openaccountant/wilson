import { describe, expect, test } from 'bun:test';
import {
  apiErrorText,
  benchRows,
  cachedRepos,
  canApplyUpdate,
  canUseValidated,
  formatBytes,
  hasCrossOriginStorage,
  hybridCapabilities,
  missingNote,
  modelSourceLabel,
  parseRepoInput,
  persistenceLine,
  shortSha,
  sortCacheGroups,
  updateLine,
  type BenchResultLike,
  type BrowserModelCurrent,
  type BrowserModelValidation,
} from '../dashboard/ui/src/lib/browserModel.js';

/**
 * Settings > Models > Browser model card (specs/model-manager.md M5 UI). The UI package has no component test
 * runner, so the card's decisions and labels live in ui/src/lib/browserModel.ts and are tested here.
 */

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

function current(over: Partial<BrowserModelCurrent> = {}): BrowserModelCurrent {
  return {
    enabled: true,
    id: 'transformers:onnx-community/gemma-4-E2B-it-ONNX',
    repo: 'onnx-community/gemma-4-E2B-it-ONNX',
    displayName: 'Gemma 4 E2B',
    downloadSize: '~1.5GB',
    dtype: 'q4f16',
    revision: A,
    source: 'fastModel',
    ...over,
  };
}

const catalog = [{ id: 'transformers:onnx-community/gemma-4-E2B-it-ONNX', repo: 'onnx-community/gemma-4-E2B-it-ONNX', displayName: 'Gemma 4 E2B', dtype: 'q4f16', revision: A, downloadSize: '~1.5GB' }];

function validation(over: Partial<BrowserModelValidation> = {}): BrowserModelValidation {
  return {
    ok: true,
    repo: 'owner/model-ONNX',
    revision: B,
    dtype: 'q4',
    bytes: 900e6,
    downloadSize: '~900MB',
    license: 'apache-2.0',
    modelType: 'llama',
    catalog: false,
    errors: [],
    warnings: [],
    ...over,
  };
}

describe('shortSha / formatBytes', () => {
  test('7-char revision, dash when missing', () => {
    expect(shortSha(A)).toBe('aaaaaaa');
    expect(shortSha(null)).toBe('—');
    expect(shortSha('')).toBe('—');
  });
  test('bytes in GB / MB / KB', () => {
    expect(formatBytes(1_234_000_000)).toBe('1.2 GB');
    expect(formatBytes(350_400_000)).toBe('350 MB');
    expect(formatBytes(12_000)).toBe('12 KB');
    expect(formatBytes(10)).toBe('10 B');
    expect(formatBytes(null)).toBe('—');
    expect(formatBytes(Number.NaN)).toBe('—');
  });
});

describe('modelSourceLabel', () => {
  test('provider default, catalog, custom, none', () => {
    expect(modelSourceLabel({ current: current(), catalog })).toBe('provider default');
    expect(modelSourceLabel({ current: current({ source: 'setting' }), catalog })).toBe('catalog');
    expect(modelSourceLabel({ current: current({ source: 'setting', repo: 'owner/other' }), catalog })).toBe('custom');
    expect(modelSourceLabel({ current: current({ enabled: false, source: 'none' }), catalog })).toBe('none');
  });
});

describe('parseRepoInput', () => {
  test('owner/name as typed', () => {
    expect(parseRepoInput('  onnx-community/Qwen3-0.6B-ONNX ')).toEqual({ repo: 'onnx-community/Qwen3-0.6B-ONNX' });
  });
  test('pasted huggingface.co links', () => {
    expect(parseRepoInput('https://huggingface.co/onnx-community/Qwen3-0.6B-ONNX')).toEqual({ repo: 'onnx-community/Qwen3-0.6B-ONNX' });
    expect(parseRepoInput('huggingface.co/onnx-community/Qwen3-0.6B-ONNX/')).toEqual({ repo: 'onnx-community/Qwen3-0.6B-ONNX' });
    expect(parseRepoInput('https://huggingface.co/owner/name/tree/main/onnx?x=1')).toEqual({ repo: 'owner/name' });
    expect(parseRepoInput('https://huggingface.co/owner/name#readme')).toEqual({ repo: 'owner/name' });
  });
  test('a link that names a commit keeps it as the revision', () => {
    expect(parseRepoInput(`https://huggingface.co/owner/name/tree/${B}`)).toEqual({ repo: 'owner/name', revision: B });
    expect(parseRepoInput(`https://huggingface.co/owner/name/blob/${B}/config.json`)).toEqual({ repo: 'owner/name', revision: B });
  });
  test('not a model id', () => {
    expect(parseRepoInput('')).toBeNull();
    expect(parseRepoInput('justaname')).toBeNull();
    expect(parseRepoInput('https://huggingface.co/')).toBeNull();
    expect(parseRepoInput('own er/na me')).toBeNull();
  });
});

describe('canUseValidated', () => {
  test('only a passed validation of what is in the input now', () => {
    expect(canUseValidated(validation(), 'owner/model-ONNX')).toBe(true);
    expect(canUseValidated(validation(), 'https://huggingface.co/owner/model-ONNX')).toBe(true);
    expect(canUseValidated(validation(), 'owner/edited')).toBe(false);
    expect(canUseValidated(validation({ ok: false, errors: ['nope'] }), 'owner/model-ONNX')).toBe(false);
    expect(canUseValidated(validation({ revision: null }), 'owner/model-ONNX')).toBe(false);
    expect(canUseValidated(null, 'owner/model-ONNX')).toBe(false);
  });
});

describe('cache helpers', () => {
  const groups = [
    { repo: 'x/small', revision: B, files: [1], bytes: 10 },
    { repo: 'x/big', revision: B, files: [1, 2], bytes: 1000 },
    { repo: 'onnx-community/gemma-4-E2B-it-ONNX', revision: A, files: [1], bytes: 5 },
    { repo: 'x/small', revision: A, files: [1], bytes: 20 },
  ];
  test('current model first, then largest first', () => {
    const sorted = sortCacheGroups(groups, current());
    expect(sorted.map((g) => `${g.repo}@${g.revision[0]}`)).toEqual([
      'onnx-community/gemma-4-E2B-it-ONNX@a',
      'x/big@b',
      'x/small@a',
      'x/small@b',
    ]);
    expect(sortCacheGroups(groups, null)[0].repo).toBe('x/big');
  });
  test('repos summed across revisions, order kept', () => {
    expect(cachedRepos(sortCacheGroups(groups, current()))).toEqual([
      { repo: 'onnx-community/gemma-4-E2B-it-ONNX', bytes: 5, revisions: 1 },
      { repo: 'x/big', bytes: 1000, revisions: 1 },
      { repo: 'x/small', bytes: 30, revisions: 2 },
    ]);
  });
  test('persistence line', () => {
    expect(persistenceLine(true)).toContain('Storage is persistent');
    expect(persistenceLine(false)).toContain('Storage may be evicted');
    expect(persistenceLine(null)).toContain('unknown');
  });
  test('Cross-Origin Storage detection', () => {
    expect(hasCrossOriginStorage({ crossOriginStorage: {} })).toBe(true);
    expect(hasCrossOriginStorage({})).toBe(false);
    expect(hasCrossOriginStorage({ crossOriginStorage: undefined })).toBe(false);
    expect(hasCrossOriginStorage(undefined)).toBe(false);
  });
});

describe('updates', () => {
  test('update line and whether it can be applied', () => {
    const avail = { repo: 'r/m', pinned: A, latest: B, updateAvailable: true };
    expect(updateLine(avail)).toBe('Update available: aaaaaaa → bbbbbbb');
    expect(canApplyUpdate(avail)).toBe(true);
    const same = { repo: 'r/m', pinned: A, latest: A, updateAvailable: false };
    expect(updateLine(same)).toBe('Up to date at aaaaaaa.');
    expect(canApplyUpdate(same)).toBe(false);
    const err = { repo: 'r/m', pinned: A, latest: null, updateAvailable: false, error: 'HTTP 503' };
    expect(updateLine(err)).toBe('Could not check r/m for updates (HTTP 503).');
    expect(canApplyUpdate(err)).toBe(false);
    expect(canApplyUpdate({ repo: 'r/m', pinned: A, latest: 'main', updateAvailable: true })).toBe(false);
  });
});

describe('benchRows', () => {
  const b: BenchResultLike = {
    repo: 'r/m',
    revision: A,
    dtype: 'q4f16',
    loadMs: 1234.4,
    cached: true,
    firstTokenMs: 210.6,
    decodeTokPerSec: 41.27,
    promptTokens: 256,
    newTokens: 128,
    adapter: { vendor: 'apple', architecture: 'metal-3', shaderF16: true },
    transformersVersion: '4.3.2',
    at: '2026-11-07T12:00:00.000Z',
  };
  test('every field the card promises', () => {
    const rows = Object.fromEntries(benchRows(b).map((r) => [r.label, r.value]));
    expect(rows['First token']).toBe('211 ms');
    expect(rows.Decode).toBe('41.3 tok/s');
    expect(rows.Load).toBe('1,234 ms (cached)');
    expect(rows.GPU).toBe('apple / metal-3');
    expect(rows['Transformers.js']).toBe('4.3.2');
    expect(rows.Run).toBeTruthy();
  });
  test('cold load, unknown adapter', () => {
    const rows = Object.fromEntries(
      benchRows({ ...b, cached: false, adapter: { vendor: null, architecture: null, shaderF16: null }, transformersVersion: null }).map((r) => [r.label, r.value]),
    );
    expect(rows.Load).toBe('1,234 ms (cold)');
    expect(rows.GPU).toBe('unknown adapter');
    expect(rows['Transformers.js']).toBe('unknown');
  });
});

describe('hybrid chunk degradation', () => {
  test('no chunk: load-the-chat notes', () => {
    const caps = hybridCapabilities(null);
    expect(caps.loaded).toBe(false);
    expect(missingNote(caps, 'cache')).toBe('Load the chat once to inspect the cache.');
    expect(missingNote(caps, 'bench')).toBe('Load the chat once to run a benchmark.');
  });
  test('older chunk without the model-manager methods', () => {
    const caps = hybridCapabilities({});
    expect(caps).toEqual({ loaded: true, cache: false, clear: false, bench: false, lastBench: false, refresh: false });
    expect(missingNote(caps, 'cache')).toContain('cannot report its cache');
    expect(missingNote(caps, 'bench')).toContain('cannot run a benchmark');
  });
  test('current chunk: no notes', () => {
    const fn = async () => null;
    const caps = hybridCapabilities({ cacheStats: fn, cacheClear: fn, bench: fn, refreshConfig: fn, lastBench: () => null });
    expect(caps).toEqual({ loaded: true, cache: true, clear: true, bench: true, lastBench: true, refresh: true });
    expect(missingNote(caps, 'cache')).toBeNull();
    expect(missingNote(caps, 'bench')).toBeNull();
  });
});

describe('apiErrorText', () => {
  test('save refusal shows the validation errors', () => {
    const body = JSON.stringify({ ok: false, validation: { errors: ['owner/x is private or gated.'] } });
    expect(apiErrorText(new Error(`API 400: ${body}`))).toBe('owner/x is private or gated.');
  });
  test('403 reads as admin-only; plain errors pass through', () => {
    expect(apiErrorText(new Error('API 403: {"error":"Forbidden"}'))).toBe('Only an admin can change the browser model.');
    expect(apiErrorText(new Error('API 500: {"error":"Failed to save settings"}'))).toBe('Failed to save settings');
    expect(apiErrorText(new Error('API 502: Bad Gateway'))).toBe('Bad Gateway');
    expect(apiErrorText('network down')).toBe('network down');
  });
});
