import { describe, expect, test } from 'bun:test';
import { CATEGORIES } from '../tools/categorize/categories.js';
import { createPortClient, runSubagentOnPort } from '../dashboard/ui/src/hybrid/subagent-runner.js';
import { DEFAULT_SUBAGENT_LIMITS, type StepEvent } from '../dashboard/ui/src/hybrid/worker-protocol.js';
import type { PortLike } from '../dashboard/ui/src/store/mirror-port-protocol.js';
import type { GenerateRequest, SubagentInput } from '../dashboard/ui/src/hybrid/subagent-core.js';

/**
 * The worker side of a subagent run (spec sections 4.3 and 5), driven over a
 * fake MessagePort: the port client (id-correlated requests, timeouts, close)
 * and runSubagentOnPort (the pure loop wired to a port + a generate function).
 * model.worker.ts is a thin shell over these, so everything decidable without a
 * browser is pinned here.
 */

const SYNCED = new Date().toISOString();

/** A MessagePort stand-in: the "mirror" end is a handler that answers requests. */
class FakePort implements PortLike {
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  posted: Array<Record<string, unknown>> = [];
  closed = false;
  handler: (msg: Record<string, unknown>, port: FakePort) => void;
  constructor(handler?: (msg: Record<string, unknown>, port: FakePort) => void) {
    this.handler = handler ?? (() => {});
  }
  postMessage(message: unknown): void {
    this.posted.push(message as Record<string, unknown>);
    queueMicrotask(() => this.handler(message as Record<string, unknown>, this));
  }
  reply(data: unknown): void {
    this.onmessage?.({ data });
  }
  close(): void {
    this.closed = true;
  }
}

const STATUS = {
  profile: 'default',
  seeded: true,
  lastSyncedAt: SYNCED,
  schemaVersion: 3,
  servable: ['transaction_search', 'spending_summary', 'profit_loss'],
  categories: CATEGORIES,
};

const PNL = {
  servable: true,
  profile: 'default',
  data: { period: 'June 2026', totalIncome: 5000, totalExpenses: 2000, netProfit: 3000, formatted: 'P&L June 2026\nNet: $3,000.00' },
  summary: 'P&L June 2026\nIncome: $5,000.00\nExpenses: $2,000.00\nNet: $3,000.00',
};

function mirrorPort(): FakePort {
  return new FakePort((msg, port) => {
    if (msg.t === 'status') port.reply({ id: msg.id, ok: true, result: STATUS });
    else if (msg.t === 'toolRead') port.reply({ id: msg.id, ok: true, result: PNL });
  });
}

describe('createPortClient', () => {
  test('posts the exact port-protocol requests and resolves by id, out of order', async () => {
    const answers: Array<() => void> = [];
    const port = new FakePort((msg, p) => {
      answers.push(() => p.reply({ id: msg.id, ok: true, result: msg.t === 'status' ? STATUS : PNL }));
    });
    const client = createPortClient(port);
    const s = client.status();
    const r = client.toolRead({ tool: 'profit_loss', args: { period: 'month' }, nowIso: '2026-07-15T12:00:00.000Z' });
    await Promise.resolve();
    await Promise.resolve();
    expect(port.posted[0]).toEqual({ id: expect.any(Number), t: 'status' });
    expect(port.posted[1]).toEqual({
      id: expect.any(Number),
      t: 'toolRead',
      tool: 'profit_loss',
      args: { period: 'month' },
      nowIso: '2026-07-15T12:00:00.000Z',
    });
    expect(port.posted[0].id).not.toBe(port.posted[1].id);
    answers[1]();
    answers[0]();
    expect((await s).profile).toBe('default');
    expect((await r).servable).toBe(true);
  });

  test('an {ok:false} response rejects with its error; unknown ids and junk are ignored', async () => {
    const port = new FakePort((msg, p) => {
      p.reply({ id: 9999, ok: true, result: STATUS });
      p.reply('junk');
      p.reply({ id: msg.id, ok: false, error: 'invalid args: bad' });
    });
    const client = createPortClient(port);
    await expect(client.toolRead({ tool: 'profit_loss', args: {}, nowIso: 'x' })).rejects.toThrow('invalid args: bad');
  });

  test('a request nobody answers rejects after the timeout', async () => {
    const client = createPortClient(new FakePort(), { requestTimeoutMs: 20 });
    await expect(client.status()).rejects.toThrow(/timeout/i);
  });

  test('close() closes the port and rejects whatever is still pending', async () => {
    const port = new FakePort();
    const client = createPortClient(port);
    const p = client.status();
    client.close();
    await expect(p).rejects.toThrow(/closed/i);
    expect(port.closed).toBe(true);
    // Using a closed client fails fast instead of hanging.
    await expect(client.status()).rejects.toThrow(/closed/i);
  });
});

function input(query: string, over: Partial<SubagentInput> = {}): SubagentInput {
  return {
    query,
    nowIso: '2026-07-15T12:00:00.000Z',
    expectedProfile: 'default',
    priorLocalTurns: [],
    limits: { ...DEFAULT_SUBAGENT_LIMITS, compose: 'model' }, // Round 3: these tests drive the model compose path (device fault, abort reaching generate)
    ...over,
  };
}

const generateOk = async (req: GenerateRequest): Promise<string> =>
  req.kind === 'compose' ? 'Your net profit for June 2026 was $3,000.00.' : 'ANSWER';

describe('runSubagentOnPort', () => {
  test('answers a P&L question over the port, emits step events, closes the port', async () => {
    const port = mirrorPort();
    const events: StepEvent[] = [];
    const res = await runSubagentOnPort({ port, generate: generateOk, input: input('Give me a P&L for June'), emit: (e) => events.push(e) });
    expect(res.deviceFault).toBe(false);
    expect(res.outcome.kind).toBe('answer');
    if (res.outcome.kind !== 'answer') return;
    expect(res.outcome.text).toContain('$3,000.00');
    expect(res.outcome.steps[0].tool).toBe('profit_loss');
    expect(events.map((e) => e.kind)).toEqual(['gate', 'route', 'tool', 'compose']);
    // Only status + toolRead ever cross the port.
    expect(new Set(port.posted.map((m) => m.t))).toEqual(new Set(['status', 'toolRead']));
    expect(port.closed).toBe(true);
  });

  test('a profile mismatch is a mirror-stale handoff, never a read', async () => {
    const port = new FakePort((msg, p) => {
      if (msg.t === 'status') p.reply({ id: msg.id, ok: true, result: { ...STATUS, profile: 'other' } });
    });
    const res = await runSubagentOnPort({ port, generate: generateOk, input: input('Give me a P&L for June') });
    expect(res.outcome.kind).toBe('handoff');
    if (res.outcome.kind === 'handoff') expect(res.outcome.reason).toBe('mirror-stale');
    expect(port.posted.some((m) => m.t === 'toolRead')).toBe(false);
    expect(port.closed).toBe(true);
  });

  test('an unseeded mirror asks for bundle mode, not a handoff', async () => {
    const port = new FakePort((msg, p) => {
      if (msg.t === 'status') p.reply({ id: msg.id, ok: true, result: { ...STATUS, seeded: false, servable: [] } });
    });
    const res = await runSubagentOnPort({ port, generate: generateOk, input: input('Give me a P&L for June') });
    expect(res.outcome).toEqual({ kind: 'bundle-fallback' });
  });

  test('a generation failure is a handoff(error) AND flags the device fault so the worker is respawned', async () => {
    const port = mirrorPort();
    const res = await runSubagentOnPort({
      port,
      generate: async () => {
        throw new Error('WebGPU device error(3): Failed to allocate memory for buffer mapping');
      },
      input: input('Give me a P&L for June'),
    });
    expect(res.outcome.kind).toBe('handoff');
    if (res.outcome.kind === 'handoff') expect(res.outcome.reason).toBe('error');
    expect(res.deviceFault).toBe(true);
    expect(port.closed).toBe(true);
  });

  test('an already-aborted signal resolves cancelled without touching the port or the model', async () => {
    const port = mirrorPort();
    const ac = new AbortController();
    ac.abort();
    let generated = 0;
    const res = await runSubagentOnPort({
      port,
      generate: async (r) => {
        generated++;
        return generateOk(r);
      },
      input: input('Give me a P&L for June'),
      signal: ac.signal,
    });
    expect(res.outcome).toEqual({ kind: 'cancelled' });
    expect(generated).toBe(0);
    expect(port.closed).toBe(true);
  });

  test('aborting mid-generation cancels the run and the abort reaches generate()', async () => {
    const port = mirrorPort();
    const ac = new AbortController();
    let sawSignal = false;
    const res = await runSubagentOnPort({
      port,
      generate: (req) =>
        new Promise<string>((resolve) => {
          if (req.signal) {
            sawSignal = true;
            req.signal.addEventListener('abort', () => resolve('ANSWER'));
          }
          setTimeout(() => ac.abort(), 5);
        }),
      input: input('Give me a P&L for June'),
      signal: ac.signal,
    });
    expect(sawSignal).toBe(true);
    expect(res.outcome.kind).toBe('cancelled');
    expect(res.deviceFault).toBe(false);
  });

  test('never rejects: a port that throws on postMessage still yields an outcome', async () => {
    const port = new FakePort();
    port.postMessage = () => {
      throw new Error('port gone');
    };
    const res = await runSubagentOnPort({ port, generate: generateOk, input: input('Give me a P&L for June') });
    expect(['handoff', 'bundle-fallback']).toContain(res.outcome.kind);
  });
});
