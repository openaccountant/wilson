import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import type { PoolRoot } from '../dashboard/ui/src/store/mirror-session.js';

/**
 * store/mirror-client.ts against a fake mirror worker: a pool being wiped is never reopened. Settings' logout
 * (lockMirror) and a gate check that lets the app in again (unlockMirror, then the app's initMirror and first sync)
 * can overlap; the unlock and the init must wait for the wipe, or the worker would reopen (and a sync refill) the
 * pool it was just told to delete.
 */

interface Posted {
  id: number;
  type: string;
  [key: string]: unknown;
}

const posted: Posted[] = [];
const heldWipes: Array<() => void> = [];

class FakeMirrorWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  terminated = false;
  postMessage(msg: Posted): void {
    posted.push(msg);
    const answer = (result: unknown) => queueMicrotask(() => this.onmessage?.({ data: { id: msg.id, ok: true, result } } as MessageEvent));
    if (msg.type === 'wipe') heldWipes.push(() => answer({ removed: msg.profiles, failed: [] }));
    else if (msg.type === 'init' || msg.type === 'setProfile') answer({ available: true, profile: msg.profile, seeded: true, lastSyncedAt: null });
    else answer(null);
  }
  terminate(): void {
    this.terminated = true;
  }
}

mock.module('../dashboard/ui/src/store/mirror-worker.ts?worker', () => ({ default: FakeMirrorWorker }));

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    key: (i: number) => [...data.keys()][i] ?? null,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
}

const saved = new Map<string, PropertyDescriptor | undefined>();
function stub(name: string, value: unknown): void {
  saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

// The slice of mirror-client.ts used here. Imported by a computed path: its `?worker` import has types only
// in the UI's vite build, not in the root tsconfig this file is checked under.
interface Client {
  initMirror(): Promise<{ available: boolean }>;
  unlockMirror(): Promise<void>;
  suspendMirror(): void;
  lockMirror(): Promise<void>;
  tryMirror(path: string): Promise<unknown | null>;
  getMirrorState(): { available: boolean };
}
const CLIENT_MODULE = '../dashboard/ui/src/store/mirror-client.js';
let client: Client;

beforeAll(async () => {
  const root: PoolRoot = { async removeEntry() {}, async *keys() {} };
  stub('navigator', { storage: { getDirectory: async () => root, persist: async () => true } });
  stub('localStorage', memoryStorage());
  stub('sessionStorage', memoryStorage());
  client = (await import(CLIENT_MODULE)) as Client;
});

afterAll(() => {
  for (const [name, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<string, unknown>)[name];
  }
});

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
}

const typesSince = (from: number) => posted.slice(from).map((m) => m.type);

describe('mirror-client: unlock and init wait for a wipe in flight', () => {
  test('a logout wipe, then the gate letting the app in again: nothing reopens the pool until the wipe is done', async () => {
    await client.unlockMirror();
    expect((await client.initMirror()).available).toBe(true);
    expect(typesSince(0)).toEqual(['init']);

    // Settings' logout: the wipe goes to the worker and is held there.
    const logout = client.lockMirror();
    await settle();
    const mark = posted.length - 1;
    expect(posted[mark]!.type).toBe('wipe');

    // Meanwhile a check lets the app in, and the app starts its mirror.
    let unlocked = false;
    const unlock = client.unlockMirror().then(() => {
      unlocked = true;
    });
    const init = client.initMirror();
    await settle();
    expect(unlocked).toBe(false);
    expect(typesSince(mark + 1)).toEqual([]); // no init, setProfile or sync message behind the wipe
    expect(await client.tryMirror('/api/transactions')).toBeNull();

    heldWipes.shift()!();
    await logout;
    await unlock;
    expect(unlocked).toBe(true);
    // Only now does a fresh worker open the pool.
    expect((await init).available).toBe(true);
    expect(typesSince(mark + 1)).toEqual(['init']);
    expect(client.getMirrorState().available).toBe(true);
  });

  test('a lock that comes while an unlock waits out the wipe wins: the mirror stays locked', async () => {
    expect(client.getMirrorState().available).toBe(true); // the worker the first test opened
    const first = client.lockMirror();
    await settle();
    const waiting = client.unlockMirror();
    // The next check shows the login view: another lock (the same wipe in flight).
    const second = client.lockMirror();
    heldWipes.shift()!();
    await Promise.all([first, second, waiting]);
    const mark = posted.length;
    expect((await client.initMirror()).available).toBe(false);
    expect(await client.tryMirror('/api/transactions')).toBeNull();
    expect(typesSince(mark)).toEqual([]);
  });

  test('so does a suspend (the gate shows an error page) that comes after the unlock', async () => {
    await client.unlockMirror();
    expect((await client.initMirror()).available).toBe(true);
    const wipe = client.lockMirror();
    await settle();
    const waiting = client.unlockMirror();
    client.suspendMirror();
    heldWipes.shift()!();
    await Promise.all([wipe, waiting]);
    const mark = posted.length;
    expect((await client.initMirror()).available).toBe(false);
    expect(typesSince(mark)).toEqual([]);
  });
});
