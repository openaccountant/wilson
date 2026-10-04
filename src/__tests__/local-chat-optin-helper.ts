import { localChatOptInKey, type OptInStorage } from '../dashboard/ui/src/hybrid/consent.js';

/** In-memory localStorage stand-in (bun has none). */
export class MemoryLocalStorage implements OptInStorage {
  private data = new Map<string, string>();
  getItem(k: string): string | null {
    return this.data.has(k) ? this.data.get(k)! : null;
  }
  setItem(k: string, v: string): void {
    this.data.set(k, v);
  }
  removeItem(k: string): void {
    this.data.delete(k);
  }
}

/**
 * This browser clicked "Download once" for each repo: installs a global
 * localStorage holding the on-device chat opt-in. Returns the storage and a
 * restore function for afterEach.
 */
export function installLocalChatOptIn(...repos: string[]): { storage: MemoryLocalStorage; restore(): void } {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const storage = new MemoryLocalStorage();
  for (const repo of repos) storage.setItem(localChatOptInKey(repo), '1');
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true, writable: true });
  return {
    storage,
    restore() {
      if (saved) Object.defineProperty(globalThis, 'localStorage', saved);
      else delete (globalThis as { localStorage?: unknown }).localStorage;
    },
  };
}
