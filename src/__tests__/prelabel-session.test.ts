/** S5: pure session logic (cache, acceptResults, profile binding, lock, panel state) — specs/open-jev-labeler.md §5, §7, §10.3, §14. */
import { describe, test, expect } from 'bun:test';
import {
  acceptResults,
  acquirePrelabelLock,
  createLockGate,
  createPrelabelSession,
  describeTurnOnError,
  fnv1a32,
  initialPanelState,
  persistVerdict,
  workerPins,
  readPersistedVerdict,
  reducePanel,
  type KeyValueStorage,
  type LockManagerLike,
  type RunBinding,
} from '../dashboard/ui/src/prelabel/session.js';
import { cacheKey, formatState } from '../dashboard/ui/src/prelabel/core.js';
import type { FromWorker, PrelabelItem, PrelabelResult } from '../dashboard/ui/src/prelabel/protocol.js';
import type { PrelabelConfig } from '../dashboard/ui/src/types.js';

const labels = ['Dining', 'Groceries', 'Shopping', 'Other'];

function config(over: Partial<PrelabelConfig> = {}): PrelabelConfig {
  return {
    enabled: true,
    profile: 'p1',
    pins: {
      repo: 'onnx-community/open-jev-deberta-v3-large-ONNX',
      dtype: 'q4f16',
      device: 'webgpu',
      temperature: 1.05,
      templateVersion: 'prelabel-tmpl-v1',
      modelId: 'onnx-community/open-jev-deberta-v3-large-ONNX:q4f16',
      revision: '7c79f25b5ac496089f448a969c801872ad59d31c',
      configSha: '2ec35432332ee6b5880509eefe44e6279fd9d3543f6ba96098119ffe0b0c2d5e',
      approxDownloadBytes: 350631305,
    },
    labels,
    labelSetVersion: 'cat-4-aaaaaaaaaaaa',
    marginCut: 0.3,
    maxRowsPerRun: 2000,
    approxDownloadBytes: 350631305,
    ...over,
  };
}

function memStorage(): KeyValueStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

const throwingStorage: KeyValueStorage = {
  getItem() { throw new Error('SecurityError'); },
  setItem() { throw new Error('QuotaExceeded'); },
  removeItem() { throw new Error('SecurityError'); },
};

const row = (id: number, description = `MERCHANT ${id}`, amount = -10 - id, date = '2026-06-01') => ({
  transaction_id: id, description, amount, date,
});

const ok = (txnId: number, choice = 'Dining', p1 = 0.7, p2 = 0.2): PrelabelResult => ({
  txnId, ok: true, choice, p1, p2, margin: p1 - p2,
  top2: [[choice, p1], [choice === 'Other' ? 'Dining' : 'Other', p2]], ms: 80, stateTokens: 20, truncated: false,
});

function resultsMsg(runId: string, rows: PrelabelResult[]): Extract<FromWorker, { type: 'results' }> {
  return { v: 1, type: 'results', runId, rows };
}
function doneMsg(runId: string): Extract<FromWorker, { type: 'done' }> {
  return { v: 1, type: 'done', runId, n: 1, skipped: 0, cancelled: false, p50Ms: 80, p95Ms: 90, wallMs: 500 };
}

function mkSession(opts: { storage?: KeyValueStorage | null; fetchConfig?: () => Promise<PrelabelConfig>; cfg?: PrelabelConfig } = {}) {
  const storage = opts.storage === undefined ? memStorage() : opts.storage;
  let n = 0;
  let configNow = opts.cfg ?? config();
  const s = createPrelabelSession({
    storage: () => storage,
    fetchConfig: opts.fetchConfig ?? (async () => configNow),
    now: () => 1_000,
    newRunId: () => `run-${++n}`,
  });
  s.bind(opts.cfg ?? config());
  return { s, storage, setConfig: (c: PrelabelConfig) => void (configNow = c) };
}

// ── acceptResults ───────────────────────────────────────────────────────────

describe('acceptResults', () => {
  const items: PrelabelItem[] = [1, 2, 3].map((id) => ({ txnId: id, description: `d${id}`, amount: -5, date: '2026-06-01' }));
  const run: RunBinding = { runId: 'r1', txnIds: new Set([1, 2, 3]), labels: new Set(labels) };
  void items;

  test('keeps valid rows for the current run', () => {
    const out = acceptResults(run, resultsMsg('r1', [ok(1), ok(2, 'Groceries')]));
    expect(out.accepted.map((r) => r.txnId)).toEqual([1, 2]);
    expect(out.dropped).toBe(0);
  });

  test('drops every row of a stale runId', () => {
    const out = acceptResults(run, resultsMsg('old-run', [ok(1), ok(2)]));
    expect(out.accepted).toEqual([]);
    expect(out.dropped).toBe(2);
  });

  test('drops rows whose txnId was not in the run', () => {
    const out = acceptResults(run, resultsMsg('r1', [ok(1), ok(99)]));
    expect(out.accepted.map((r) => r.txnId)).toEqual([1]);
    expect(out.dropped).toBe(1);
  });

  test('drops a choice that is not in the run label set', () => {
    const out = acceptResults(run, resultsMsg('r1', [ok(1, 'Crypto')]));
    expect(out.accepted).toEqual([]);
    expect(out.dropped).toBe(1);
  });

  test('drops a top2 label that is not in the run label set', () => {
    const bad = ok(1);
    if (bad.ok) bad.top2 = [['Dining', 0.7], ['Mystery', 0.2]];
    expect(acceptResults(run, resultsMsg('r1', [bad])).dropped).toBe(1);
  });

  test('drops NaN, Infinity and out-of-[0,1] probabilities and p2 > p1', () => {
    const rows = [
      ok(1, 'Dining', Number.NaN, 0.1),
      ok(2, 'Dining', 0.9, Number.POSITIVE_INFINITY),
      ok(3, 'Dining', 1.2, 0.1),
      { ...ok(1, 'Dining', 0.2, 0.5) },
      ok(2, 'Dining', 0.5, -0.1),
    ];
    const out = acceptResults(run, resultsMsg('r1', rows));
    expect(out.accepted).toEqual([]);
    expect(out.dropped).toBe(5);
  });

  test('drops a choice that is not top2[0]', () => {
    const bad = ok(1, 'Dining');
    if (bad.ok) bad.choice = 'Groceries';
    expect(acceptResults(run, resultsMsg('r1', [bad])).dropped).toBe(1);
  });

  test('ok:false rows pass when the txn is in the run, and are dropped otherwise', () => {
    const out = acceptResults(run, resultsMsg('r1', [
      { txnId: 1, ok: false, reason: 'decide_error' },
      { txnId: 50, ok: false, reason: 'bad_amount' },
    ]));
    expect(out.accepted.map((r) => r.txnId)).toEqual([1]);
    expect(out.dropped).toBe(1);
  });

  test('margin is normalised to p1 - p2 rather than trusted', () => {
    const r = ok(1, 'Dining', 0.8, 0.1);
    if (r.ok) r.margin = 0.99;
    const out = acceptResults(run, resultsMsg('r1', [r]));
    const a = out.accepted[0];
    expect(a.ok && a.margin).toBeCloseTo(0.7, 10);
  });
});

// ── cache ───────────────────────────────────────────────────────────────────

describe('cache (sessionStorage, per-row state hash)', () => {
  test('fnv1a32 is a stable unsigned 32-bit hash', () => {
    expect(fnv1a32('')).toBe(0x811c9dc5);
    expect(fnv1a32('a')).toBe(0xe40c292c);
    expect(fnv1a32('foobar')).toBe(0xbf9cf968);
  });

  test('a scored row is re-used by a new session on the same key when the state hash matches', () => {
    const storage = memStorage();
    const a = mkSession({ storage });
    const plan = a.s.planRun([row(1), row(2)], { limit: 200 })!;
    expect(plan.items.map((i) => i.txnId)).toEqual([1, 2]);
    a.s.accept(resultsMsg(plan.runId, [ok(1), ok(2, 'Groceries')]));

    const b = mkSession({ storage });
    const plan2 = b.s.planRun([row(1), row(2), row(3)], { limit: 200 })!;
    expect(plan2.items.map((i) => i.txnId)).toEqual([3]);
    expect(b.s.results().get(1)).toMatchObject({ ok: true, choice: 'Dining' });
    expect(b.s.results().get(2)).toMatchObject({ ok: true, choice: 'Groceries' });
  });

  test('uses the spec key wilson-prelabel:v1:<profile>:<labelSetVersion>:<modelId>:<revision>:<templateVersion>', () => {
    const storage = memStorage();
    const { s } = mkSession({ storage });
    const plan = s.planRun([row(1)], { limit: 200 })!;
    s.accept(resultsMsg(plan.runId, [ok(1)]));
    const c = config();
    const key = cacheKey({ profile: c.profile, labelSetVersion: c.labelSetVersion, modelId: c.pins.modelId, revision: c.pins.revision, templateVersion: c.pins.templateVersion });
    expect(storage.data.has(key)).toBe(true);
    expect(key.startsWith('wilson-prelabel:v1:p1:cat-4-aaaaaaaaaaaa:')).toBe(true);
  });

  test('an edited description, amount or date invalidates the cached score', () => {
    const storage = memStorage();
    const a = mkSession({ storage });
    const plan = a.s.planRun([row(1, 'COFFEE', -4.5, '2026-06-01'), row(2, 'FUEL', -40), row(3, 'RENT', -1000)], { limit: 200 })!;
    a.s.accept(resultsMsg(plan.runId, [ok(1), ok(2), ok(3)]));

    const b = mkSession({ storage });
    const plan2 = b.s.planRun([
      row(1, 'COFFEE SHOP', -4.5, '2026-06-01'), // description edited
      row(2, 'FUEL', -41),                       // amount edited
      row(3, 'RENT', -1000, '2026-06-02'),       // date edited
    ], { limit: 200 })!;
    expect(plan2.items.map((i) => i.txnId)).toEqual([1, 2, 3]);
    expect(b.s.results().size).toBe(0);
  });

  test('the hash is over the exact formatState string (a datetime suffix on date does not matter)', () => {
    const storage = memStorage();
    const a = mkSession({ storage });
    const plan = a.s.planRun([row(1, 'COFFEE', -4.5, '2026-06-01')], { limit: 200 })!;
    a.s.accept(resultsMsg(plan.runId, [ok(1)]));
    const b = mkSession({ storage });
    expect(b.s.planRun([row(1, 'COFFEE', -4.5, '2026-06-01T10:00:00Z')], { limit: 200 })).toBeNull();
    expect(formatState({ description: 'COFFEE', amount: -4.5, date: '2026-06-01T10:00:00Z' })).toBe('description: COFFEE | amount: -4.50 | date: 2026-06-01');
  });

  test('a different label set, profile or pin does not hit the cache', () => {
    const storage = memStorage();
    const a = mkSession({ storage });
    const plan = a.s.planRun([row(1)], { limit: 200 })!;
    a.s.accept(resultsMsg(plan.runId, [ok(1)]));
    for (const over of [{ labelSetVersion: 'cat-5-bbbbbbbbbbbb' }, { profile: 'p2' }]) {
      const b = mkSession({ storage, cfg: config(over) });
      expect(b.s.planRun([row(1)], { limit: 200 })!.items.map((i) => i.txnId)).toEqual([1]);
    }
  });

  test('throwing storage: rows are simply re-scored and nothing crashes', () => {
    const { s } = mkSession({ storage: throwingStorage });
    const plan = s.planRun([row(1), row(2)], { limit: 200 })!;
    expect(plan.items).toHaveLength(2);
    const out = s.accept(resultsMsg(plan.runId, [ok(1), ok(2)]));
    expect(out.accepted).toHaveLength(2);
    expect(s.results().size).toBe(2);
    // second plan in the same session does not re-score what is held in memory
    expect(s.planRun([row(1), row(2)], { limit: 200 })).toBeNull();
  });

  test('no storage at all (null) also works', () => {
    const { s } = mkSession({ storage: null });
    const plan = s.planRun([row(1)], { limit: 200 })!;
    expect(s.accept(resultsMsg(plan.runId, [ok(1)])).accepted).toHaveLength(1);
  });

  test('a corrupt or tampered cache entry is ignored', () => {
    const storage = memStorage();
    const c = config();
    const key = cacheKey({ profile: c.profile, labelSetVersion: c.labelSetVersion, modelId: c.pins.modelId, revision: c.pins.revision, templateVersion: c.pins.templateVersion });
    storage.setItem(key, '{not json');
    expect(mkSession({ storage }).s.planRun([row(1)], { limit: 200 })!.items).toHaveLength(1);

    const h = fnv1a32(formatState({ description: 'MERCHANT 1', amount: -11, date: '2026-06-01' }));
    storage.setItem(key, JSON.stringify({ v: 1, rows: { '1': { h, r: { ...ok(1, 'NotALabel') } } } }));
    const t = mkSession({ storage });
    expect(t.s.planRun([row(1)], { limit: 200 })!.items).toHaveLength(1);
    expect(t.s.results().size).toBe(0);
  });

  test('failed rows (ok:false) are not cached', () => {
    const storage = memStorage();
    const a = mkSession({ storage });
    const plan = a.s.planRun([row(1)], { limit: 200 })!;
    a.s.accept(resultsMsg(plan.runId, [{ txnId: 1, ok: false, reason: 'decide_error' }]));
    const b = mkSession({ storage });
    expect(b.s.planRun([row(1)], { limit: 200 })!.items).toHaveLength(1);
  });
});

// ── applyCache ──────────────────────────────────────────────────────────────

describe('applyCache', () => {
  test('puts cache hits into results() without starting a run, and counts what is still unscored', () => {
    const storage = memStorage();
    const a = mkSession({ storage });
    const plan = a.s.planRun([row(1), row(2)], { limit: 200 })!;
    a.s.accept(resultsMsg(plan.runId, [ok(1), ok(2, 'Groceries')]));

    const b = mkSession({ storage });
    expect(b.s.applyCache([row(1), row(2), row(3)])).toBe(1);
    expect(b.s.results().size).toBe(2);
    expect(b.s.hasActiveRun()).toBe(false);
    // a later plan only has the miss left
    expect(b.s.planRun([row(1), row(2), row(3)], { limit: 200 })!.items.map((i) => i.txnId)).toEqual([3]);
  });

  test('an edited row is a miss', () => {
    const storage = memStorage();
    const a = mkSession({ storage });
    const plan = a.s.planRun([row(1, 'COFFEE')], { limit: 200 })!;
    a.s.accept(resultsMsg(plan.runId, [ok(1)]));
    const b = mkSession({ storage });
    expect(b.s.applyCache([row(1, 'COFFEE SHOP')])).toBe(1);
    expect(b.s.results().size).toBe(0);
  });

  test('is a no-op without storage, and after a profile change', async () => {
    const { s } = mkSession({ storage: null });
    expect(s.applyCache([row(1)])).toBe(1);
    const t = mkSession({ storage: memStorage() });
    t.setConfig(config({ profile: 'other' }));
    await t.s.verifyBinding();
    expect(t.s.applyCache([row(1)])).toBe(1);
    expect(t.s.results().size).toBe(0);
  });
});

// ── planRun ─────────────────────────────────────────────────────────────────

describe('planRun', () => {
  test('caps the items at the limit and keeps display order', () => {
    const { s } = mkSession();
    const plan = s.planRun([1, 2, 3, 4, 5].map((i) => row(i)), { limit: 3 })!;
    expect(plan.items.map((i) => i.txnId)).toEqual([1, 2, 3]);
  });

  test('the limit is also clamped to the config maxRowsPerRun', () => {
    const { s } = mkSession({ cfg: config({ maxRowsPerRun: 2 }) });
    expect(s.planRun([1, 2, 3].map((i) => row(i)), { limit: 200 })!.items).toHaveLength(2);
  });

  test('items carry description, amount and the 10-char date for the worker', () => {
    const { s } = mkSession();
    const plan = s.planRun([row(7, 'WHOLE FOODS', -12.3, '2026-06-03T00:00:00Z')], { limit: 200 })!;
    expect(plan.items[0]).toEqual({ txnId: 7, description: 'WHOLE FOODS', amount: -12.3, date: '2026-06-03' });
  });

  test('returns null when every row is already scored', () => {
    const { s } = mkSession();
    const plan = s.planRun([row(1)], { limit: 200 })!;
    s.accept(resultsMsg(plan.runId, [ok(1)]));
    expect(s.planRun([row(1)], { limit: 200 })).toBeNull();
  });

  test('a row that could not be scored (ok:false) is not retried automatically', () => {
    const { s } = mkSession();
    const plan = s.planRun([row(1)], { limit: 200 })!;
    s.accept(resultsMsg(plan.runId, [{ txnId: 1, ok: false, reason: 'empty_description' }]));
    expect(s.planRun([row(1)], { limit: 200 })).toBeNull();
  });

  test('a non-finite amount is passed through so the worker reports bad_amount', () => {
    const { s } = mkSession();
    const plan = s.planRun([row(1, 'X', Number.NaN)], { limit: 200 })!;
    expect(plan.items).toHaveLength(1);
  });

  test('a new plan supersedes the previous run: its results are now stale', () => {
    const { s } = mkSession();
    const p1 = s.planRun([row(1)], { limit: 200 })!;
    const p2 = s.planRun([row(2)], { limit: 200 })!;
    expect(p2.runId).not.toBe(p1.runId);
    expect(s.accept(resultsMsg(p1.runId, [ok(1)])).accepted).toEqual([]);
    expect(s.accept(resultsMsg(p2.runId, [ok(2)])).accepted).toHaveLength(1);
  });
});

// ── accept / done ───────────────────────────────────────────────────────────

describe('session.accept', () => {
  test('counts every drop', () => {
    const { s } = mkSession();
    const plan = s.planRun([row(1)], { limit: 200 })!;
    s.accept(resultsMsg('stale', [ok(1), ok(2)]));
    s.accept(resultsMsg(plan.runId, [ok(77)]));
    expect(s.droppedCount()).toBe(3);
  });

  test('done for the current run finishes it; a done for another run is ignored', () => {
    const { s } = mkSession();
    const plan = s.planRun([row(1)], { limit: 200 })!;
    expect(s.acceptDone(doneMsg('nope'))).toBe(false);
    expect(s.hasActiveRun()).toBe(true);
    expect(s.acceptDone(doneMsg(plan.runId))).toBe(true);
    expect(s.hasActiveRun()).toBe(false);
    // results after done are stale
    expect(s.accept(resultsMsg(plan.runId, [ok(1)])).accepted).toEqual([]);
  });

  test('cancel() makes later worker messages for that run stale', () => {
    const { s } = mkSession();
    const plan = s.planRun([row(1)], { limit: 200 })!;
    s.cancel();
    expect(s.accept(resultsMsg(plan.runId, [ok(1)])).accepted).toEqual([]);
    expect(s.acceptDone(doneMsg(plan.runId))).toBe(false);
  });

  test('results() returns a copy', () => {
    const { s } = mkSession();
    const plan = s.planRun([row(1)], { limit: 200 })!;
    s.accept(resultsMsg(plan.runId, [ok(1)]));
    const m = s.results() as Map<number, PrelabelResult>;
    m.clear();
    expect(s.results().size).toBe(1);
  });
});

// ── profile binding ─────────────────────────────────────────────────────────

describe('profile binding', () => {
  test('an unchanged config re-read is ok and keeps the run and results', async () => {
    const { s } = mkSession();
    const plan = s.planRun([row(1)], { limit: 200 })!;
    s.accept(resultsMsg(plan.runId, [ok(1)]));
    expect(await s.verifyBinding()).toBe('ok');
    expect(s.results().size).toBe(1);
  });

  test('a changed profile cancels the run, discards results and flags profileChanged', async () => {
    const { s, setConfig } = mkSession();
    const plan = s.planRun([row(1), row(2)], { limit: 200 })!;
    s.accept(resultsMsg(plan.runId, [ok(1)]));
    setConfig(config({ profile: 'other' }));
    expect(await s.verifyBinding()).toBe('changed');
    expect(s.profileChanged()).toBe(true);
    expect(s.hasActiveRun()).toBe(false);
    expect(s.results().size).toBe(0);
    expect(s.accept(resultsMsg(plan.runId, [ok(2)])).accepted).toEqual([]);
    expect(s.results().size).toBe(0);
  });

  test('a changed label set or revision also counts as a change', async () => {
    for (const over of [{ labelSetVersion: 'cat-5-bbbbbbbbbbbb' }, { pins: { ...config().pins, revision: '1'.repeat(40) } }]) {
      const { s, setConfig } = mkSession();
      setConfig(config(over));
      expect(await s.verifyBinding()).toBe('changed');
    }
  });

  test('after a change no new run can be planned until bind() again', async () => {
    const { s, setConfig } = mkSession();
    setConfig(config({ profile: 'other' }));
    await s.verifyBinding();
    expect(s.planRun([row(1)], { limit: 200 })).toBeNull();
    s.bind(config({ profile: 'other' }));
    expect(s.profileChanged()).toBe(false);
    expect(s.planRun([row(1)], { limit: 200 })).not.toBeNull();
  });

  test('a failed re-read is reported as error and does not discard anything', async () => {
    const { s } = mkSession({ fetchConfig: async () => { throw new Error('offline'); } });
    const plan = s.planRun([row(1)], { limit: 200 })!;
    s.accept(resultsMsg(plan.runId, [ok(1)]));
    expect(await s.verifyBinding()).toBe('error');
    expect(s.results().size).toBe(1);
    expect(s.profileChanged()).toBe(false);
  });
});

// ── lock ────────────────────────────────────────────────────────────────────

describe('acquirePrelabelLock', () => {
  function fakeLocks(available: boolean) {
    const requests: Array<{ name: string; options: unknown }> = [];
    let released = false;
    const locks = {
      request(name: string, options: { ifAvailable: boolean }, cb: (lock: unknown) => Promise<void> | void) {
        requests.push({ name, options });
        return Promise.resolve(cb(available ? { name } : null));
      },
    };
    return { locks, requests, isReleased: () => released, markReleased: () => (released = true) };
  }

  test('requests wilson-prelabel with ifAvailable and reports held', async () => {
    const f = fakeLocks(true);
    const h = await acquirePrelabelLock(f.locks);
    expect(h.state).toBe('held');
    expect(f.requests).toEqual([{ name: 'wilson-prelabel', options: { ifAvailable: true } }]);
    h.release();
  });

  test('another tab holds it -> locked', async () => {
    const h = await acquirePrelabelLock(fakeLocks(false).locks);
    expect(h.state).toBe('locked');
    h.release();
  });

  test('navigator.locks undefined -> unsupported: the tab runs without the lock', async () => {
    const h = await acquirePrelabelLock(undefined);
    expect(h.state).toBe('unsupported');
    h.release();
  });

  test('a request that throws is treated as unsupported', async () => {
    const h = await acquirePrelabelLock({ request: () => { throw new Error('SecurityError'); } });
    expect(h.state).toBe('unsupported');
  });

  test('release lets the lock callback finish', async () => {
    let finished = false;
    const locks = {
      request: async (_n: string, _o: { ifAvailable: boolean }, cb: (lock: unknown) => Promise<void> | void) => {
        await cb({});
        finished = true;
      },
    };
    const h = await acquirePrelabelLock(locks);
    expect(finished).toBe(false);
    h.release();
    await new Promise((r) => setTimeout(r, 0));
    expect(finished).toBe(true);
  });
});

// ── persisted verdicts ──────────────────────────────────────────────────────

describe('persisted capability verdicts', () => {
  const pins = config().pins;

  test('a real capability failure persists and is read back for the same pin', () => {
    const st = memStorage();
    persistVerdict(st, pins, { verdict: 'unavailable', reason: 'no_shader_f16' });
    expect(readPersistedVerdict(st, pins)).toEqual({ verdict: 'unavailable', reason: 'no_shader_f16' });
    expect(readPersistedVerdict(st, { ...pins, revision: '2'.repeat(40) })).toBeNull();
  });

  test('network failures are not persisted (they retry)', () => {
    const st = memStorage();
    persistVerdict(st, pins, { verdict: 'failed', reason: 'load' });
    expect(readPersistedVerdict(st, pins)).toBeNull();
  });

  test('model_mismatch and first_decision do persist', () => {
    const st = memStorage();
    persistVerdict(st, pins, { verdict: 'failed', reason: 'model_mismatch' });
    expect(readPersistedVerdict(st, pins)).toEqual({ verdict: 'failed', reason: 'model_mismatch' });
  });

  test('throwing or missing storage never throws', () => {
    expect(() => persistVerdict(throwingStorage, pins, { verdict: 'unavailable', reason: 'no_webgpu' })).not.toThrow();
    expect(readPersistedVerdict(throwingStorage, pins)).toBeNull();
    expect(readPersistedVerdict(null, pins)).toBeNull();
  });
});

// ── panel state ─────────────────────────────────────────────────────────────

describe('reducePanel', () => {
  const cap = (verdict: 'ready' | 'unavailable' | 'failed', reason: string | null): FromWorker => ({
    v: 1, type: 'capability', verdict, reason, adapter: null,
  });

  test('starts in init', () => {
    expect(initialPanelState.kind).toBe('init');
  });

  test('config enabled=false -> off', () => {
    expect(reducePanel(initialPanelState, { t: 'config', enabled: false }).kind).toBe('off');
  });

  test('config enabled=true -> probing', () => {
    expect(reducePanel(initialPanelState, { t: 'config', enabled: true }).kind).toBe('probing');
  });

  test('capability ready -> consent (first visit), or loading when previously opted in', () => {
    const probing = reducePanel(initialPanelState, { t: 'config', enabled: true });
    expect(reducePanel(probing, { t: 'worker', msg: cap('ready', null), optedIn: false }).kind).toBe('consent');
    expect(reducePanel(probing, { t: 'worker', msg: cap('ready', null), optedIn: true }).kind).toBe('loading');
  });

  test('capability unavailable -> unavailable with the reason; failed -> failed', () => {
    const probing = reducePanel(initialPanelState, { t: 'config', enabled: true });
    expect(reducePanel(probing, { t: 'worker', msg: cap('unavailable', 'no_webgpu'), optedIn: false })).toEqual({ kind: 'unavailable', reason: 'no_webgpu' });
    expect(reducePanel(probing, { t: 'worker', msg: cap('failed', 'model_mismatch'), optedIn: false })).toMatchObject({ kind: 'failed', reason: 'model_mismatch' });
  });

  test('consent click -> loading; progress updates bytes; loaded -> ready', () => {
    let st = reducePanel(reducePanel(initialPanelState, { t: 'config', enabled: true }), { t: 'worker', msg: cap('ready', null), optedIn: false });
    st = reducePanel(st, { t: 'consent' });
    expect(st.kind).toBe('loading');
    st = reducePanel(st, { t: 'worker', msg: { v: 1, type: 'progress', phase: 'download', loaded: 10, total: 100 }, optedIn: true });
    expect(st).toMatchObject({ kind: 'loading', loaded: 10, total: 100 });
    st = reducePanel(st, {
      t: 'worker',
      msg: { v: 1, type: 'loaded', loadMs: 1, fromCache: true, firstDecisionMs: 1, runtime: { transformers: '4', ort: '1', openJev: '0.1.2', device: 'webgpu', dtype: 'q4f16' }, configSha: 'a'.repeat(64) },
      optedIn: true,
    });
    expect(st.kind).toBe('ready');
  });

  test('run started -> running; done -> ready; cancelled done -> ready', () => {
    let st: ReturnType<typeof reducePanel> = { kind: 'ready' };
    st = reducePanel(st, { t: 'run_started', total: 49 });
    expect(st).toEqual({ kind: 'running', done: 0, total: 49, p50Ms: null });
    st = reducePanel(st, { t: 'run_progress', done: 25 });
    expect(st).toMatchObject({ kind: 'running', done: 25 });
    st = reducePanel(st, { t: 'worker', msg: doneMsg('r'), optedIn: true });
    expect(st.kind).toBe('ready');
  });

  test('run_ended (cancel) returns running to ready and is a no-op elsewhere', () => {
    expect(reducePanel({ kind: 'running', done: 3, total: 9, p50Ms: 80 }, { t: 'run_ended' })).toEqual({ kind: 'ready' });
    expect(reducePanel({ kind: 'consent' }, { t: 'run_ended' })).toEqual({ kind: 'consent' });
  });

  test('a fatal worker error -> failed with detail; a non-fatal one leaves the state alone', () => {
    const running: ReturnType<typeof reducePanel> = { kind: 'running', done: 1, total: 5, p50Ms: null };
    expect(reducePanel(running, { t: 'worker', msg: { v: 1, type: 'error', fatal: true, code: 'load', detail: 'boom' }, optedIn: true }))
      .toEqual({ kind: 'failed', reason: 'load', detail: 'boom' });
    expect(reducePanel(running, { t: 'worker', msg: { v: 1, type: 'error', fatal: false, code: 'decide', detail: 'x' }, optedIn: true })).toEqual(running);
  });

  test('label_set_too_large (non-fatal) still fails the panel, because no run can ever succeed', () => {
    expect(reducePanel({ kind: 'running', done: 0, total: 5, p50Ms: null }, { t: 'worker', msg: { v: 1, type: 'error', fatal: false, code: 'label_set_too_large', detail: '250 tokens' }, optedIn: true }))
      .toMatchObject({ kind: 'failed', reason: 'label_set_too_large' });
  });

  test('locked, spawn_failed and profile_changed events', () => {
    expect(reducePanel(initialPanelState, { t: 'locked' }).kind).toBe('locked');
    expect(reducePanel(initialPanelState, { t: 'spawn_failed', reason: 'dev_cross_origin' })).toEqual({ kind: 'unavailable', reason: 'dev_cross_origin' });
    expect(reducePanel({ kind: 'ready' }, { t: 'profile_changed' }).kind).toBe('profile_changed');
  });

  test('profile_changed is terminal until a reload: later worker messages do not revive the panel', () => {
    const st = reducePanel({ kind: 'ready' }, { t: 'profile_changed' });
    expect(reducePanel(st, { t: 'run_started', total: 3 }).kind).toBe('profile_changed');
    expect(reducePanel(st, { t: 'worker', msg: doneMsg('r'), optedIn: true }).kind).toBe('profile_changed');
  });

  test('retry from failed goes back to probing', () => {
    expect(reducePanel({ kind: 'failed', reason: 'load', detail: 'x' }, { t: 'retry' }).kind).toBe('probing');
  });
});

describe('workerPins', () => {
  test('drops approxDownloadBytes: the worker protocol rejects extra keys', () => {
    const p = workerPins(config().pins);
    expect('approxDownloadBytes' in p).toBe(false);
    expect(Object.keys(p).sort()).toEqual(['configSha', 'device', 'dtype', 'modelId', 'repo', 'revision', 'temperature', 'templateVersion']);
  });
});

// ── Round 2 fix 4: the lock is taken after consent, not on mount ─────────────

/** navigator.locks semantics for `ifAvailable`: exclusive per name, shared by every "tab" that uses the same instance. */
function exclusiveLocks() {
  const held = new Set<string>();
  const requests: string[] = [];
  const locks: LockManagerLike = {
    async request(name, _options, cb) {
      requests.push(name);
      if (held.has(name)) {
        await cb(null);
        return;
      }
      held.add(name);
      try {
        await cb({ name });
      } finally {
        held.delete(name);
      }
    },
  };
  return { locks, requests, isHeld: (n = 'wilson-prelabel') => held.has(n) };
}

describe('createLockGate', () => {
  test('creating the gate (what mount does) requests nothing', () => {
    const f = exclusiveLocks();
    createLockGate(f.locks);
    expect(f.requests).toEqual([]);
    expect(f.isHeld()).toBe(false);
  });

  test('ensure() takes the lock once, concurrent and repeated calls share it', async () => {
    const f = exclusiveLocks();
    const gate = createLockGate(f.locks);
    const [a, b] = await Promise.all([gate.ensure(), gate.ensure()]);
    expect(a).toBe('held');
    expect(b).toBe('held');
    expect(await gate.ensure()).toBe('held');
    expect(f.requests).toEqual(['wilson-prelabel']);
    gate.release();
  });

  test('a second tab that has not consented never sees "locked" while the first tab only shows the consent panel', async () => {
    const f = exclusiveLocks();
    const tabA = createLockGate(f.locks); // mounted, panel on consent, never clicked
    const tabB = createLockGate(f.locks);
    void tabA; // mount took no lock
    expect(await tabB.ensure()).toBe('held'); // tab B's user consents first: it may load
    tabB.release();
  });

  test('once tab A consented (is loading or running), tab B is told locked; it can retry after A releases', async () => {
    const f = exclusiveLocks();
    const tabA = createLockGate(f.locks);
    const tabB = createLockGate(f.locks);
    expect(await tabA.ensure()).toBe('held');
    expect(await tabB.ensure()).toBe('locked');
    tabA.release();
    await new Promise((r) => setTimeout(r, 0));
    expect(f.isHeld()).toBe(false);
    expect(await tabB.ensure()).toBe('held'); // a "locked" answer is not cached
    tabB.release();
  });

  test('release() frees the lock, and the next ensure() requests it again', async () => {
    const f = exclusiveLocks();
    const gate = createLockGate(f.locks);
    await gate.ensure();
    gate.release();
    await new Promise((r) => setTimeout(r, 0));
    expect(f.isHeld()).toBe(false);
    expect(await gate.ensure()).toBe('held');
    expect(f.requests.length).toBe(2);
    gate.release();
  });

  test('release() before ensure() is a no-op; no Web Locks means unsupported (the tab runs without)', async () => {
    const gate = createLockGate(undefined);
    gate.release();
    expect(await gate.ensure()).toBe('unsupported');
  });

  test('release() while the request is still in flight drops the lock when it lands', async () => {
    const f = exclusiveLocks();
    const gate = createLockGate(f.locks);
    const p = gate.ensure();
    gate.release();
    await p;
    await new Promise((r) => setTimeout(r, 0));
    expect(f.isHeld()).toBe(false);
  });
});

describe('reducePanel: a refused lock after consent', () => {
  test('consent -> locked and loading -> locked both land on "running in another tab"', () => {
    expect(reducePanel({ kind: 'consent' }, { t: 'locked' }).kind).toBe('locked');
    expect(reducePanel({ kind: 'loading', phase: 'download', loaded: 0, total: 0 }, { t: 'locked' }).kind).toBe('locked');
  });
});

// ── Round 2 fix 3: a failed turn-on is explained, not thrown ────────────────

describe('describeTurnOnError', () => {
  test('403 origin_required says the change must come from the dashboard page', () => {
    const err = new Error('API 403: {"error":{"code":"origin_required","message":"This action must come from the dashboard page in a browser."}}');
    const msg = describeTurnOnError(err);
    expect(msg).toContain('dashboard page');
    expect(msg.toLowerCase()).not.toContain('api 403');
  });

  test('403 forbidden says an admin is needed', () => {
    expect(describeTurnOnError(new Error('API 403: {"error":{"code":"forbidden","message":"Forbidden"}}'))).toMatch(/admin/i);
  });

  test('a connection failure says the server could not be reached', () => {
    const e = new Error('This action requires a connection to the Wilson server.');
    e.name = 'RequiresConnectionError';
    expect(describeTurnOnError(e)).toMatch(/reach|connect/i);
    expect(describeTurnOnError(new TypeError('Failed to fetch'))).toMatch(/reach|connect/i);
  });

  test('anything else gets a generic message that carries the status, and non-Error values do not throw', () => {
    expect(describeTurnOnError(new Error('API 500: boom'))).toContain('500');
    expect(describeTurnOnError('weird').length).toBeGreaterThan(0);
    expect(describeTurnOnError(undefined).length).toBeGreaterThan(0);
  });
});
