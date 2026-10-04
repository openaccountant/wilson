/**
 * Per-browser opt-in for on-device chat.
 *
 * The server's `localChatEnabled` setting (admin, per profile) says the feature
 * may run; this says THIS browser's user agreed to download the model into
 * THIS browser's cache. Both are required before anything local happens. Kept
 * in localStorage (the model cache is per browser too) and keyed by repo, so a
 * different model asks again. Shared by the React app, the hybrid chunk and,
 * through the chunk, the legacy dashboard. Import-free so the main bundle can
 * use it without pulling in the chunk.
 */

export interface OptInStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const localChatOptInKey = (repo: string) => `wilson-local-chat-optin:v1:${repo}`;

function defaultStorage(): OptInStorage | null {
  try {
    return (globalThis as { localStorage?: OptInStorage }).localStorage ?? null;
  } catch {
    return null;
  }
}

/** True only for a stored literal '1'. Unreadable storage is "not opted in". */
export function hasLocalChatOptIn(repo: string, storage: OptInStorage | null = defaultStorage()): boolean {
  if (!repo) return false;
  try {
    return storage?.getItem(localChatOptInKey(repo)) === '1';
  } catch {
    return false;
  }
}

/** Record or revoke the opt-in. Returns false when storage is unavailable. */
export function setLocalChatOptIn(repo: string, on: boolean, storage: OptInStorage | null = defaultStorage()): boolean {
  if (!repo || !storage) return false;
  try {
    if (on) storage.setItem(localChatOptInKey(repo), '1');
    else storage.removeItem(localChatOptInKey(repo));
    return true;
  } catch {
    return false;
  }
}

// ── Panel state (the chat tab's on/off line), pure so it is testable ────────

/** The config fields the panel reads (subset of GET /api/config/local-chat). */
export interface LocalChatConsentConfig {
  enabled: boolean;
  available?: boolean;
  consented?: boolean;
  repo: string;
}

/**
 * - hidden: no config yet, no model to offer, or off and the viewer cannot turn it on
 * - off: an admin (or single-user mode) may turn it on
 * - consent: on for the profile, this browser has not agreed to the download
 * - no_webgpu: on for the profile, this browser cannot run it
 * - on: local answers are attempted (the only state that allows tryLocal)
 */
export type LocalChatPanelKind = 'hidden' | 'off' | 'consent' | 'no_webgpu' | 'on';

export function localChatPanelKind(input: {
  config: LocalChatConsentConfig | null;
  optedIn: boolean;
  canAct: boolean;
  webgpu: boolean;
}): LocalChatPanelKind {
  const { config, optedIn, canAct, webgpu } = input;
  // Older servers send no `available`; a repo means a model exists.
  if (!config || !(config.available ?? Boolean(config.repo))) return 'hidden';
  // Older servers send no `consented`, so nothing is on without this one.
  if (config.consented !== true || !config.enabled) return canAct ? 'off' : 'hidden';
  if (!optedIn) return webgpu ? 'consent' : 'no_webgpu';
  return 'on';
}

/** '~570MB' (the catalog's form) -> 'about 570 MB'; empty or 'unknown' -> null. */
export function describeDownloadSize(size: string | undefined | null): string | null {
  const s = (size ?? '').trim().replace(/^~\s*/, '');
  if (!s || s === 'unknown') return null;
  return `about ${s.replace(/(\d)\s*([KMGT]B)$/i, '$1 $2')}`;
}
