/**
 * The per-tab open-jev host singleton, wired to the real Worker, Web Locks, localStorage and
 * timers. Imported by the app (the singlefile React bundle); the model itself lives only in
 * dist-hybrid/prelabel-worker.js, which this module reaches by URL, never by import.
 */
import { getBaseUrl } from '@/api';
import { createOpenJevHost, type HostWorkerLike, type OpenJevHost } from './host';

let host: OpenJevHost | null = null;

type WorkerCtor = new (url: string, opts?: { type?: 'module' | 'classic' }) => HostWorkerLike;

export function getOpenJevHost(): OpenJevHost {
  host ??= createOpenJevHost({
    createWorker: (url) => new (Worker as unknown as WorkerCtor)(url, { type: 'module' }),
    baseUrl: () => getBaseUrl(),
    locks: (typeof navigator !== 'undefined' ? (navigator as unknown as { locks?: never }).locks : undefined),
    storage: () => {
      try {
        return typeof localStorage === 'undefined' ? null : localStorage;
      } catch {
        return null;
      }
    },
    timers: {
      set: (fn, ms) => setTimeout(fn, ms),
      clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    },
  });
  return host;
}
