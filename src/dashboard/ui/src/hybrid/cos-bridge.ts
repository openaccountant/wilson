// ── Cross-Origin Storage bridge: page ↔ model worker ────────────────────────
//
// specs/model-manager.md M4. The model cache runs in the model Web Worker, but
// a COS browser extension (and possibly an early Chromium build) only exposes
// `navigator.crossOriginStorage` on the page. The page serves its COS over a
// dedicated MessageChannel; the worker gets a CosLike proxy on the other end.
//
// Pure: ports are injected (PortLike), so both ends are unit tested with a real
// MessageChannel. Only Blobs and hash descriptors cross the port, and only
// model weights reach it (the cache never sends non-LFS files to COS).

import type { CosHashDescriptor, CosLike } from './model-cache.js';

export interface BridgePort {
  onmessage: ((ev: { data: unknown }) => void) | null;
  postMessage(message: unknown): void;
  close?(): void;
}

type Origins = '*' | string[];

type Request =
  | { id: number; op: 'open'; hash: CosHashDescriptor; create: boolean; origins?: Origins }
  | { id: number; op: 'read'; h: number }
  | { id: number; op: 'write'; h: number; blob: Blob };

/** A request without its id (distributes over the union, unlike Omit). */
type RequestBody = Request extends infer R ? (R extends { id: number } ? Omit<R, 'id'> : never) : never;
type Reply = { id: number; ok: true; h?: number; blob?: Blob } | { id: number; ok: false; name: string; message: string };

/** COS calls can wait on the extension's permission prompt, so the budget is generous. */
export const COS_BRIDGE_TIMEOUT_MS = 120_000;
/** Open handles the page keeps before dropping the oldest (each is normally used once). */
export const COS_BRIDGE_MAX_HANDLES = 64;

const SHA256 = /^[0-9a-f]{64}$/;

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null;
}

function isBlob(x: unknown): x is Blob {
  return typeof Blob !== 'undefined' && x instanceof Blob;
}

function parseRequest(x: unknown): Request | null {
  if (!isRecord(x) || typeof x.id !== 'number') return null;
  if (x.op === 'open') {
    const h = x.hash;
    if (!isRecord(h) || h.algorithm !== 'SHA-256' || typeof h.value !== 'string' || !SHA256.test(h.value)) return null;
    if (typeof x.create !== 'boolean') return null;
    const o = x.origins;
    if (o !== undefined && o !== '*' && !(Array.isArray(o) && o.every((s) => typeof s === 'string'))) return null;
    return { id: x.id, op: 'open', hash: { algorithm: 'SHA-256', value: h.value }, create: x.create, ...(o !== undefined ? { origins: o as Origins } : {}) };
  }
  if (x.op === 'read' && typeof x.h === 'number') return { id: x.id, op: 'read', h: x.h };
  if (x.op === 'write' && typeof x.h === 'number' && isBlob(x.blob)) return { id: x.id, op: 'write', h: x.h, blob: x.blob };
  return null;
}

function errorReply(id: number, err: unknown): Reply {
  const e = err as { name?: unknown; message?: unknown } | null;
  return {
    id,
    ok: false,
    name: typeof e?.name === 'string' ? e.name : 'Error',
    message: typeof e?.message === 'string' ? e.message : String(err),
  };
}

function handleFn(cos: CosLike) {
  if (typeof cos.getFileHandle === 'function') return cos.getFileHandle.bind(cos);
  if (typeof cos.requestFileHandle === 'function') return cos.requestFileHandle.bind(cos);
  return null;
}

/** Page side: answer the worker's COS requests with the page's `navigator.crossOriginStorage`. */
export function serveCosBridge(port: BridgePort, cos: CosLike): void {
  const getHandle = handleFn(cos);
  type Handle = Awaited<ReturnType<NonNullable<typeof getHandle>>>;
  const handles = new Map<number, Handle>();
  let nextHandle = 1;

  async function answer(req: Request): Promise<Reply> {
    if (req.op === 'open') {
      if (!getHandle) throw Object.assign(new Error('Cross-Origin Storage is not available'), { name: 'NotSupportedError' });
      const handle = await getHandle(req.hash, req.create ? { create: true, ...(req.origins ? { origins: req.origins } : {}) } : undefined);
      const h = nextHandle++;
      handles.set(h, handle);
      while (handles.size > COS_BRIDGE_MAX_HANDLES) handles.delete(handles.keys().next().value as number);
      return { id: req.id, ok: true, h };
    }
    const handle = handles.get(req.h);
    if (!handle) throw Object.assign(new Error('unknown COS handle'), { name: 'InvalidStateError' });
    handles.delete(req.h);
    if (req.op === 'read') return { id: req.id, ok: true, blob: await handle.getFile() };
    const writable = await handle.createWritable();
    await writable.write(req.blob);
    await writable.close();
    return { id: req.id, ok: true };
  }

  port.onmessage = (ev) => {
    const req = parseRequest(ev.data);
    if (!req) {
      const id = isRecord(ev.data) && typeof ev.data.id === 'number' ? ev.data.id : -1;
      if (id >= 0) port.postMessage(errorReply(id, Object.assign(new Error('malformed COS bridge request'), { name: 'TypeError' })));
      return;
    }
    answer(req).then(
      (reply) => port.postMessage(reply),
      (err) => port.postMessage(errorReply(req.id, err)),
    );
  };
}

/** Worker side: a CosLike that forwards every call to the page over `port`. */
export function createCosBridgeClient(port: BridgePort, timeoutMs: number = COS_BRIDGE_TIMEOUT_MS): CosLike {
  let nextId = 1;
  const pending = new Map<number, { resolve: (r: Reply & { ok: true }) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();

  port.onmessage = (ev) => {
    const r = ev.data as Reply | null;
    if (!isRecord(r) || typeof r.id !== 'number') return;
    const p = pending.get(r.id);
    if (!p) return;
    pending.delete(r.id);
    clearTimeout(p.timer);
    if (r.ok) p.resolve(r);
    else p.reject(Object.assign(new Error(r.message), { name: r.name }));
  };

  function send(req: RequestBody): Promise<Reply & { ok: true }> {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(Object.assign(new Error('Cross-Origin Storage bridge timed out'), { name: 'TimeoutError' }));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      try {
        port.postMessage({ ...req, id });
      } catch (err) {
        pending.delete(id);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  return {
    async getFileHandle(hash, opts) {
      const { h } = await send({ op: 'open', hash, create: opts?.create === true, ...(opts?.origins ? { origins: opts.origins } : {}) });
      const handle = h!;
      return {
        async getFile() {
          const { blob } = await send({ op: 'read', h: handle });
          return blob!;
        },
        async createWritable() {
          // Buffer locally; one 'write' message carries the whole Blob (by reference) on close.
          const parts: Blob[] = [];
          return {
            async write(data: Blob) {
              parts.push(data);
            },
            async close() {
              await send({ op: 'write', h: handle, blob: new Blob(parts) });
            },
          };
        },
      };
    },
  };
}

/**
 * Page side, production: when the page has COS, open a channel, serve it, and
 * return the worker end to transfer in `init`. Null when the page has no COS.
 */
export function openPageCosBridge(
  pageCos: () => CosLike | null | undefined = () =>
    (globalThis.navigator as { crossOriginStorage?: CosLike } | undefined)?.crossOriginStorage,
  makeChannel: () => { port1: BridgePort; port2: unknown } = () => new MessageChannel() as unknown as { port1: BridgePort; port2: unknown },
): { port: unknown; close: () => void } | null {
  const cos = pageCos();
  if (!cos || !handleFn(cos)) return null;
  const ch = makeChannel();
  serveCosBridge(ch.port1, cos);
  return {
    port: ch.port2,
    close: () => {
      try {
        ch.port1.close?.();
      } catch {
        // already closed
      }
    },
  };
}
