import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AgentFormSession,
  buildFormArgs,
  handleDeclarativeSubmit,
  isBrowserAgentFill,
  overlayAgentFills,
  readFill,
  type SubmitEventLike,
} from '../dashboard/declarative-submit-core.js';
import { forecastReflectsValues } from '../dashboard/ui/src/lib/forecastAgentAwait.js';

/**
 * V1 (live, Chrome 154): `set_forecast_inputs` under policy Ask. Reject kept the human's values, but on Approve the agent got
 * a projection of the HUMAN's numbers and the boxes never took its 90000 / 9000 / 4000.
 *
 * Root cause (reproduced in a real browser with trusted plain `Event('input')`s on unfocused fields): the agent's fill is
 * detected in the form's `onInputCapture`, which publishes the hold into React state. React flushes that update in a
 * microtask BEFORE its own bubble-phase `onChange` for the same input event, and the controlled `<input value={raw}>` is
 * re-rendered with the HUMAN's `raw`, which writes the human's text back over the agent's value. Then `onChange` sees an
 * unchanged value and never fires. By the time the agent's submit arrives the DOM holds the human's numbers, so
 * `new FormData(form)` (the old `getArgs`) built the HUMAN's args: the server operation, the card, the authorized call and
 * the page's post-commit effects all carried the wrong values.
 *
 * Fix under test: the agent's values are captured from the fill events themselves (`noteFill`), and an `agentInvoked`
 * submit builds its args from them (`buildFormArgs` with the session's fills), never from the DOM after a hold.
 */

const SCHEMA = {
  type: 'object',
  properties: {
    start_net_worth: { type: 'number' },
    monthly_income: { type: 'number' },
    monthly_savings: { type: 'number' },
  },
};

const HUMAN = { start_net_worth: '0', monthly_income: '6400', monthly_savings: '4840.71' };
const AGENT = { start_net_worth: '90000', monthly_income: '9000', monthly_savings: '4000' };

type Boxes = typeof HUMAN;

/**
 * The Forecast form as Chrome 154 and React drive it, with the one browser behaviour that matters modelled exactly: an agent
 * fill writes the DOM value, `onInputCapture` runs and re-renders the controlled field from the human's state (the DOM goes
 * back to the human's text), and `onChange` never sees a change.
 */
class ForecastPage {
  readonly session = new AgentFormSession<Boxes>('set_forecast_inputs');
  /** React state of the three boxes (what the page computes from once the hold lifts). */
  raw: Boxes = { ...HUMAN };
  /** What `new FormData(form)` would read right now. */
  dom: Boxes = { ...HUMAN };
  /** What the projection is computed from. */
  computedFrom: Boxes = { ...HUMAN };
  restored = 0;
  calls: Array<Record<string, unknown>> = [];
  afterServerArgs: Array<Record<string, unknown>> = [];

  constructor(readonly policy: 'allow' | 'ask' | undefined = 'ask') {}

  /** Chrome 154 writes one field: trusted plain Event('input'), unfocused. */
  agentFill(name: keyof Boxes, value: string) {
    const target = { name, value, type: 'number' };
    const wasFill = isBrowserAgentFill({ isTrusted: true, isInputEvent: false, targetFocused: false });
    expect(wasFill).toBe(true);
    this.dom[name] = value; // the browser wrote it
    const next = this.session.apply({ type: 'agentfill' }, { policy: this.policy, take: () => ({ ...this.raw }) });
    if (next.restore) this.restoreHuman(next.restore.value);
    const fill = readFill(target);
    if (fill) this.session.noteFill(fill.name, fill.value);
    // The re-render caused by `touch` (setGuardView / setAgentTouched) puts the controlled value back before onChange runs.
    this.dom[name] = this.raw[name];
  }

  private restoreHuman(human: Boxes) {
    this.restored += 1;
    this.raw = { ...human };
    this.dom = { ...human };
    this.computedFrom = { ...human };
  }

  /** The hook's onSubmit for an agentInvoked submit; `answer` is what the server operation resolves with. */
  agentSubmit(answer: () => Promise<unknown>, afterServer?: (args: Record<string, unknown>) => unknown) {
    const next = this.session.apply({ type: 'agentsubmit' }, { policy: this.policy, take: () => ({ ...this.raw }) });
    if (next.restore) this.restoreHuman(next.restore.value);
    const { tracker, guard } = this.session;
    const token = tracker.beginSubmit();
    const guardToken = guard.beginSubmit();
    let responded: Promise<unknown> | null = null;
    const ev: SubmitEventLike = { agentInvoked: true, preventDefault: () => {}, respondWith: (p) => { responded = p; } };
    const out = handleDeclarativeSubmit({
      nativeEvent: ev,
      classification: 'page',
      agentTouched: tracker.touched,
      toolName: 'set_forecast_inputs',
      getArgs: () => buildFormArgs({ entries: Object.entries(this.dom), schema: SCHEMA, fills: this.session.agentFills() }),
      callServerTool: (_n, args) => { this.calls.push(args); return answer(); },
      onAuthorized: () => { guard.authorize(guardToken); },
      onUnauthorized: () => {
        const r = guard.discard(guardToken).restore;
        if (r) this.restoreHuman(r.value);
      },
      afterServer: async (args, server) => {
        this.afterServerArgs.push(args);
        // ManualInputsForm.afterServer: the boxes take exactly the authorized args, the projection is computed from them.
        this.raw = { start_net_worth: String(args.start_net_worth), monthly_income: String(args.monthly_income), monthly_savings: String(args.monthly_savings) };
        this.dom = { ...this.raw };
        this.computedFrom = { ...this.raw };
        return afterServer ? afterServer(args) : server;
      },
    });
    return {
      out,
      answer: async () => {
        await out.settled;
        const settled = this.session.settle(token);
        if (settled.restore) this.restoreHuman(settled.restore.value);
        return responded;
      },
    };
  }

  /** Chrome 154's order: every field, then the agentInvoked submit, then (late) toolactivated. */
  replayChrome154() {
    for (const [name, value] of Object.entries(AGENT)) this.agentFill(name as keyof Boxes, value);
  }
}

const NUMS = { start_net_worth: 90000, monthly_income: 9000, monthly_savings: 4000 };

describe('V1: the agent submits the values it filled, not what the DOM shows after the hold re-rendered the form', () => {
  test('the model of the bug: after an agent fill the controlled DOM holds the human numbers (what the old getArgs read)', () => {
    const page = new ForecastPage('ask');
    page.replayChrome154();
    expect(page.dom).toEqual(HUMAN);
    expect(formArgsFromDomOnly(page.dom)).toEqual({ start_net_worth: 0, monthly_income: 6400, monthly_savings: 4840.71 });
  });

  test('Ask + Approve (Chrome 154 order: fill, submit, toolactivated): the server call, onAuthorized and afterServer all carry the agent args', async () => {
    const page = new ForecastPage('ask');
    page.replayChrome154();
    const { answer } = page.agentSubmit(async () => ({ outcome: 'committed', operationId: 'op1', reason: 'delivered' }), () => ({ horizonMonths: 240, p50: 1 }));
    expect(await answer()).toEqual({ horizonMonths: 240, p50: 1 });
    expect(page.calls).toEqual([NUMS]); // what the card was built from
    expect(page.afterServerArgs).toEqual([NUMS]); // what the page applied
    expect(page.raw).toEqual(AGENT);
    expect(page.computedFrom).toEqual(AGENT); // the projection is of the applied values
    expect(page.session.guard.active).toBe(false);
    expect(page.restored).toBe(0);
  });

  test('Ask + Reject: the human values are kept and afterServer never runs', async () => {
    const page = new ForecastPage('ask');
    page.replayChrome154();
    const { answer } = page.agentSubmit(async () => ({ outcome: 'rejected', operationId: 'op1' }));
    expect(await answer()).toEqual({ outcome: 'rejected', operationId: 'op1' });
    expect(page.calls).toEqual([NUMS]); // the card showed the agent's request
    expect(page.afterServerArgs).toEqual([]);
    expect(page.raw).toEqual(HUMAN);
    expect(page.dom).toEqual(HUMAN);
    expect(page.computedFrom).toEqual(HUMAN);
    expect(page.restored).toBeGreaterThan(0);
  });

  test('Allow (no hold) goes the same way: the agent args, not the DOM', async () => {
    const page = new ForecastPage('allow');
    page.replayChrome154();
    const { answer } = page.agentSubmit(async () => ({ authorized: true }));
    await answer();
    expect(page.calls).toEqual([NUMS]);
    expect(page.afterServerArgs).toEqual([NUMS]);
    expect(page.raw).toEqual(AGENT);
  });

  test('an unknown policy fails closed (held) and still carries the agent args', async () => {
    const page = new ForecastPage(undefined);
    page.replayChrome154();
    expect(page.session.guard.held).toBe(true);
    const { answer } = page.agentSubmit(async () => ({ outcome: 'committed', operationId: 'op1' }));
    await answer();
    expect(page.afterServerArgs).toEqual([NUMS]);
  });

  test('a field the agent did not fill keeps what the form holds (the human value is a legitimate argument)', async () => {
    const page = new ForecastPage('ask');
    page.agentFill('start_net_worth', '90000');
    page.agentFill('monthly_savings', '4000');
    const { answer } = page.agentSubmit(async () => ({ outcome: 'committed', operationId: 'op1' }));
    await answer();
    expect(page.calls).toEqual([{ start_net_worth: 90000, monthly_income: 6400, monthly_savings: 4000 }]);
  });

  test('the agent filling the same field twice: the last value wins', async () => {
    const page = new ForecastPage('ask');
    page.agentFill('start_net_worth', '1');
    page.agentFill('start_net_worth', '90000');
    page.agentFill('monthly_income', '9000');
    page.agentFill('monthly_savings', '4000');
    const { answer } = page.agentSubmit(async () => ({ authorized: true }));
    await answer();
    expect(page.calls).toEqual([NUMS]);
  });

  test('a call that ended (authorized, rejected, cancelled) leaves no fills behind for the next one', async () => {
    const page = new ForecastPage('ask');
    page.replayChrome154();
    const first = page.agentSubmit(async () => ({ outcome: 'rejected', operationId: 'op1' }));
    await first.answer();
    expect(page.session.agentFills().size).toBe(0);
    // Next call: the agent fills only one field; the other two are whatever the form holds (the human's), never the old call's.
    page.agentFill('monthly_savings', '123');
    const second = page.agentSubmit(async () => ({ authorized: true }));
    await second.answer();
    expect(page.calls[1]).toEqual({ start_net_worth: 0, monthly_income: 6400, monthly_savings: 123 });
  });

  test('toolcancel and reset drop the recorded fills', () => {
    for (const event of [{ type: 'toolcancel', toolName: 'set_forecast_inputs' } as const, { type: 'reset' } as const]) {
      const page = new ForecastPage('ask');
      page.replayChrome154();
      expect(page.session.agentFills().size).toBe(3);
      page.session.apply(event);
      expect(page.session.agentFills().size).toBe(0);
    }
  });

  test('a person editing a field after the agent filled it takes it out of the agent record', () => {
    const page = new ForecastPage('ask');
    page.replayChrome154();
    page.session.noteHumanEdit('monthly_income');
    expect([...page.session.agentFills().keys()].sort()).toEqual(['monthly_savings', 'start_net_worth']);
  });

  test('nothing is recorded unless an agent call is active (a person never gets an agent overlay)', () => {
    const session = new AgentFormSession<Boxes>('set_forecast_inputs');
    session.noteFill('monthly_income', '9000');
    expect(session.agentFills().size).toBe(0);
  });

  test('a fill dropped because a person is saving is not recorded', () => {
    const session = new AgentFormSession<Boxes>('set_forecast_inputs');
    const r = session.apply({ type: 'agentfill' }, { policy: 'ask', take: () => ({ ...HUMAN }), humanBusy: true });
    expect(r.touched).toBe(false);
    session.noteFill('monthly_income', '9000');
    expect(session.agentFills().size).toBe(0);
  });
});

function formArgsFromDomOnly(dom: Boxes) {
  return buildFormArgs({ entries: Object.entries(dom), schema: SCHEMA, fills: new Map() });
}

describe('overlayAgentFills / readFill / buildFormArgs', () => {
  test('replaces the named entry (and any duplicate), appends a field the form did not list, keeps the rest in order', () => {
    const merged = overlayAgentFills([['a', '1'], ['b', '2'], ['a', '3']], new Map([['a', '9'], ['c', '7']]));
    expect(merged).toEqual([['a', '9'], ['b', '2'], ['c', '7']]);
  });

  test('no fills: the entries as they are', () => {
    const entries: Array<[string, unknown]> = [['a', '1']];
    expect(overlayAgentFills(entries, new Map())).toEqual(entries);
  });

  test('readFill takes a named text-like field and refuses checkables, files, unnamed and non-string values', () => {
    expect(readFill({ name: 'x', value: '5', type: 'number' })).toEqual({ name: 'x', value: '5' });
    expect(readFill({ name: 'sel', value: 'Dining', type: 'select-one' })).toEqual({ name: 'sel', value: 'Dining' });
    expect(readFill({ name: 'x', value: '5', type: 'checkbox' })).toBeNull();
    expect(readFill({ name: 'x', value: '5', type: 'radio' })).toBeNull();
    expect(readFill({ name: 'x', value: '5', type: 'file' })).toBeNull();
    expect(readFill({ name: '', value: '5', type: 'text' })).toBeNull();
    expect(readFill({ value: '5', type: 'text' })).toBeNull();
    expect(readFill({ name: 'x', value: 5 as unknown as string, type: 'text' })).toBeNull();
  });

  test('buildFormArgs types the overlaid entries by the schema; without a schema only strings pass through', () => {
    expect(buildFormArgs({ entries: [['monthly_income', '6400']], schema: SCHEMA, fills: new Map([['monthly_income', '9000']]) })).toEqual({ monthly_income: 9000 });
    expect(buildFormArgs({ entries: [['a', '1'], ['f', new Blob([])]], schema: undefined, fills: new Map() })).toEqual({ a: '1' });
  });
});

describe('a human submit of an agent-filled form is the person\'s act: it never uses the agent record', () => {
  test('handleDeclarativeSubmit human route: getArgs is the form as the person left it', async () => {
    const session = new AgentFormSession<Boxes>('set_forecast_inputs');
    session.apply({ type: 'agentfill' }, { policy: 'ask', take: () => ({ ...HUMAN }) });
    session.noteFill('monthly_income', '9000');
    let seen: Record<string, unknown> | undefined;
    const ev: SubmitEventLike = { agentInvoked: false, preventDefault: () => {} };
    const out = handleDeclarativeSubmit({
      nativeEvent: ev,
      classification: 'page',
      agentTouched: true,
      toolName: 'set_forecast_inputs',
      // The hook: the overlay is for an agentInvoked submit only.
      getArgs: () => buildFormArgs({ entries: Object.entries({ ...HUMAN, monthly_income: '7000' }), schema: SCHEMA, fills: ev.agentInvoked === true ? session.agentFills() : new Map() }),
      callServerTool: () => Promise.reject(new Error('unreachable')),
      afterServer: (args) => { seen = args; return args; },
    });
    await out.settled;
    expect(seen).toEqual({ start_net_worth: 0, monthly_income: 7000, monthly_savings: 4840.71 });
  });
});

describe('forecastReflectsValues: the call is answered with the projection of the values it applied, never an already-matching human one', () => {
  const values = { start_net_worth: 90000, monthly_income: 9000, monthly_savings: 4000 };
  const input = (start: number, savings: number) => ({ startNetWorth: start, contributionPool: [savings] });

  test('a finished projection of the human inputs is not the answer for the agent values', () => {
    expect(forecastReflectsValues(values, input(0, 4840.71))).toBe(false);
  });

  test('the projection of exactly those numbers is', () => {
    expect(forecastReflectsValues(values, input(90000, 4000))).toBe(true);
  });

  test('no projection yet, or a pool that is not the single manual contribution: not a match', () => {
    expect(forecastReflectsValues(values, null)).toBe(false);
    expect(forecastReflectsValues(values, { startNetWorth: 90000, contributionPool: [4000, 1] })).toBe(false);
    expect(forecastReflectsValues(values, { startNetWorth: 90000, contributionPool: [] })).toBe(false);
  });

  test('when the human values already equal the agent values the standing projection is the right answer', () => {
    expect(forecastReflectsValues({ start_net_worth: 0, monthly_income: 6400, monthly_savings: 4840.71 }, input(0, 4840.71))).toBe(true);
  });
});

describe('source guards: the hook records fills and builds an agent submit from them; the Forecast tab waits on the projection of the applied values', () => {
  const ui = join(import.meta.dir, '../dashboard/ui/src');
  const strip = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const hook = strip(readFileSync(join(ui, 'agent/useDeclarativeTool.ts'), 'utf8'));
  const forecast = strip(readFileSync(join(ui, 'tabs/ForecastTab.tsx'), 'utf8'));

  test('onInputCapture records a browser agent fill after touching the session, and drops a person\'s edit of that field', () => {
    const capture = hook.slice(hook.indexOf('const onInputCapture'), hook.indexOf('const onReset'));
    expect(capture).toMatch(/touch\(\{ type: 'agentfill' \}\)[\s\S]*noteFill\(/);
    expect(capture).toContain('noteHumanEdit(');
    expect(capture).toContain('readFill(');
  });

  test('getArgs of an agentInvoked submit overlays the recorded fills; a person\'s submit does not', () => {
    const at = hook.indexOf('buildFormArgs({');
    const getArgs = hook.slice(at, hook.indexOf('callServerTool:', at));
    expect(getArgs).toContain('buildFormArgs(');
    expect(getArgs).toMatch(/nativeEvent\.agentInvoked === true \? [^:]*agentFills\(\) : NO_FILLS/);
    expect(getArgs).not.toContain('formToArgs(');
  });

  test('ForecastTab resolves an agent call only for a projection whose input is the applied values', () => {
    expect(forecast).toContain('forecastReflectsValues(pending.values, forecastInput)');
  });
});
