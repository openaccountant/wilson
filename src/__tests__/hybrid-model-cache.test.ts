import { describe, expect, test } from 'bun:test';
import {
  createModelCache,
  manifestFromTree,
  parseHubFileUrl,
  requestPersistentStorage,
  responseMatchesEntry,
  type CacheEvent,
  type CacheLike,
  type CosHashDescriptor,
  type CosLike,
  type Manifest,
} from '../dashboard/ui/src/hybrid/model-cache.js';

/**
 * specs/model-manager.md M4: the browser model cache. COS first (by sha256),
 * then the Cache API, then a verified reuse of pre-pin `/resolve/main/` copies.
 */

const REPO = 'onnx-community/Qwen3-0.6B-ONNX';
const SHA = '58ca03a5e7b354b480b1a82b34bde8dc7b854cc0';
const WEIGHTS = 'onnx/model_q4f16.onnx';
const SHA256 = '9e33a5911974174761d0dfdcc0bec975d9c45af0eae5e9eb647b8ba9442a8f91';
const XET = '8e2ec55509cb678edd94b22625d4c04c12eee5bdd7d2194748287ad80f1fe6e3';
const url = (rev: string, path: string) => `https://huggingface.co/${REPO}/resolve/${rev}/${path}`;

const MANIFEST: Manifest = new Map([
  [WEIGHTS, { size: 4, sha256: SHA256, xetHash: XET }],
  ['config.json', { size: 2 }],
]);

class FakeCache implements CacheLike {
  readonly store = new Map<string, { body: string; headers: Record<string, string> }>();
  async match(key: string) {
    const e = this.store.get(key);
    return e ? new Response(e.body, { headers: e.headers }) : undefined;
  }
  async put(key: string, res: Response) {
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => (headers[k] = v));
    this.store.set(key, { body: await res.text(), headers });
  }
  async delete(key: string) {
    return this.store.delete(key);
  }
  async keys() {
    return [...this.store.keys()].map((u) => ({ url: u }));
  }
}

function fakeCos(method: 'getFileHandle' | 'requestFileHandle', opts: { failWrite?: boolean } = {}) {
  const files = new Map<string, Blob>();
  const calls: Array<{ hash: CosHashDescriptor; opts?: unknown }> = [];
  const handle = async (hash: CosHashDescriptor, o?: { create?: boolean; origins?: unknown }) => {
    calls.push({ hash, opts: o });
    if (!o?.create && !files.has(hash.value)) throw Object.assign(new Error('nope'), { name: 'NotFoundError' });
    return {
      getFile: async () => files.get(hash.value)!,
      createWritable: async () => {
        if (opts.failWrite) throw Object.assign(new Error('denied'), { name: 'NotAllowedError' });
        const parts: Blob[] = [];
        return {
          write: async (b: Blob) => void parts.push(b),
          close: async () => void files.set(hash.value, new Blob(parts)),
        };
      },
    };
  };
  const cos = { [method]: handle } as CosLike;
  return { cos, files, calls };
}

function setup(cos?: CosLike | null) {
  const c = new FakeCache();
  const events: CacheEvent[] = [];
  let manifestCalls = 0;
  const mc = createModelCache({
    openCache: async () => c,
    cos,
    fetchManifest: async () => {
      manifestCalls++;
      return MANIFEST;
    },
    onEvent: (e) => events.push(e),
  });
  return { mc, c, events, manifestCalls: () => manifestCalls };
}

describe('parseHubFileUrl', () => {
  test('splits a resolve URL', () => {
    expect(parseHubFileUrl(url(SHA, WEIGHTS))).toEqual({ repo: REPO, revision: SHA, path: WEIGHTS });
  });
  test('rejects other hosts and shapes', () => {
    expect(parseHubFileUrl('https://example.com/a/b/resolve/main/x')).toBeNull();
    expect(parseHubFileUrl(`https://huggingface.co/api/models/${REPO}`)).toBeNull();
    expect(parseHubFileUrl('/models/a/b/config.json')).toBeNull();
  });
});

describe('without COS', () => {
  test('Cache API round trip, manifest fetched once per repo@revision', async () => {
    const { mc, c, manifestCalls } = setup(null);
    expect(mc.cosActive).toBe(false);
    expect(await mc.match(url(SHA, WEIGHTS))).toBeUndefined();
    await mc.put(url(SHA, WEIGHTS), new Response('wwww', { headers: { 'content-length': '4' } }));
    expect(c.store.has(url(SHA, WEIGHTS))).toBe(true);
    expect(await (await mc.match(url(SHA, WEIGHTS)))!.text()).toBe('wwww');
    expect(manifestCalls()).toBe(1);
  });

  test('a pre-pin main copy is reused only when its ETag proves the bytes', async () => {
    const { mc, c, events } = setup(null);
    c.store.set(url('main', WEIGHTS), { body: 'wwww', headers: { etag: `"${XET}"`, 'content-length': '4' } });
    const hit = await mc.match(url(SHA, WEIGHTS));
    expect(await hit!.text()).toBe('wwww');
    expect(events.at(-1)).toMatchObject({ kind: 'hit', source: 'migrated' });
  });

  test('a main copy with a different ETag is not reused', async () => {
    const { mc, c } = setup(null);
    c.store.set(url('main', WEIGHTS), { body: 'wwww', headers: { etag: '"deadbeef"', 'content-length': '4' } });
    expect(await mc.match(url(SHA, WEIGHTS))).toBeUndefined();
  });

  test('a main copy with the right ETag but wrong size is not reused', async () => {
    const { mc, c } = setup(null);
    c.store.set(url('main', WEIGHTS), { body: 'ww', headers: { etag: `"${XET}"`, 'content-length': '2' } });
    expect(await mc.match(url(SHA, WEIGHTS))).toBeUndefined();
  });

  test('non-LFS files (no hash in the manifest) never migrate', async () => {
    const { mc, c } = setup(null);
    c.store.set(url('main', 'config.json'), { body: '{}', headers: { etag: '"abc"' } });
    expect(await mc.match(url(SHA, 'config.json'))).toBeUndefined();
  });

  test('stats groups Hub files by repo@revision and clear removes them', async () => {
    const { mc, c } = setup(null);
    c.store.set(url(SHA, WEIGHTS), { body: 'wwww', headers: { 'content-length': '4' } });
    c.store.set(url(SHA, 'config.json'), { body: '{}', headers: { 'content-length': '2' } });
    c.store.set('https://localhost/assets/ort/x.wasm', { body: 'x', headers: {} });
    const s = await mc.stats();
    expect(s.totalBytes).toBe(6);
    expect(s.groups).toHaveLength(1);
    expect(s.groups[0]).toMatchObject({ repo: REPO, revision: SHA, bytes: 6 });
    expect(await mc.clear({ repo: REPO })).toBe(2);
    expect(c.store.size).toBe(1);
  });
});

describe('with COS', () => {
  for (const method of ['getFileHandle', 'requestFileHandle'] as const) {
    test(`${method}: weights go to COS by sha256 with origins '*', and read back from COS`, async () => {
      const cos = fakeCos(method);
      const { mc, c, events } = setup(cos.cos);
      expect(mc.cosActive).toBe(true);
      await mc.put(url(SHA, WEIGHTS), new Response('wwww'));
      expect(cos.files.has(SHA256)).toBe(true);
      expect(c.store.has(url(SHA, WEIGHTS))).toBe(false); // no double copy
      const write = cos.calls.find((x) => (x.opts as { create?: boolean } | undefined)?.create);
      expect(write).toEqual({ hash: { algorithm: 'SHA-256', value: SHA256 }, opts: { create: true, origins: '*' } });
      const hit = await mc.match(url(SHA, WEIGHTS));
      expect(await hit!.text()).toBe('wwww');
      expect(events.at(-1)).toMatchObject({ kind: 'hit', source: 'cos' });
    });
  }

  test('small non-LFS files stay in the Cache API', async () => {
    const cos = fakeCos('getFileHandle');
    const { mc, c } = setup(cos.cos);
    await mc.put(url(SHA, 'config.json'), new Response('{}'));
    expect(c.store.has(url(SHA, 'config.json'))).toBe(true);
    expect(cos.files.size).toBe(0);
  });

  test('a failed COS write falls back to the Cache API', async () => {
    const cos = fakeCos('getFileHandle', { failWrite: true });
    const { mc, c, events } = setup(cos.cos);
    await mc.put(url(SHA, WEIGHTS), new Response('wwww'));
    expect(c.store.get(url(SHA, WEIGHTS))?.body).toBe('wwww');
    expect(events.some((e) => e.kind === 'store-failed' && e.source === 'cos-write')).toBe(true);
  });

  test('a COS miss falls through to the Cache API', async () => {
    const cos = fakeCos('getFileHandle');
    const { mc, c } = setup(cos.cos);
    c.store.set(url(SHA, WEIGHTS), { body: 'wwww', headers: {} });
    expect(await (await mc.match(url(SHA, WEIGHTS)))!.text()).toBe('wwww');
  });

  test('a manifest failure disables COS for that repo instead of throwing', async () => {
    const cos = fakeCos('getFileHandle');
    const c = new FakeCache();
    const mc = createModelCache({ openCache: async () => c, cos: cos.cos, fetchManifest: async () => { throw new Error('offline'); } });
    await mc.put(url(SHA, WEIGHTS), new Response('wwww'));
    expect(c.store.has(url(SHA, WEIGHTS))).toBe(true);
    expect(cos.calls).toHaveLength(0);
  });

  test('an object with neither method is treated as no COS', () => {
    const { mc } = setup({} as CosLike);
    expect(mc.cosActive).toBe(false);
  });
});

describe('skipStore', () => {
  test('a skipped URL is not stored but other files are', async () => {
    const c = new FakeCache();
    const mc = createModelCache({ openCache: async () => c, fetchManifest: async () => MANIFEST, skipStore: (r) => r.revision === 'main' });
    await mc.put(url('main', 'config.json'), new Response('{}'));
    await mc.put(url(SHA, 'config.json'), new Response('{}'));
    expect([...c.store.keys()]).toEqual([url(SHA, 'config.json')]);
  });
});

describe('helpers', () => {
  test('manifestFromTree keeps LFS sha256 and xet hash', () => {
    const m = manifestFromTree([
      { type: 'file', path: WEIGHTS, size: 4, lfs: { oid: SHA256, size: 4 }, xetHash: XET.toUpperCase() },
      { type: 'file', path: 'config.json', size: 2 },
      { type: 'directory', path: 'onnx' },
    ])!;
    expect(m.get(WEIGHTS)).toEqual({ size: 4, sha256: SHA256, xetHash: XET });
    expect(m.get('config.json')).toEqual({ size: 2 });
    expect(m.has('onnx')).toBe(false);
    expect(manifestFromTree({ error: 'x' })).toBeNull();
  });

  test('responseMatchesEntry accepts the X-Linked-ETag sha256 and weak ETags', () => {
    const entry = { size: 4, sha256: SHA256, xetHash: XET };
    expect(responseMatchesEntry(new Response('', { headers: { 'x-linked-etag': `"${SHA256}"` } }), entry)).toBe(true);
    expect(responseMatchesEntry(new Response('', { headers: { etag: `W/"${XET}"` } }), entry)).toBe(true);
    expect(responseMatchesEntry(new Response('', { headers: {} }), entry)).toBe(false);
  });

  test('requestPersistentStorage reports, never throws', async () => {
    expect(await requestPersistentStorage(undefined)).toEqual({ persisted: false, unsupported: true });
    expect(await requestPersistentStorage({ persisted: async () => true, persist: async () => false })).toEqual({ persisted: true, unsupported: false });
    expect(await requestPersistentStorage({ persisted: async () => false, persist: async () => true })).toEqual({ persisted: true, unsupported: false });
    expect(await requestPersistentStorage({ persist: async () => { throw new Error('x'); } })).toEqual({ persisted: false, unsupported: true });
  });
});
