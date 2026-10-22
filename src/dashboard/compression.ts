import { brotliCompress, gzip, constants as zlibConstants } from 'node:zlib';
import { promisify } from 'node:util';

// Async variants run on the libuv threadpool, so compressing a 28 MB wasm never stalls Bun's event loop.
const brotliAsync = promisify(brotliCompress);
const gzipAsync = promisify(gzip);

/**
 * Response compression for the dashboard's large static payloads: the inlined React build is ~3 MB of
 * HTML and the hybrid chunk and onnxruntime wasm are larger still. Compressing is the difference between
 * a ~15 s and a ~2 s first paint on a throttled phone (NN-10), and it costs nothing at request time because
 * every body is compressed once and cached.
 */

export type Encoding = 'br' | 'gzip';

/** Pick the best encoding the client accepts (br over gzip), honouring `q=0` refusals; null means send identity. */
export function negotiateEncoding(acceptEncoding: string | null | undefined): Encoding | null {
  if (!acceptEncoding) return null;
  const accepted = new Map<string, number>();
  for (const part of acceptEncoding.split(',')) {
    const [name, ...params] = part.trim().toLowerCase().split(';');
    if (!name) continue;
    const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
    const weight = q ? Number(q.slice(2)) : 1;
    accepted.set(name, Number.isNaN(weight) ? 0 : weight);
  }
  const ok = (enc: string) => (accepted.get(enc) ?? accepted.get('*') ?? 0) > 0;
  if (ok('br')) return 'br';
  if (ok('gzip')) return 'gzip';
  return null;
}

export async function compressBytes(body: Uint8Array, encoding: Encoding): Promise<Uint8Array<ArrayBuffer>> {
  if (encoding === 'br') {
    // Quality 9 is within a few percent of 11 on this content and ~10x faster, which matters for a startup-path cost.
    return new Uint8Array(await brotliAsync(body, {
      params: {
        [zlibConstants.BROTLI_PARAM_QUALITY]: 9,
        [zlibConstants.BROTLI_PARAM_SIZE_HINT]: body.length,
      },
    }));
  }
  return new Uint8Array(await gzipAsync(body, { level: 9 }));
}

/** `Vary` with Accept-Encoding appended, keeping whatever the caller already varies on (CORS sets Origin). */
export function varyWithEncoding(vary: string | undefined): string {
  if (!vary) return 'Accept-Encoding';
  return /(^|,)\s*accept-encoding\s*(,|$)/i.test(vary) ? vary : `${vary}, Accept-Encoding`;
}
