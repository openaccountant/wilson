import { describe, expect, test } from 'bun:test';
import { createCosBridgeClient, openPageCosBridge, serveCosBridge, type BridgePort } from '../dashboard/ui/src/hybrid/cos-bridge.js';
import { createModelCache, type CosHashDescriptor, type CosLike, type Manifest } from '../dashboard/ui/src/hybrid/model-cache.js';
import { createWorkerBackend, type WorkerLike } from '../dashboard/ui/src/hybrid/model-backend.js';
import { isMainToWorker, type MainToWorker } from '../dashboard/ui/src/hybrid/worker-protocol.js';

/**
 * specs/model-manager.md M4: the COS extension only reaches the page, so the
 * page serves COS to the model worker over a MessageChannel.
 */

const SHA256 = '9e33a5911974174761d0dfdcc0bec975d9c45af0eae5e9eb647b8ba9442a8f91';
const HASH: CosHashDescriptor = { algorithm: 'SHA-256', value: SHA256 };

function pageCos(method: 'getFileHandle' | 'requestFileHandle' = 'requestFileHandle', opts: { denyWrite?: boolean } = {}) {
  const files = new Map<string, Blob>();
  const calls: Array<{ hash: CosHashDescriptor; opts?: unknown }> = [];
  const fn = async (hash: CosHashDescriptor, o?: { create?: boolean; origins?: unknown }) => {
    calls.push({ hash, opts: o });
    if (!o?.create && !files.has(hash.value)) throw Object.assign(new Error('missing'), { name: 'NotFoundError' });
    return {
      getFile: async () => files.get(hash.value)!,
      createWritable: async () => {
        if (opts.denyWrite) throw Object.assign(new Error('denied'), { name: 'NotAllowedError' });
        const parts: Blob[] = [];
        return { write: async (b: Blob) => void parts.push(b), close: async () => void files.set(hash.value, new Blob(parts)) };
      },
    };
  };
  return { cos: { [method]: fn } as CosLike, files, calls };
}

function bridged(cos: CosLike, timeoutMs?: number) {
  const ch = new MessageChannel();
  serveCosBridge(ch.port1 as unknown as BridgePort, cos);
  const client = createCosBridgeClient(ch.port2 as unknown as BridgePort, timeoutMs);
  return { client, close: () => (ch.port1.close(), ch.port2.close()) };
}

describe('COS bridge over a MessageChannel', () => {
  test('write then read round-trips a Blob, using the page API name (requestFileHandle)', async () => {
    const page = pageCos('requestFileHandle');
    const { client, close } = bridged(page.cos);
    const w = await (await client.getFileHandle!(HASH, { create: true, origins: '*' })).createWritable();
    await w.write(new Blob(['wwww']));
    await w.close();
    expect(await page.files.get(SHA256)!.text()).toBe('wwww');
    expect(page.calls[0]).toEqual({ hash: HASH, opts: { create: true, origins: '*' } });
    const blob = await (await client.getFileHandle!(HASH)).getFile();
    expect(await blob.text()).toBe('wwww');
    expect(page.calls[1]).toEqual({ hash: HASH, opts: undefined });
    close();
  });

  test('page errors keep their DOMException name (NotFoundError is the normal miss)', async () => {
    const { client, close } = bridged(pageCos('getFileHandle').cos);
    const err = await client.getFileHandle!(HASH).catch((e) => e);
    expect(err.name).toBe('NotFoundError');
    close();
  });

  test('a denied write rejects with NotAllowedError', async () => {
    const { client, close } = bridged(pageCos('getFileHandle', { denyWrite: true }).cos);
    const w = await (await client.getFileHandle!(HASH, { create: true })).createWritable();
    await w.write(new Blob(['x']));
    expect((await w.close().catch((e) => e)).name).toBe('NotAllowedError');
    close();
  });

  test('a page that never answers times out instead of hanging the load', async () => {
    const ch = new MessageChannel();
    const client = createCosBridgeClient(ch.port2 as unknown as BridgePort, 20);
    expect((await client.getFileHandle!(HASH).catch((e) => e)).name).toBe('TimeoutError');
    ch.port1.close();
    ch.port2.close();
  });

  test('the page refuses malformed requests (bad hash)', async () => {
    const page = pageCos('getFileHandle');
    const { client, close } = bridged(page.cos);
    const err = await client.getFileHandle!({ algorithm: 'SHA-256', value: 'nope' }).catch((e) => e);
    expect(err.name).toBe('TypeError');
    expect(page.calls).toHaveLength(0);
    close();
  });

  test('the worker model cache stores and reads weights through the bridge', async () => {
    const page = pageCos('requestFileHandle');
    const { client, close } = bridged(page.cos);
    const store = new Map<string, Response>();
    const manifest: Manifest = new Map([['onnx/model_q4f16.onnx', { size: 4, sha256: SHA256 }]]);
    const mc = createModelCache({
      openCache: async () => ({ match: async (k) => store.get(k), put: async (k, r) => void store.set(k, r) }),
      cos: client,
      fetchManifest: async () => manifest,
    });
    const url = `https://huggingface.co/a/b/resolve/${'0'.repeat(40)}/onnx/model_q4f16.onnx`;
    await mc.put(url, new Response('wwww'));
    expect(store.size).toBe(0);
    expect(await (await mc.match(url))!.text()).toBe('wwww');
    close();
  });
});

describe('openPageCosBridge', () => {
  test('null when the page has no usable COS', () => {
    expect(openPageCosBridge(() => undefined)).toBeNull();
    expect(openPageCosBridge(() => ({}) as CosLike)).toBeNull();
  });
  test('returns the worker end of a served channel', () => {
    const b = openPageCosBridge(() => pageCos().cos)!;
    expect(b.port).toBeInstanceOf(MessagePort);
    b.close();
  });
});

describe('worker backend sends the bridge port in init', () => {
  class FakeWorker implements WorkerLike {
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: ((event: unknown) => void) | null = null;
    posted: Array<{ msg: MainToWorker; transfer?: unknown[] }> = [];
    postMessage(message: unknown, transfer?: unknown[]) {
      expect(isMainToWorker(message)).toBe(true);
      this.posted.push({ msg: message as MainToWorker, transfer });
      const m = message as MainToWorker;
      if (m.t === 'probe') queueMicrotask(() => this.onmessage?.({ data: { t: 'result', id: m.id, ok: true, result: 'ready' } }));
    }
    terminate() {}
  }
  const MODEL = { repo: 'onnx-community/Qwen3-0.6B-ONNX', displayName: 'Qwen3 0.6B', catalogDtype: 'q4f16' };

  function setup() {
    const w = new FakeWorker();
    const opened: Array<{ port: object; closed: boolean }> = [];
    const backend = createWorkerBackend({
      origin: 'http://127.0.0.1:3000',
      createWorker: () => w,
      cosBridge: () => {
        const b = { port: {}, closed: false };
        opened.push(b);
        return { port: b.port, close: () => void (b.closed = true) };
      },
    });
    return { w, backend, opened };
  }

  test('COS on: init carries and transfers the port; a COS toggle re-inits with a fresh port', async () => {
    const { w, backend, opened } = setup();
    backend.setModel({ ...MODEL, crossOriginStorage: true });
    await backend.probe();
    const init = w.posted.find((p) => p.msg.t === 'init')!;
    expect((init.msg as { cosPort?: unknown }).cosPort).toBe(opened[0].port);
    expect(init.transfer).toEqual([opened[0].port]);

    backend.setModel({ ...MODEL, crossOriginStorage: false });
    const reinit = w.posted.filter((p) => p.msg.t === 'init').at(-1)!;
    expect((reinit.msg as { cosPort?: unknown }).cosPort).toBeUndefined();
    expect(opened[0].closed).toBe(true);
    expect(opened).toHaveLength(1);
  });

  test('COS off: no bridge is opened', async () => {
    const { w, backend, opened } = setup();
    backend.setModel(MODEL);
    await backend.probe();
    expect(opened).toHaveLength(0);
    expect(w.posted.find((p) => p.msg.t === 'init')!.transfer).toBeUndefined();
  });
});
