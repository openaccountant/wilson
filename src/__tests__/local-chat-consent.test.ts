/**
 * On-device (WebGPU) chat is opt-in, like the open-jev pre-labeler:
 * - the server's `localChatEnabled` setting (per profile, default off, literal
 *   `true` only) is written by PUT /api/config/local-chat, admin-only when auth
 *   is on, from the dashboard page itself;
 * - the browser's own "Download once" opt-in (consent.ts, localStorage, per repo);
 * - the hybrid client loads, downloads, probes or fetches the bundle only when
 *   both are present, re-checked on every call.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDb } from './helpers.js';
import { startDashboardServer, stopDashboardServer } from '../dashboard/server.js';
import { setInitialProfile, closeAll } from '../dashboard/db-manager.js';
import { createUser, enableAuth } from '../dashboard/auth.js';
import { setActiveProfilePaths, resetActiveProfile } from '../profile/index.js';
import { setSetting } from '../utils/config.js';
import { getProviderById } from '../providers.js';
import { getModelsForProvider } from '../utils/model.js';
import {
  getLocalChatModelConfig,
  localChatEnabled,
  LOCAL_CHAT_ENABLED_KEY,
  LOCAL_CHAT_SOURCE_HOST,
} from '../model/local-chat.js';
import {
  describeDownloadSize,
  hasLocalChatOptIn,
  localChatOptInKey,
  localChatPanelKind,
  setLocalChatOptIn,
} from '../dashboard/ui/src/hybrid/consent.js';
import { createHybridChat, type LocalChatConfigResponse, type TransformersModule, type WorkerLike } from '../dashboard/ui/src/hybrid/client.js';
import { installLocalChatOptIn, MemoryLocalStorage } from './local-chat-optin-helper.js';

function tempProfile(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  setActiveProfilePaths({
    name: 'test', root: dir, database: join(dir, 'data.db'), settings: join(dir, 'settings.json'),
    scratchpad: join(dir, 'scratchpad'), cache: join(dir, 'cache'),
  });
  return dir;
}

// ── (a) server config: off by default ───────────────────────────────────────

describe('local chat consent: server setting', () => {
  let dir: string;
  beforeEach(() => {
    dir = tempProfile('local-chat-consent-');
  });
  afterEach(() => {
    resetActiveProfile();
    rmSync(dir, { recursive: true, force: true });
  });

  test('the default config reports local chat as not consented and not enabled, with the model still described', () => {
    const fastModel = getProviderById('transformers')!.fastModel!;
    const entry = getModelsForProvider('transformers').find((m) => m.id === fastModel)!;
    const cfg = getLocalChatModelConfig();
    expect(localChatEnabled()).toBe(false);
    expect(cfg.consented).toBe(false);
    expect(cfg.enabled).toBe(false);
    expect(cfg.available).toBe(true);
    // The consent copy's facts: real model, catalog size, source host.
    expect(cfg.repo).toBe('onnx-community/Qwen3-0.6B-ONNX');
    expect(cfg.displayName).toBe(entry.displayName);
    expect(cfg.downloadSize).toBe(entry.downloadSize!);
    expect(cfg.sourceHost).toBe(LOCAL_CHAT_SOURCE_HOST);
    expect(cfg.sourceHost).toBe('huggingface.co');
  });

  test('only a literal true in settings.json turns it on', () => {
    for (const v of ['true', 1, 'yes', {}, null]) {
      writeFileSync(join(dir, 'settings.json'), JSON.stringify({ [LOCAL_CHAT_ENABLED_KEY]: v }));
      expect(localChatEnabled(), JSON.stringify(v)).toBe(false);
      expect(getLocalChatModelConfig().enabled, JSON.stringify(v)).toBe(false);
    }
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ [LOCAL_CHAT_ENABLED_KEY]: true }));
    expect(getLocalChatModelConfig()).toMatchObject({ enabled: true, consented: true, available: true });
  });

  test('the setting round-trips through setSetting', () => {
    expect(setSetting(LOCAL_CHAT_ENABLED_KEY, true)).toBe(true);
    expect(getLocalChatModelConfig()).toMatchObject({ enabled: true, consented: true });
    expect(setSetting(LOCAL_CHAT_ENABLED_KEY, false)).toBe(true);
    expect(getLocalChatModelConfig()).toMatchObject({ enabled: false, consented: false });
  });
});

// ── (c)+(d) PUT /api/config/local-chat ──────────────────────────────────────

describe('PUT /api/config/local-chat', () => {
  let dir: string;
  let server: Awaited<ReturnType<typeof startDashboardServer>>['server'];
  let base: string;
  let db: ReturnType<typeof createTestDb>;
  const settingsFile = () => join(dir, 'settings.json');

  beforeEach(async () => {
    dir = tempProfile('local-chat-put-');
    db = createTestDb();
    setInitialProfile('test', db);
    const result = await startDashboardServer(db, 0);
    server = result.server;
    base = `http://localhost:${server.port}`;
  });

  afterEach(() => {
    try { stopDashboardServer(server); } catch { /* */ }
    closeAll();
    resetActiveProfile();
    rmSync(dir, { recursive: true, force: true });
  });

  const put = (body: unknown, extra: Record<string, string> = {}): RequestInit => ({
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Origin: base, 'Sec-Fetch-Site': 'same-origin', ...extra },
    body: JSON.stringify(body),
  });

  async function login(username: string, role: 'admin' | 'viewer'): Promise<string> {
    await createUser(db, username, 'pw123456', role);
    const res = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password: 'pw123456' }),
    });
    return ((await res.json()) as { token: string }).token;
  }

  test('GET is off by default', async () => {
    const cfg = (await (await fetch(`${base}/api/config/local-chat`)).json()) as LocalChatConfigResponse;
    expect(cfg.enabled).toBe(false);
    expect(cfg.consented).toBe(false);
    expect(cfg.available).toBe(true);
  });

  test('turning it on and off round-trips through settings.json and GET', async () => {
    const on = await fetch(`${base}/api/config/local-chat`, put({ enabled: true }));
    expect(on.status).toBe(200);
    expect(((await on.json()) as LocalChatConfigResponse).enabled).toBe(true);
    expect(JSON.parse(readFileSync(settingsFile(), 'utf-8'))[LOCAL_CHAT_ENABLED_KEY]).toBe(true);
    expect(((await (await fetch(`${base}/api/config/local-chat`)).json()) as LocalChatConfigResponse).enabled).toBe(true);

    const off = await fetch(`${base}/api/config/local-chat`, put({ enabled: false }));
    expect(off.status).toBe(200);
    expect(((await off.json()) as LocalChatConfigResponse).consented).toBe(false);
    expect(JSON.parse(readFileSync(settingsFile(), 'utf-8'))[LOCAL_CHAT_ENABLED_KEY]).toBe(false);
    expect(((await (await fetch(`${base}/api/config/local-chat`)).json()) as LocalChatConfigResponse).enabled).toBe(false);
  });

  test('a viewer is refused when auth is on; an admin may turn it on', async () => {
    const admin = await login('admin', 'admin');
    const viewer = await login('viewer', 'viewer');
    enableAuth(db);

    const denied = await fetch(`${base}/api/config/local-chat`, put({ enabled: true }, { Authorization: `Bearer ${viewer}` }));
    expect(denied.status).toBe(403);
    expect(existsSync(settingsFile())).toBe(false);

    const anonymous = await fetch(`${base}/api/config/local-chat`, put({ enabled: true }));
    expect(anonymous.status).toBe(401);
    expect(existsSync(settingsFile())).toBe(false);

    const ok = await fetch(`${base}/api/config/local-chat`, put({ enabled: true }, { Authorization: `Bearer ${admin}` }));
    expect(ok.status).toBe(200);
    expect(JSON.parse(readFileSync(settingsFile(), 'utf-8'))[LOCAL_CHAT_ENABLED_KEY]).toBe(true);

    // A viewer can read the state (to see the consent line), not change it.
    const read = await fetch(`${base}/api/config/local-chat`, { headers: { Authorization: `Bearer ${viewer}` } });
    expect(((await read.json()) as LocalChatConfigResponse).enabled).toBe(true);
    const off = await fetch(`${base}/api/config/local-chat`, put({ enabled: false }, { Authorization: `Bearer ${viewer}` }));
    expect(off.status).toBe(403);
    expect(JSON.parse(readFileSync(settingsFile(), 'utf-8'))[LOCAL_CHAT_ENABLED_KEY]).toBe(true);
  });

  test('needs browser proof: no Origin, or a same-site fetch, is 403 and writes nothing', async () => {
    const bare = await fetch(`${base}/api/config/local-chat`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    expect(bare.status).toBe(403);
    const sameSite = await fetch(`${base}/api/config/local-chat`, put({ enabled: true }, { 'Sec-Fetch-Site': 'same-site' }));
    expect(sameSite.status).toBe(403);
    expect(existsSync(settingsFile())).toBe(false);
  });

  test('JSON only, strict body', async () => {
    const text = await fetch(`${base}/api/config/local-chat`, put({ enabled: true }, { 'Content-Type': 'text/plain' }));
    expect(text.status).toBe(415);
    for (const body of [{}, { enabled: 'yes' }, { enabled: true, extra: 1 }]) {
      const res = await fetch(`${base}/api/config/local-chat`, put(body));
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(existsSync(settingsFile())).toBe(false);
  });
});

// ── per-browser opt-in + panel state ────────────────────────────────────────

describe('local chat consent: browser opt-in', () => {
  const REPO = 'onnx-community/Qwen3-0.6B-ONNX';

  test('opt-in round-trips per repo; missing or broken storage is "not opted in"', () => {
    const storage = new MemoryLocalStorage();
    expect(hasLocalChatOptIn(REPO, storage)).toBe(false);
    expect(setLocalChatOptIn(REPO, true, storage)).toBe(true);
    expect(storage.getItem(localChatOptInKey(REPO))).toBe('1');
    expect(hasLocalChatOptIn(REPO, storage)).toBe(true);
    expect(hasLocalChatOptIn('other/repo', storage)).toBe(false);
    expect(setLocalChatOptIn(REPO, false, storage)).toBe(true);
    expect(hasLocalChatOptIn(REPO, storage)).toBe(false);

    storage.setItem(localChatOptInKey(REPO), 'true');
    expect(hasLocalChatOptIn(REPO, storage)).toBe(false);
    expect(hasLocalChatOptIn(REPO, null)).toBe(false);
    expect(hasLocalChatOptIn('', storage)).toBe(false);
    const throwing = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); }, removeItem: () => {} };
    expect(hasLocalChatOptIn(REPO, throwing)).toBe(false);
    expect(setLocalChatOptIn(REPO, true, throwing)).toBe(false);
  });

  test('panel state: "on" (the only state that allows a local attempt) needs the server setting AND the opt-in', () => {
    const off = { enabled: false, available: true, consented: false, repo: REPO };
    const on = { enabled: true, available: true, consented: true, repo: REPO };
    const k = (config: typeof on | null, optedIn: boolean, canAct = true, webgpu = true) =>
      localChatPanelKind({ config, optedIn, canAct, webgpu });

    expect(k(null, true)).toBe('hidden');
    expect(k({ ...off, available: false, repo: '' }, true)).toBe('hidden');
    expect(k(off, false)).toBe('off');
    expect(k(off, true)).toBe('off'); // a stale opt-in never revives a server "off"
    expect(k(off, false, false)).toBe('hidden'); // a viewer cannot turn it on
    expect(k(on, false)).toBe('consent');
    expect(k(on, false, false)).toBe('consent'); // each browser's user consents for their browser
    expect(k(on, false, true, false)).toBe('no_webgpu');
    expect(k(on, true)).toBe('on');
    // An older server (no `consented`) is never "on".
    expect(k({ enabled: true, repo: REPO } as typeof on, true)).toBe('off');
  });

  test('download size comes from the catalog string', () => {
    expect(describeDownloadSize('~570MB')).toBe('about 570 MB');
    expect(describeDownloadSize('~2.3GB')).toBe('about 2.3 GB');
    expect(describeDownloadSize('unknown')).toBeNull();
    expect(describeDownloadSize('')).toBeNull();
    expect(describeDownloadSize(getLocalChatModelConfig().downloadSize)).toBe('about 570 MB');
  });
});

// ── (b) the hybrid client never loads without consent ───────────────────────

describe('hybrid client: no model work without consent', () => {
  const REPO = 'onnx-community/Qwen3-0.6B-ONNX';
  const CFG: LocalChatConfigResponse = {
    enabled: true,
    available: true,
    consented: true,
    sourceHost: 'huggingface.co',
    id: `transformers:${REPO}`,
    repo: REPO,
    displayName: 'Qwen3 0.6B',
    downloadSize: '~570MB',
    dtype: 'q4f16',
    bundle: { days: 30, limit: 200, maxChars: 6000 },
  };
  const OFF: LocalChatConfigResponse = { ...CFG, enabled: false, consented: false };

  const savedNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const savedSession = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  let warn: ReturnType<typeof spyOn>;
  beforeEach(() => {
    Object.defineProperty(globalThis, 'sessionStorage', { value: new MemoryLocalStorage(), configurable: true, writable: true });
    Object.defineProperty(globalThis, 'navigator', {
      value: { gpu: { requestAdapter: async () => ({ features: { has: () => true } }) } },
      configurable: true,
      writable: true,
    });
    warn = spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
    if (savedNavigator) Object.defineProperty(globalThis, 'navigator', savedNavigator);
    if (savedSession) Object.defineProperty(globalThis, 'sessionStorage', savedSession);
    else delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
  });

  /** A server whose config can change between calls, recording every request. */
  function dashboard(initial: LocalChatConfigResponse) {
    const state = { cfg: initial };
    const calls: string[] = [];
    const fn = async (input: string): Promise<Response> => {
      calls.push(input);
      if (input.endsWith('/api/config/local-chat')) return Response.json(state.cfg);
      if (input.includes('/api/transactions')) return Response.json([]);
      if (input.endsWith('/api/weekly-summary')) {
        return Response.json({ thisWeek: { total: 0 }, lastWeek: { total: 0 }, change: { amount: 0, percent: 0 } });
      }
      if (input.endsWith('/api/chat/local')) return Response.json({ sessionId: 's1' });
      return new Response('not found', { status: 404 });
    };
    const nonConfig = () => calls.filter((c) => !c.endsWith('/api/config/local-chat'));
    return { state, calls, fn, nonConfig };
  }

  /** Fake transformers.js that counts model loads (the download) and Hub requests. */
  function fakeTransformers() {
    const loads: string[] = [];
    const hub: string[] = [];
    const mod: TransformersModule = {
      env: { remoteHost: 'https://huggingface.co', backends: { onnx: {} } },
      pipeline: async (_task: string, repo: string) => {
        loads.push(repo);
        return async () => [{ generated_text: [{ role: 'assistant', content: 'You spent $0 this week.' }] }];
      },
    };
    return {
      loads,
      hub,
      loadTransformers: async () => mod,
      hubFetch: async (url: string) => {
        hub.push(url);
        return { ok: false, status: 404, json: async () => ({}) };
      },
    };
  }

  async function exerciseEveryEntryPoint(chat: ReturnType<typeof createHybridChat>) {
    expect(await chat.tryLocal('how much did I spend this week?')).toEqual({ ok: false });
    expect((await chat.categorizeSample({ systemPrompt: 's', userPrompt: 'u' })).ok).toBe(false);
    expect(await chat.loadModel()).toBeNull();
    expect(await chat.probe()).toBe('unavailable');
    expect(await chat.isLocalActive()).toBe(false);
  }

  test('server on, browser NOT opted in: no worker, no model load, no Hub request, no bundle fetch', async () => {
    const optIn = installLocalChatOptIn(); // empty localStorage
    try {
      const api = dashboard(CFG);
      const tf = fakeTransformers();
      let workers = 0;
      const chat = createHybridChat({ baseUrl: '', fetchImpl: api.fn, loadTransformers: tf.loadTransformers, hubFetch: tf.hubFetch });
      await exerciseEveryEntryPoint(chat);
      const viaWorker = createHybridChat({
        baseUrl: '',
        fetchImpl: api.fn,
        createWorker: (): WorkerLike => {
          workers += 1;
          throw new Error('must not spawn');
        },
      });
      await exerciseEveryEntryPoint(viaWorker);
      expect(tf.loads).toEqual([]);
      expect(tf.hub).toEqual([]);
      expect(workers).toBe(0);
      expect(api.nonConfig()).toEqual([]);
    } finally {
      optIn.restore();
    }
  });

  test('browser opted in, server off (the default): nothing either', async () => {
    const optIn = installLocalChatOptIn(REPO);
    try {
      const api = dashboard(OFF);
      const tf = fakeTransformers();
      const chat = createHybridChat({ baseUrl: '', fetchImpl: api.fn, loadTransformers: tf.loadTransformers, hubFetch: tf.hubFetch });
      await exerciseEveryEntryPoint(chat);
      expect(tf.loads).toEqual([]);
      expect(tf.hub).toEqual([]);
      expect(api.nonConfig()).toEqual([]);
    } finally {
      optIn.restore();
    }
  });

  test('both consents present: the model loads (control); revoking either stops the very next call', async () => {
    const optIn = installLocalChatOptIn(REPO);
    try {
      const api = dashboard(CFG);
      const tf = fakeTransformers();
      const chat = createHybridChat({ baseUrl: '', fetchImpl: api.fn, loadTransformers: tf.loadTransformers, hubFetch: tf.hubFetch });
      expect(await chat.isLocalActive()).toBe(true);
      const first = await chat.tryLocal('how much did I spend this week?');
      expect(first.ok).toBe(true);
      expect(tf.loads).toEqual([REPO]);

      // "Stop on this browser": the opt-in is gone, so no bundle fetch and no answer.
      setLocalChatOptIn(REPO, false);
      const before = api.nonConfig().length;
      expect(await chat.tryLocal('how much did I spend this week?')).toEqual({ ok: false });
      expect(await chat.isLocalActive()).toBe(false);
      expect(api.nonConfig().length).toBe(before);

      // Opted in again, but the admin turned it off on the server: same.
      setLocalChatOptIn(REPO, true);
      api.state.cfg = OFF;
      expect(await chat.tryLocal('how much did I spend this week?')).toEqual({ ok: false });
      expect(api.nonConfig().length).toBe(before);
      expect(tf.loads).toEqual([REPO]);
    } finally {
      optIn.restore();
    }
  });
});
