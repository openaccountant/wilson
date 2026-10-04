import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AgentFormSession,
  HUMAN_AUTHORIZED,
  handleDeclarativeSubmit,
  isBrowserAgentFill,
  type FormClass,
  type SubmitEventLike,
  type TouchedEvent,
} from '../dashboard/declarative-submit-core.js';

/**
 * G1: a person submitting a read or page form an agent filled (the HUMAN route) is an explicit decision about those
 * values. It must release the value guard; and whatever way the agent-touched flag drops, the guard is never left
 * active with the flag cleared (otherwise `effectsHeld` / `busy` stay true forever and the form ignores the person).
 *
 * `Harness` wires the pure pieces exactly the way `useDeclarativeTool` does (same session, same handleDeclarativeSubmit
 * callbacks), so the invariant is checked on the real code, no React renderer needed.
 */

type Answer = 'committed' | 'rejected' | 'throw';

class Harness {
  readonly session: AgentFormSession<string>;
  human = 'human';
  restored: string[] = [];
  applied: string[] = [];
  cleared = 0;
  pending: Array<() => Promise<void>> = [];

  constructor(readonly classification: FormClass, readonly toolName: string) {
    this.session = new AgentFormSession<string>(toolName);
  }

  get held() { return this.session.guard.held; }
  get active() { return this.session.guard.active; }
  get touched() { return this.session.tracker.touched; }

  private take(r: { touched: boolean; cleared: boolean; restore: { value: string } | null }) {
    if (r.restore) { this.restored.push(r.restore.value); this.human = r.restore.value; }
    if (r.cleared) this.cleared += 1;
  }

  event(event: TouchedEvent) {
    // The hook: an activation of a form that is not live is dropped before it reaches the session.
    this.take(this.session.apply(event, { policy: 'ask', take: () => this.human }));
    if (event.type === 'toolactivated') this.human = 'agent-filled';
  }

  /** The hook's onSubmit. Returns a function that completes the submit (resolves the server call and settles). */
  submit(by: 'human' | 'agent', answer: Answer = 'committed') {
    // The hook: an agentInvoked submit activates the session BEFORE its tokens are taken (Chrome 154 dispatches the submit
    // before `toolactivated`).
    if (by === 'agent') this.take(this.session.apply({ type: 'agentsubmit' }, { policy: 'ask', take: () => this.human }));
    const { tracker, guard } = this.session;
    const token = tracker.beginSubmit();
    const guardToken = guard.beginSubmit();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const ev: SubmitEventLike = { agentInvoked: by === 'agent', preventDefault: () => {}, respondWith: () => {} };
    const result = handleDeclarativeSubmit({
      nativeEvent: ev,
      classification: this.classification,
      agentTouched: tracker.touched,
      toolName: this.toolName,
      getArgs: () => ({ v: this.human }),
      callServerTool: async () => {
        await gate;
        if (answer === 'throw') throw new Error('refused');
        return answer === 'committed' ? { authorized: true } : { outcome: 'rejected', operationId: 'op' };
      },
      afterServer: (args) => { this.applied.push(String(args.v)); return 'ok'; },
      onAuthorized: () => { guard.authorize(guardToken); },
      onUnauthorized: () => {
        const { restore } = guard.discard(guardToken);
        if (restore) { this.restored.push(restore.value); this.human = restore.value; }
      },
      onHumanSubmit: (args) => { this.applied.push(`human:${String(args.v)}`); },
    });
    const finish = async () => {
      release();
      await result.settled;
      this.take(this.session.settle(token));
    };
    if (result.route === 'human' || result.route === 'blocked') return { route: result.route, finish };
    this.pending.push(finish);
    return { route: result.route, finish };
  }
}

const invariant = (h: Harness, where: string) => {
  if (!h.touched) expect(h.active, `${where}: tracker cleared but guard still active`).toBe(false);
  if (!h.active) expect(h.held, `${where}: guard inactive but still holding`).toBe(false);
};

describe('G1: the verifier repro (human route, then toolcancel)', () => {
  for (const [classification, tool] of [['read', 'filter_transactions'], ['page', 'set_forecast_inputs']] as const) {
    test(`${classification} form: activate, human submit, settle, toolcancel leaves held:false and the form takes human edits`, async () => {
      const h = new Harness(classification, tool);
      h.event({ type: 'toolactivated', toolName: tool });
      expect(h.held).toBe(true);
      expect(h.active).toBe(true);

      const sub = h.submit('human');
      expect(sub.route).toBe('human');
      // The person's decision releases the guard at once, before the page's own handler runs.
      expect(h.held).toBe(false);
      expect(h.active).toBe(false);
      await sub.finish();
      expect(h.touched).toBe(false);

      h.event({ type: 'toolcancel', toolName: tool });
      expect(h.held).toBe(false);
      expect(h.active).toBe(false);
      // ... and the person's later edits are not diverted: nothing was restored over them.
      h.human = 'typed-after';
      h.event({ type: 'toolcancel', toolName: tool });
      h.event({ type: 'reset' });
      expect(h.human).toBe('typed-after');
      expect(h.restored).toEqual([]);
      // The agent-filled values the person submitted were applied (current form values), then the human handler ran.
      expect(h.applied).toEqual(['agent-filled', 'human:agent-filled']);
    });
  }

  test('the hold lifts BEFORE the apply and the human handler (onAuthorized, then afterServer, then onHumanSubmit)', () => {
    const log: string[] = [];
    handleDeclarativeSubmit({
      nativeEvent: { agentInvoked: false, preventDefault: () => {} },
      classification: 'read',
      agentTouched: true,
      getArgs: () => ({ q: 1 }),
      callServerTool: async () => ({}),
      onAuthorized: (_a, server) => { log.push(`authorized:${JSON.stringify(server)}`); },
      afterServer: () => { log.push('afterServer'); },
      onHumanSubmit: () => { log.push('human'); },
    });
    expect(log).toEqual([`authorized:${JSON.stringify(HUMAN_AUTHORIZED)}`, 'afterServer', 'human']);
  });

  test('an untouched human submit of a read form releases nothing and applies nothing but the human handler', () => {
    const log: string[] = [];
    handleDeclarativeSubmit({
      nativeEvent: { agentInvoked: false, preventDefault: () => {} },
      classification: 'read',
      agentTouched: false,
      getArgs: () => ({}),
      callServerTool: async () => ({}),
      onAuthorized: () => { log.push('authorized'); },
      afterServer: () => { log.push('afterServer'); },
      onHumanSubmit: () => { log.push('human'); },
    });
    expect(log).toEqual(['human']);
  });

  test('a throwing apply or human handler still releases the guard and settles', async () => {
    const log: string[] = [];
    const out = handleDeclarativeSubmit({
      nativeEvent: { agentInvoked: false, preventDefault: () => {} },
      classification: 'page',
      agentTouched: true,
      getArgs: () => ({}),
      callServerTool: async () => ({}),
      onAuthorized: () => { log.push('authorized'); },
      afterServer: () => { throw new Error('boom'); },
      onHumanSubmit: async () => { log.push('human'); throw new Error('boom'); },
    });
    await out.settled;
    expect(log).toEqual(['authorized', 'human']);
  });

  test('a human submit of a MUTATING touched form still goes through the card, not the guard shortcut', () => {
    const log: string[] = [];
    const out = handleDeclarativeSubmit({
      nativeEvent: { agentInvoked: false, preventDefault: () => {} },
      classification: 'mutating',
      agentTouched: true,
      toolName: 'review_action',
      getArgs: () => ({}),
      callServerTool: async () => new Promise(() => {}),
      onAuthorized: () => { log.push('authorized'); },
      onHumanSubmit: () => { log.push('human'); },
    });
    expect(out.route).toBe('operation');
    expect(log).toEqual([]);
  });
});

describe('G1 safety net: the tracker flag never drops while the guard is still active', () => {
  test('a reset, a toolcancel, or the tool going not-live after a settle that missed the guard discards and restores', () => {
    for (const drop of [{ type: 'reset' } as const, { type: 'toolcancel', toolName: 'filter_transactions' } as const]) {
      const s = new AgentFormSession<string>('filter_transactions');
      s.apply({ type: 'toolactivated', toolName: 'filter_transactions' }, { policy: 'ask', take: () => 'human' });
      const r = s.apply(drop);
      expect(r.restore).toEqual({ value: 'human' });
      expect(s.guard.active).toBe(false);
      expect(s.guard.held).toBe(false);
    }
  });

  test('a settle that drops the flag while the guard is unreleased (an outcome never arrived) discards the agent values', () => {
    const s = new AgentFormSession<string>('set_forecast_inputs');
    s.apply({ type: 'toolactivated', toolName: 'set_forecast_inputs' }, { policy: 'ask', take: () => 'human' });
    const token = s.tracker.beginSubmit();
    const r = s.settle(token); // e.g. the human route used to settle without ever authorizing
    expect(r.touched).toBe(false);
    expect(r.restore).toEqual({ value: 'human' });
    expect(s.guard.active).toBe(false);
  });

  test('a stale settle (a newer activation happened) neither clears the flag nor touches the guard', () => {
    const s = new AgentFormSession<string>('filter_transactions');
    s.apply({ type: 'toolactivated', toolName: 'filter_transactions' }, { policy: 'ask', take: () => 'h1' });
    const old = s.tracker.beginSubmit();
    s.apply({ type: 'toolactivated', toolName: 'filter_transactions' }, { policy: 'ask', take: () => 'h2' });
    const r = s.settle(old);
    expect(r).toEqual({ touched: true, cleared: false, restore: null });
    expect(s.guard.active).toBe(true);
  });

  test('an activation for a different tool does not touch this session', () => {
    const s = new AgentFormSession<string>('filter_transactions');
    const r = s.apply({ type: 'toolactivated', toolName: 'set_forecast_inputs' }, { policy: 'ask', take: () => 'h' });
    expect(r).toEqual({ touched: false, cleared: false, restore: null });
    expect(s.guard.active).toBe(false);
  });
});

describe('G1 invariant: (tracker.touched === false) implies (guard.active === false) after ANY event sequence', () => {
  type Step =
    | 'activate' | 'cancel' | 'reset' | 'notLive'
    | 'humanSubmit' | 'agentSubmit' | 'agentSubmitRejected' | 'agentSubmitRefused'
    | 'finishOldest' | 'finishNewest' | 'prefilled';
  const STEPS: Step[] = ['activate', 'cancel', 'reset', 'notLive', 'humanSubmit', 'agentSubmit', 'agentSubmitRejected', 'agentSubmitRefused', 'finishOldest', 'finishNewest', 'prefilled'];

  async function run(h: Harness, steps: Step[]) {
    const open: Array<() => Promise<void>> = [];
    const tool = h.toolName;
    for (const step of steps) {
      switch (step) {
        case 'activate': h.event({ type: 'toolactivated', toolName: tool }); break;
        case 'cancel': h.event({ type: 'toolcancel', toolName: tool }); break;
        case 'reset':
        case 'notLive': h.event({ type: 'reset' }); break;
        case 'prefilled': h.event({ type: 'prefilled' }); break;
        case 'humanSubmit': open.push(h.submit('human').finish); break;
        case 'agentSubmit': open.push(h.submit('agent', 'committed').finish); break;
        case 'agentSubmitRejected': open.push(h.submit('agent', 'rejected').finish); break;
        case 'agentSubmitRefused': open.push(h.submit('agent', 'throw').finish); break;
        case 'finishOldest': { const f = open.shift(); if (f) await f(); break; }
        case 'finishNewest': { const f = open.pop(); if (f) await f(); break; }
      }
      invariant(h, `after ${step} in [${steps.join(',')}]`);
    }
    // Everything still in flight completes, in order and then the rest: the invariant holds throughout and at the end.
    while (open.length) { await (open.shift() as () => Promise<void>)(); invariant(h, `draining [${steps.join(',')}]`); }
  }

  for (const [classification, tool] of [['read', 'filter_transactions'], ['page', 'set_forecast_inputs'], ['mutating', 'review_action']] as const) {
    test(`${classification}: every sequence of up to 4 events keeps the invariant`, async () => {
      let n = 0;
      const walk = async (prefix: Step[], depth: number): Promise<void> => {
        if (prefix.length) { await run(new Harness(classification, tool), prefix); n += 1; }
        if (depth === 0) return;
        for (const s of STEPS) await walk([...prefix, s], depth - 1);
      };
      await walk([], 4);
      expect(n).toBeGreaterThan(10000);
    });

    test(`${classification}: 3000 random sequences of 12 events keep the invariant (seeded)`, async () => {
      let seed = 0x9e3779b9;
      const rnd = () => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed / 0x100000000; };
      for (let i = 0; i < 3000; i++) {
        const steps = Array.from({ length: 12 }, () => STEPS[Math.floor(rnd() * STEPS.length)]);
        await run(new Harness(classification, tool), steps);
      }
    });
  }

  test('after a human submit settles, an agent that activates again is held and discardable again (no stuck state)', async () => {
    const h = new Harness('read', 'filter_transactions');
    h.event({ type: 'toolactivated', toolName: 'filter_transactions' });
    await h.submit('human').finish();
    h.event({ type: 'toolactivated', toolName: 'filter_transactions' });
    expect(h.held).toBe(true);
    h.event({ type: 'toolcancel', toolName: 'filter_transactions' });
    expect(h.held).toBe(false);
    expect(h.active).toBe(false);
  });
});

describe('G1 source guards: the hook runs the session, not a bare tracker next to a bare guard', () => {
  const hook = readFileSync(join(import.meta.dir, '../dashboard/ui/src/agent/useDeclarativeTool.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  test('touch and settle go through AgentFormSession (which discards a guard whose flag dropped) and the restore is applied', () => {
    expect(hook).toContain('new AgentFormSession(tool)');
    expect(hook).toMatch(/\.apply\(event, \{[\s\S]{0,200}policy: infoRef\.current\?\.policy/);
    expect(hook).toMatch(/\.settle\(token\)/);
    expect(hook).not.toContain('new AgentTouchTracker');
    expect(hook).not.toContain('new AgentValueGuard');
    expect((hook.match(/next\.restore\) optionsRef\.current\.restore\?\.\(next\.restore\.value\)/g) ?? []).length).toBe(2);
  });
});

/**
 * Chrome 154's real order for an auto-submitting form tool (observed live with a MutationObserver on #forecast):
 * the browser writes the agent's values into the fields first (trusted plain `Event('input')`s, the field not
 * focused), then dispatches the agentInvoked submit, and only THEN `toolactivated`. A snapshot taken at `toolactivated`
 * is the agent's values, the hold starts after the page already applied them, and the submit's tokens (taken before
 * the activation bumped the generation) are stale, so neither Approve nor Reject can settle the guard.
 */
describe('Chrome 154 order: fill, agentInvoked submit, then toolactivated', () => {
  const tool = 'set_forecast_inputs';
  /** The hook's input-capture listener: the browser's agent wrote a field, before the page's own onChange. */
  const fill = (h: Harness) => { h.event({ type: 'agentfill' }); h.human = 'agent-filled'; };

  test('the first agent fill snapshots the HUMAN values and holds before the page sees the agent value', () => {
    const h = new Harness('page', tool);
    fill(h);
    expect(h.held).toBe(true);
    expect(h.active).toBe(true);
    fill(h); // the next field: same call, the first snapshot stays
    expect(h.session.guard.active).toBe(true);
  });

  test('Reject puts the human values back and lifts the hold', async () => {
    const h = new Harness('page', tool);
    fill(h);
    const sub = h.submit('agent', 'rejected');
    h.event({ type: 'toolactivated', toolName: tool }); // arrives after the submit
    await sub.finish();
    expect(h.restored).toEqual(['human']);
    expect(h.human).toBe('human');
    expect(h.applied).toEqual([]);
    expect(h.held).toBe(false);
    expect(h.active).toBe(false);
    invariant(h, 'after reject');
  });

  test('Approve lifts the hold and applies the agent values', async () => {
    const h = new Harness('page', tool);
    fill(h);
    const sub = h.submit('agent', 'committed');
    h.event({ type: 'toolactivated', toolName: tool });
    expect(h.held).toBe(true);
    await sub.finish();
    expect(h.applied).toEqual(['agent-filled']);
    expect(h.restored).toEqual([]);
    expect(h.held).toBe(false);
    expect(h.active).toBe(false);
    expect(h.touched).toBe(false);
  });

  test('an agent submit with no detected fill (values unchanged) still activates before its tokens are taken', async () => {
    const h = new Harness('page', tool);
    const sub = h.submit('agent', 'rejected');
    expect(h.held).toBe(true);
    h.event({ type: 'toolactivated', toolName: tool });
    await sub.finish();
    expect(h.restored).toEqual(['human']);
    expect(h.held).toBe(false);
    expect(h.active).toBe(false);
  });

  test('the toolactivated that echoes an early activation does not start a second session', async () => {
    const h = new Harness('page', tool);
    fill(h);
    const gen = h.session.guard.generation;
    h.event({ type: 'toolactivated', toolName: tool });
    expect(h.session.guard.generation).toBe(gen);
    // ... and the next call activates again normally.
    const sub = h.submit('agent', 'committed');
    await sub.finish();
    expect(h.active).toBe(false);
    h.human = 'human2';
    fill(h);
    expect(h.held).toBe(true);
    const sub2 = h.submit('agent', 'rejected');
    h.event({ type: 'toolactivated', toolName: tool });
    await sub2.finish();
    expect(h.restored).toEqual(['human2']);
  });

  test('a non-auto-submit form (fill, then toolactivated, no submit) keeps the human snapshot and a cancel restores it', () => {
    const h = new Harness('mutating', 'set_budget');
    fill(h);
    h.event({ type: 'toolactivated', toolName: 'set_budget' });
    expect(h.touched).toBe(true);
    h.event({ type: 'toolcancel', toolName: 'set_budget' });
    expect(h.restored).toEqual(['human']);
    expect(h.active).toBe(false);
  });
});

describe('isBrowserAgentFill: the input event Chrome dispatches when its agent writes a field', () => {
  test('a trusted plain Event on a field that is not focused is an agent fill', () => {
    expect(isBrowserAgentFill({ isTrusted: true, isInputEvent: false, targetFocused: false })).toBe(true);
  });
  test('typing (InputEvent), a spinner or arrow key on the focused field, and script-dispatched events are not', () => {
    expect(isBrowserAgentFill({ isTrusted: true, isInputEvent: true, targetFocused: true })).toBe(false);
    expect(isBrowserAgentFill({ isTrusted: true, isInputEvent: false, targetFocused: true })).toBe(false);
    expect(isBrowserAgentFill({ isTrusted: false, isInputEvent: false, targetFocused: false })).toBe(false);
    expect(isBrowserAgentFill({ isTrusted: true, isInputEvent: true, targetFocused: false })).toBe(false);
  });
});

describe('declarative number fields keep a value-independent schema', () => {
  // Chrome derives `multipleOf: 1` for a number input with the default step only while its value is a whole number, so a
  // fill that turns 4840.71 into 2000 re-derives the tool definition and cancels the running call ("Tool execution
  // cancelled, since tool definition was updated"). `step="any"` keeps the schema the same whatever the value.
  const ui = join(import.meta.dir, '../dashboard/ui/src');
  const files = ['components/ManualInputsForm.tsx', 'tabs/GoalsTab.tsx'];
  for (const f of files) {
    test(`${f}: every type="number" input of a declarative form has step="any"`, () => {
      const src = readFileSync(join(ui, f), 'utf8');
      const inputs = [...src.matchAll(/<input\b[\s\S]*?\/>/g)].map((m) => m[0]).filter((s) => s.includes('type="number"'));
      expect(inputs.length).toBeGreaterThan(0);
      for (const input of inputs) expect(input).toContain('step="any"');
    });
  }
});
