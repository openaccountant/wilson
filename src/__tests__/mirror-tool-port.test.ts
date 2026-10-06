import { afterAll, beforeAll, describe, expect, setSystemTime, test } from 'bun:test';
import { buildParityFixture, PARITY_NOW, type ParityFixture } from './mirror-tool-fixtures.js';
import { createMirrorDb } from './mirror-helpers.js';
import { initTransactionSearchTool, transactionSearchTool } from '../tools/query/transaction-search.js';
import {
  handlePortMessage,
  servePort,
  type PortContext,
  type PortHost,
  type PortLike,
  type MirrorPortResponse,
  type MirrorPortStatus,
} from '../dashboard/ui/src/store/mirror-port-protocol.js';
import { MIRROR_SCHEMA_VERSION } from '../dashboard/ui/src/store/mirror-schema.js';
import type { ToolReadResult } from '../dashboard/ui/src/store/mirror-tools.js';

/**
 * The model worker reaches the mirror ONLY through a scoped MessagePort. This
 * suite pins the capability boundary against the pure handlePortMessage:
 * only `status` and `toolRead` are accepted, args are re-validated on the
 * mirror side, and a port is bound to the profile it was opened for.
 */

let fx: ParityFixture;
const NOW_ISO = new Date(PARITY_NOW).toISOString();

function ctx(overrides: Partial<PortContext> = {}): PortContext {
  return { profile: 'default', boundProfile: 'default', seeded: true, lastSyncedAt: '2026-07-15T11:59:00.000Z', ...overrides };
}

beforeAll(async () => {
  setSystemTime(new Date(PARITY_NOW));
  fx = await buildParityFixture();
  initTransactionSearchTool(fx.serverDb);
});

afterAll(() => {
  setSystemTime();
});

describe('status', () => {
  test('returns servable tools, categories, schema version and sync info', async () => {
    const res = await handlePortMessage(fx.mirror, ctx(), { id: 7, t: 'status' });
    expect(res.id).toBe(7);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const st = res.result as MirrorPortStatus;
    expect(st.profile).toBe('default');
    expect(st.seeded).toBe(true);
    expect(st.lastSyncedAt).toBe('2026-07-15T11:59:00.000Z');
    expect(st.schemaVersion).toBe(MIRROR_SCHEMA_VERSION);
    expect(st.servable).toEqual(['transaction_search', 'spending_summary', 'profit_loss', 'net_worth', 'forecast']);
    expect(st.categories).toContain('Dining');
    expect(st.categories).toContain('Groceries');
  });

  test('unseeded mirror advertises nothing', async () => {
    const res = await handlePortMessage(fx.mirror, ctx({ seeded: false }), { id: 1, t: 'status' });
    if (!res.ok) throw new Error('expected ok');
    const st = res.result as MirrorPortStatus;
    expect(st.seeded).toBe(false);
    expect(st.servable).toEqual([]);
    expect(st.categories).toEqual([]);
  });

  test('a null binding (worker has no open profile) is reported, not thrown', async () => {
    const res = await handlePortMessage(null, ctx({ seeded: false, profile: null }), { id: 2, t: 'status' });
    if (!res.ok) throw new Error('expected ok');
    expect((res.result as MirrorPortStatus).profile).toBeNull();
  });
});

describe('toolRead', () => {
  test('returns data deep-equal to the real server tool, tagged with the profile', async () => {
    const args = { query: 'Whole Foods in June' };
    const res = await handlePortMessage(fx.mirror, ctx(), { id: 3, t: 'toolRead', tool: 'transaction_search', args, nowIso: NOW_ISO });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const r = res.result as ToolReadResult;
    if (!r.servable) throw new Error('expected servable');
    expect(r.profile).toBe('default');
    expect(r.data).toEqual(JSON.parse(await transactionSearchTool.func(args)).data);
    expect(r.summary.length).toBeLessThanOrEqual(1200);
  });

  test('empty args are accepted for tools with all-optional args (defaults applied mirror-side)', async () => {
    const res = await handlePortMessage(fx.mirror, ctx(), { id: 4, t: 'toolRead', tool: 'spending_summary', args: {}, nowIso: NOW_ISO });
    expect(res.ok).toBe(true);
    if (res.ok) expect((res.result as ToolReadResult).servable).toBe(true);
  });

  test('unseeded mirror -> servable:false not-seeded', async () => {
    const res = await handlePortMessage(fx.mirror, ctx({ seeded: false }), {
      id: 5, t: 'toolRead', tool: 'transaction_search', args: { query: 'x' }, nowIso: NOW_ISO,
    });
    expect(res).toEqual({ id: 5, ok: true, result: { servable: false, why: 'not-seeded' } });
  });

  test('null binding -> not-seeded', async () => {
    const res = await handlePortMessage(null, ctx({ profile: null }), {
      id: 6, t: 'toolRead', tool: 'transaction_search', args: { query: 'x' }, nowIso: NOW_ISO,
    });
    expect(res).toEqual({ id: 6, ok: true, result: { servable: false, why: 'not-seeded' } });
  });

  test.each([
    ['net_worth', { action: 'summary' }],
    ['forecast', {}],
  ] as const)('%s is served on the v4 mirror', async (tool, args) => {
    const res = await handlePortMessage(fx.mirror, ctx(), { id: 8, t: 'toolRead', tool, args, nowIso: NOW_ISO });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const r = res.result as ToolReadResult;
    if (!r.servable) throw new Error('expected servable');
    expect(r.profile).toBe('default');
  });

  test('net_worth trend is licensed server-side and never served on the port', async () => {
    const res = await handlePortMessage(fx.mirror, ctx(), { id: 8, t: 'toolRead', tool: 'net_worth', args: { action: 'trend' }, nowIso: NOW_ISO });
    expect(res).toEqual({ id: 8, ok: true, result: { servable: false, why: 'licensed' } });
  });

  test('a mirror without the accounts table -> missing-tables for net_worth and forecast', async () => {
    const bare = await createMirrorDb();
    await bare.exec('DROP TABLE accounts');
    for (const [tool, args] of [['net_worth', { action: 'summary' }], ['forecast', {}]] as const) {
      const res = await handlePortMessage(bare, ctx(), { id: 8, t: 'toolRead', tool, args, nowIso: NOW_ISO });
      expect(res).toEqual({ id: 8, ok: true, result: { servable: false, why: 'missing-tables' } });
    }
  });

  test('[C7] a read after the worker profile changed from the bound profile is rejected', async () => {
    const res = await handlePortMessage(fx.mirror, ctx({ profile: 'other', boundProfile: 'default' }), {
      id: 9, t: 'toolRead', tool: 'transaction_search', args: { query: 'Netflix' }, nowIso: NOW_ISO,
    });
    expect(res).toEqual({ id: 9, ok: true, result: { servable: false, why: 'not-seeded' } });
  });

  test('[C7] the profile on the result is the bound profile it ran against', async () => {
    const res = await handlePortMessage(fx.mirror, ctx({ profile: 'work', boundProfile: 'work' }), {
      id: 10, t: 'toolRead', tool: 'profit_loss', args: {}, nowIso: NOW_ISO,
    });
    if (!res.ok) throw new Error('expected ok');
    const r = res.result as ToolReadResult;
    expect(r.servable && r.profile).toBe('work');
  });
});

describe('capability boundary', () => {
  test.each(['applySync', 'setProfile', 'serve', 'init', 'attachPort'])('t:%s is rejected and does nothing', async (t) => {
    const before = await fx.mirror.prepare('SELECT COUNT(*) AS n FROM transactions').get();
    const res = await handlePortMessage(fx.mirror, ctx(), {
      id: 11, t, profile: 'evil', path: '/api/transactions', payload: { profile: 'evil', transactions: [], entities: [], budgets: [], categories: [] },
    });
    expect(res.ok).toBe(false);
    expect(res.id).toBe(11);
    const after = await fx.mirror.prepare('SELECT COUNT(*) AS n FROM transactions').get();
    expect(after).toEqual(before);
  });

  test('main-channel style messages ({type}) are rejected', async () => {
    for (const type of ['applySync', 'setProfile', 'serve']) {
      const res = await handlePortMessage(fx.mirror, ctx(), { id: 12, type, path: '/api/transactions' });
      expect(res.ok).toBe(false);
    }
  });

  test.each([
    ['null', null],
    ['string', 'status'],
    ['number', 5],
    ['array', []],
    ['empty object', {}],
    ['non-numeric id', { id: 'a', t: 'status' }],
    ['no t', { id: 1 }],
    ['unknown t', { id: 1, t: 'bogus' }],
    ['toolRead without tool', { id: 1, t: 'toolRead', args: {}, nowIso: NOW_ISO }],
    ['toolRead without nowIso', { id: 1, t: 'toolRead', tool: 'profit_loss', args: {} }],
    ['toolRead bad nowIso', { id: 1, t: 'toolRead', tool: 'profit_loss', args: {}, nowIso: 'not a date' }],
    ['toolRead args missing', { id: 1, t: 'toolRead', tool: 'profit_loss', nowIso: NOW_ISO }],
  ])('malformed message (%s) -> {ok:false}, never throws', async (_name, msg) => {
    const res = await handlePortMessage(fx.mirror, ctx(), msg);
    expect(res.ok).toBe(false);
    expect(typeof res.id).toBe('number');
  });

  test.each([
    ['unknown tool', { tool: 'tax_flag', args: { action: 'summary' } }],
    ['mutating tool', { tool: 'categorize_transaction', args: { id: 1, category: 'Dining' } }],
    ['prototype name', { tool: '__proto__', args: {} }],
    ['unknown arg key', { tool: 'transaction_search', args: { query: 'x', bogus: 5 } }],
    ['wrong arg type', { tool: 'transaction_search', args: { query: 5 } }],
    ['bad enum', { tool: 'spending_summary', args: { period: 'week' } }],
    ['bad number', { tool: 'profit_loss', args: { offset: '1' } }],
    ['missing required', { tool: 'transaction_search', args: {} }],
  ])('[C7] mirror-side re-validation rejects: %s', async (_name, part) => {
    const res = await handlePortMessage(fx.mirror, ctx(), { id: 13, t: 'toolRead', nowIso: NOW_ISO, ...part });
    expect(res.ok).toBe(false);
    expect(res.id).toBe(13);
  });
});

describe('servePort wiring', () => {
  function fakePort(): PortLike & { sent: unknown[]; closed: boolean; deliver(data: unknown): void } {
    const port = {
      sent: [] as unknown[],
      closed: false,
      onmessage: null as ((ev: { data: unknown }) => void) | null,
      postMessage(m: unknown) {
        port.sent.push(m);
      },
      close() {
        port.closed = true;
      },
      deliver(data: unknown) {
        port.onmessage?.({ data });
      },
    };
    return port;
  }

  function host(order: string[], gate?: Promise<void>): PortHost & { chain: Promise<unknown> } {
    const h = {
      chain: Promise.resolve() as Promise<unknown>,
      getBinding: () => fx.mirror,
      getContext: async () => {
        order.push('ctx');
        return { profile: 'default', seeded: true, lastSyncedAt: null };
      },
      enqueue<T>(fn: () => Promise<T>): Promise<T> {
        const run = h.chain.then(async () => {
          if (gate) await gate;
          return fn();
        });
        h.chain = run.catch(() => undefined);
        return run;
      },
    };
    return h;
  }

  test('answers on the same port through the host chain, bound to the given profile', async () => {
    const port = fakePort();
    const order: string[] = [];
    servePort(port, 'default', host(order));
    port.deliver({ id: 1, t: 'status' });
    await new Promise((r) => setTimeout(r, 10));
    expect(port.sent).toHaveLength(1);
    const res = port.sent[0] as MirrorPortResponse;
    expect(res.ok).toBe(true);
    expect(order).toEqual(['ctx']);
  });

  test('a port message waits behind in-flight chain work (never sees a half-applied sync)', async () => {
    const port = fakePort();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    servePort(port, 'default', host([], gate));
    port.deliver({ id: 1, t: 'status' });
    await new Promise((r) => setTimeout(r, 10));
    expect(port.sent).toHaveLength(0);
    release();
    await new Promise((r) => setTimeout(r, 10));
    expect(port.sent).toHaveLength(1);
  });

  test('a throwing handler still answers {ok:false} instead of leaving the caller hanging', async () => {
    const port = fakePort();
    const h = host([]);
    h.getContext = async () => {
      throw new Error('boom');
    };
    servePort(port, 'default', h);
    port.deliver({ id: 4, t: 'status' });
    await new Promise((r) => setTimeout(r, 10));
    expect(port.sent).toHaveLength(1);
    expect(port.sent[0]).toMatchObject({ id: 4, ok: false });
  });

  test('a profile switch between two reads on one port rejects the second', async () => {
    const port = fakePort();
    let current = 'default';
    const h = host([]);
    h.getContext = async () => ({ profile: current, seeded: true, lastSyncedAt: null });
    servePort(port, 'default', h);
    const read = { t: 'toolRead', tool: 'transaction_search', args: { query: 'Netflix' }, nowIso: NOW_ISO };
    port.deliver({ id: 1, ...read });
    await new Promise((r) => setTimeout(r, 10));
    current = 'other';
    port.deliver({ id: 2, ...read });
    await new Promise((r) => setTimeout(r, 10));
    const [first, second] = port.sent as MirrorPortResponse[];
    expect(first.ok && (first.result as ToolReadResult).servable).toBe(true);
    expect(second).toEqual({ id: 2, ok: true, result: { servable: false, why: 'not-seeded' } });
  });
});

describe('createMirrorDb unseeded sanity', () => {
  test('an empty mirror still answers status without throwing', async () => {
    const empty = await createMirrorDb();
    const res = await handlePortMessage(empty, ctx({ seeded: false }), { id: 1, t: 'status' });
    expect(res.ok).toBe(true);
  });
});
