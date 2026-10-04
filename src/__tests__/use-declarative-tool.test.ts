import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AgentTouchTracker,
  handleDeclarativeSubmit,
  isToolFormActive,
  nextAgentTouched,
  nextFormKey,
  type SubmitEventLike,
} from '../dashboard/declarative-submit-core.js';

/**
 * The React hook (ui/src/agent/useDeclarativeTool.ts) is a thin wiring of these pure functions to React state,
 * so the behaviour that matters is tested here with a fake SubmitEvent: no browser, no React renderer.
 */

function fakeEvent(init: { agentInvoked?: boolean; hasRespondWith?: boolean } = {}) {
  const log: string[] = [];
  let responded: Promise<unknown> | null = null;
  const ev: SubmitEventLike = {
    agentInvoked: init.agentInvoked,
    preventDefault: () => { log.push('preventDefault'); },
    ...(init.hasRespondWith === false ? {} : { respondWith: (p: Promise<unknown>) => { log.push('respondWith'); responded = p; } }),
  };
  return { ev, log, responded: () => responded };
}

describe('handleDeclarativeSubmit', () => {
  test('agentInvoked=true calls nativeEvent.preventDefault before respondWith', () => {
    const { ev, log } = fakeEvent({ agentInvoked: true });
    handleDeclarativeSubmit({
      nativeEvent: ev,
      classification: 'mutating',
      agentTouched: false,
      getArgs: () => ({ review_id: 1, action: 'confirm' }),
      callServerTool: async () => ({ outcome: 'committed' }),
    });
    expect(log).toEqual(['preventDefault', 'respondWith']);
  });

  test('respondWith receives the answer of the callServerTool promise, called with the form args and the declarative transport', async () => {
    const { ev, responded } = fakeEvent({ agentInvoked: true });
    const calls: unknown[] = [];
    const result = { outcome: 'committed', operationId: 'op-1', result: { transactionId: 4 } };
    const promise = Promise.resolve(result);
    const out = handleDeclarativeSubmit({
      nativeEvent: ev,
      classification: 'mutating',
      agentTouched: false,
      getArgs: () => ({ review_id: 1, action: 'confirm' }),
      callServerTool: (name, args, opts) => { calls.push([name, args, opts]); return promise; },
      toolName: 'resolve_review_item',
    });
    expect(out.route).toBe('operation');
    expect(await responded()).toEqual(result);
    // An agentInvoked submit is an AGENT call: the bridge tracks it (and the operation it creates) under its own identity.
    expect(calls).toEqual([['resolve_review_item', { review_id: 1, action: 'confirm' }, { transport: 'declarative', agentCall: true }]]);
  });

  test('a page or read tool can post-process the server answer (the page applies the filters, computes the forecast)', async () => {
    const { ev, responded } = fakeEvent({ agentInvoked: true });
    const applied: unknown[] = [];
    handleDeclarativeSubmit({
      nativeEvent: ev,
      classification: 'page',
      agentTouched: false,
      getArgs: () => ({ monthly_income: 4000 }),
      callServerTool: async () => ({ authorized: true }),
      afterServer: async (args, server) => { applied.push([args, server]); return { horizonMonths: 36, p10: 1, p50: 2, p90: 3 }; },
      toolName: 'fill_forecast_inputs',
    });
    expect(await responded()).toEqual({ horizonMonths: 36, p10: 1, p50: 2, p90: 3 });
    expect(applied).toEqual([[{ monthly_income: 4000 }, { authorized: true }]]);
  });

  test('a page or read tool whose Ask card was not approved never runs afterServer; the agent gets the outcome', async () => {
    for (const outcome of ['rejected', 'expired', 'unknown', 'stale', 'cancelled']) {
      for (const classification of ['page', 'read'] as const) {
        const { ev, responded } = fakeEvent({ agentInvoked: true });
        let applied = 0;
        const denial = { outcome, operationId: 'op-1', reason: 'x' };
        handleDeclarativeSubmit({
          nativeEvent: ev,
          classification,
          agentTouched: false,
          getArgs: () => ({ monthly_income: 4000 }),
          callServerTool: async () => denial,
          afterServer: async () => { applied += 1; return { horizonMonths: 36, p10: 1, p50: 2, p90: 3 }; },
          toolName: 'fill_forecast_inputs',
        });
        expect(await responded()).toEqual(denial);
        expect(applied).toBe(0);
      }
    }
  });

  test('an Ask card that was approved (outcome committed, or the data itself) still runs afterServer', async () => {
    for (const approved of [{ outcome: 'committed', operationId: 'op-1', reason: 'delivered' }, { rows: [] }, { authorized: true }]) {
      const { ev, responded } = fakeEvent({ agentInvoked: true });
      let applied = 0;
      handleDeclarativeSubmit({
        nativeEvent: ev,
        classification: 'read',
        agentTouched: false,
        getArgs: () => ({}),
        callServerTool: async () => approved,
        afterServer: async () => { applied += 1; return 'ok'; },
        toolName: 'list_transactions',
      });
      expect(await responded()).toBe('ok');
      expect(applied).toBe(1);
    }
  });

  test('a server refusal resolves respondWith with an {error} result (Chrome hides the text of a thrown error), so the agent sees the actionable text', async () => {
    const { ev, responded } = fakeEvent({ agentInvoked: true });
    handleDeclarativeSubmit({
      nativeEvent: ev,
      classification: 'mutating',
      agentTouched: false,
      getArgs: () => ({}),
      callServerTool: async () => { throw new Error('resolve_review_item: review_id is required'); },
    });
    expect(await responded()).toEqual({ error: { code: 'tool_failed', message: 'resolve_review_item: review_id is required' } });
  });

  test('an abort (the agent gave up) still rejects the promise handed to respondWith', async () => {
    const { ev, responded } = fakeEvent({ agentInvoked: true });
    handleDeclarativeSubmit({
      nativeEvent: ev,
      classification: 'mutating',
      agentTouched: false,
      getArgs: () => ({}),
      callServerTool: async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); },
    });
    await expect(responded()).rejects.toMatchObject({ name: 'AbortError' });
  });

  test('without respondWith (an older browser) an agent submit is still prevented and still goes through the server', async () => {
    const { ev, log } = fakeEvent({ agentInvoked: true, hasRespondWith: false });
    let called = 0;
    handleDeclarativeSubmit({ nativeEvent: ev, classification: 'mutating', agentTouched: false, getArgs: () => ({}), callServerTool: async () => { called += 1; return {}; } });
    expect(log).toEqual(['preventDefault']);
    expect(called).toBe(1);
  });

  test('a human click on an agent-touched mutating form goes through the card path and shows the outcome inline', async () => {
    const { ev, log } = fakeEvent({ agentInvoked: false });
    const outcomes: unknown[] = [];
    let human = 0;
    const out = handleDeclarativeSubmit({
      nativeEvent: ev,
      classification: 'mutating',
      agentTouched: true,
      getArgs: () => ({ category_id: 3, monthly_limit: 500 }),
      callServerTool: async () => ({ outcome: 'committed', operationId: 'op-2' }),
      onHumanSubmit: () => { human += 1; },
      onOutcome: (o) => { outcomes.push(o); },
      toolName: 'set_budget',
    });
    expect(out.route).toBe('operation');
    expect(log).toEqual(['preventDefault']); // never respondWith: nobody asked the page for an answer
    await out.settled;
    expect(outcomes).toEqual([{ outcome: 'committed', operationId: 'op-2' }]);
    expect(human).toBe(0);
  });

  test('an inline-outcome failure is reported, not thrown', async () => {
    const { ev } = fakeEvent({ agentInvoked: false });
    const outcomes: any[] = [];
    const out = handleDeclarativeSubmit({
      nativeEvent: ev, classification: 'mutating', agentTouched: true, getArgs: () => ({}),
      callServerTool: async () => { throw new Error('Grant invalid: revoked'); },
      onOutcome: (o) => { outcomes.push(o); },
    });
    await out.settled;
    expect(outcomes[0]).toMatchObject({ outcome: 'error', message: 'Grant invalid: revoked' });
  });

  test('plain human submit runs the existing handler and never touches the server', () => {
    const { ev, log } = fakeEvent({ agentInvoked: false });
    const handled: unknown[] = [];
    let server = 0;
    const out = handleDeclarativeSubmit({
      nativeEvent: ev,
      classification: 'mutating',
      agentTouched: false,
      getArgs: () => ({ goal_id: 2, status: 'paused' }),
      callServerTool: async () => { server += 1; return {}; },
      onHumanSubmit: (args) => { handled.push(args); },
    });
    expect(out.route).toBe('human');
    expect(log).toEqual(['preventDefault']);
    expect(handled).toEqual([{ goal_id: 2, status: 'paused' }]);
    expect(server).toBe(0);
  });

  test('a proposal form cannot be submitted by a human: blocked, with the message, and nothing runs', () => {
    const { ev, log } = fakeEvent({ agentInvoked: false });
    const blocked: string[] = [];
    let ran = 0;
    const out = handleDeclarativeSubmit({
      nativeEvent: ev,
      classification: 'proposal',
      agentTouched: true,
      getArgs: () => ({}),
      callServerTool: async () => { ran += 1; return {}; },
      onHumanSubmit: () => { ran += 1; },
      onBlocked: (m) => { blocked.push(m); },
    });
    expect(out.route).toBe('blocked');
    expect(log).toEqual(['preventDefault']);
    expect(blocked).toEqual(['This form is for agents. Use the rating controls above.']);
    expect(ran).toBe(0);
  });
});

describe('nextFormKey', () => {
  test('the key changes only when the tool goes from live to not live', () => {
    let state = nextFormKey(undefined, false);
    const initial = state.key;
    state = nextFormKey(state, true); // became live: same element, attributes appear
    expect(state.key).toBe(initial);
    state = nextFormKey(state, true);
    expect(state.key).toBe(initial);
    state = nextFormKey(state, false); // revoked: remount so the browser drops the tool
    expect(state.key).not.toBe(initial);
    const afterRevoke = state.key;
    state = nextFormKey(state, false);
    expect(state.key).toBe(afterRevoke);
    state = nextFormKey(state, true);
    state = nextFormKey(state, false);
    expect(state.key).not.toBe(afterRevoke);
  });
});

describe('nextAgentTouched', () => {
  test('set on toolactivated for this tool, cleared on toolcancel, reset or a completed submit', () => {
    expect(nextAgentTouched(false, { type: 'toolactivated', toolName: 'set_budget' }, 'set_budget')).toBe(true);
    expect(nextAgentTouched(true, { type: 'toolcancel', toolName: 'set_budget' }, 'set_budget')).toBe(false);
    expect(nextAgentTouched(true, { type: 'reset' }, 'set_budget')).toBe(false);
    expect(nextAgentTouched(true, { type: 'submitted' }, 'set_budget')).toBe(false);
  });

  test('an event for another tool changes nothing', () => {
    expect(nextAgentTouched(false, { type: 'toolactivated', toolName: 'update_goal' }, 'set_budget')).toBe(false);
    expect(nextAgentTouched(true, { type: 'toolcancel', toolName: 'update_goal' }, 'set_budget')).toBe(true);
    // A read or page form is never agent-touched by an anonymous event (only mutating forms fail closed).
    expect(nextAgentTouched(false, { type: 'toolactivated' }, 'list_transactions')).toBe(false);
  });

  test('fail closed: a toolactivated with no recognizable toolName touches every mutating form', () => {
    for (const tool of ['resolve_review_item', 'set_budget', 'update_goal']) {
      expect(nextAgentTouched(false, { type: 'toolactivated' }, tool), tool).toBe(true);
      expect(nextAgentTouched(false, { type: 'toolactivated', toolName: '' }, tool), tool).toBe(true);
      expect(nextAgentTouched(false, { type: 'toolactivated', toolName: 42 as unknown as string }, tool), tool).toBe(true);
      expect(nextAgentTouched(false, { type: 'toolactivated', toolName: 'not_a_form_tool' }, tool), tool).toBe(true);
    }
  });

  test('an anonymous toolcancel does not clear the flag', () => {
    expect(nextAgentTouched(true, { type: 'toolcancel' }, 'set_budget')).toBe(true);
  });
});

describe('AgentTouchTracker', () => {
  test('toolcancel, reset and a completed submit each report that the agent values must be cleared', () => {
    for (const ev of [{ type: 'toolcancel', toolName: 'set_budget' }, { type: 'reset' }] as const) {
      const t = new AgentTouchTracker('set_budget');
      t.apply({ type: 'toolactivated', toolName: 'set_budget' });
      expect(t.apply(ev)).toEqual({ touched: false, cleared: true });
    }
    const t = new AgentTouchTracker('set_budget');
    t.apply({ type: 'toolactivated', toolName: 'set_budget' });
    expect(t.settle(t.beginSubmit())).toEqual({ touched: false, cleared: true });
  });

  test('clearing a flag that was not set clears nothing (a human edit is never wiped)', () => {
    const t = new AgentTouchTracker('set_budget');
    expect(t.apply({ type: 'toolcancel', toolName: 'set_budget' })).toEqual({ touched: false, cleared: false });
    expect(t.apply({ type: 'reset' })).toEqual({ touched: false, cleared: false });
  });

  test('an earlier, long-pending submit settling after a newer activation does not clear the newer fill', () => {
    const t = new AgentTouchTracker('set_budget');
    t.apply({ type: 'toolactivated', toolName: 'set_budget' });
    const first = t.beginSubmit();
    t.apply({ type: 'toolactivated', toolName: 'set_budget' }); // the agent filled the form again
    expect(t.settle(first)).toEqual({ touched: true, cleared: false });
    expect(t.touched).toBe(true);
    expect(t.settle(t.beginSubmit())).toEqual({ touched: false, cleared: true });
  });

  test('an event for another tool neither sets nor bumps anything', () => {
    const t = new AgentTouchTracker('set_budget');
    t.apply({ type: 'toolactivated', toolName: 'update_goal' });
    expect(t.touched).toBe(false);
  });
});

describe('AgentTouchTracker, anonymous activation', () => {
  test('an anonymous toolactivated marks a mutating tracker touched and bumps its generation', () => {
    const t = new AgentTouchTracker('set_budget');
    t.apply({ type: 'toolactivated' });
    expect(t.touched).toBe(true);
    const first = t.beginSubmit();
    t.apply({ type: 'toolactivated' });
    expect(t.settle(first)).toEqual({ touched: true, cleared: false });
  });

  test('a read form tracker ignores it', () => {
    const t = new AgentTouchTracker('list_transactions');
    t.apply({ type: 'toolactivated' });
    expect(t.touched).toBe(false);
  });
});

describe('prefilled (an agent page tool chose what a mutating form acts on, T21)', () => {
  test('marks a mutating form touched, and a human submit afterwards routes to the card, not REST', () => {
    const t = new AgentTouchTracker('resolve_review_item');
    expect(t.apply({ type: 'prefilled' })).toEqual({ touched: true, cleared: false });
    const { ev } = fakeEvent({ agentInvoked: false });
    const calls: unknown[] = [];
    let human = 0;
    const out = handleDeclarativeSubmit({
      nativeEvent: ev,
      classification: 'mutating',
      agentTouched: t.touched,
      toolName: 'resolve_review_item',
      getArgs: () => ({ review_id: 7, action: 'confirm' }),
      callServerTool: async (name, args) => {
        calls.push([name, args]);
        return { outcome: 'rejected', operationId: 'op1' };
      },
      onHumanSubmit: () => {
        human += 1;
      },
    });
    expect(out.route).toBe('operation');
    expect(human).toBe(0);
    expect(calls).toHaveLength(1);
  });

  test('stays touched until a submit settles or the form is reset (not on a timer), then asks to clear the values', () => {
    const t = new AgentTouchTracker('resolve_review_item');
    t.apply({ type: 'prefilled' });
    expect(t.touched).toBe(true);
    expect(t.settle(t.beginSubmit())).toEqual({ touched: false, cleared: true });
    t.apply({ type: 'prefilled' });
    expect(t.apply({ type: 'reset' })).toEqual({ touched: false, cleared: true });
  });

  test('a second prefill bumps the generation so an earlier pending submit settling does not clear it', () => {
    const t = new AgentTouchTracker('resolve_review_item');
    t.apply({ type: 'prefilled' });
    const first = t.beginSubmit();
    t.apply({ type: 'prefilled' });
    expect(t.settle(first)).toEqual({ touched: true, cleared: false });
  });

  test('a read form is never touched by it', () => {
    const t = new AgentTouchTracker('list_transactions');
    t.apply({ type: 'prefilled' });
    expect(t.touched).toBe(false);
  });
});

describe('isToolFormActive (:tool-form-active at submit time)', () => {
  test('true when the form matches the pseudo-class, false when it does not', () => {
    expect(isToolFormActive({ matches: (sel: string) => sel === ':tool-form-active' })).toBe(true);
    expect(isToolFormActive({ matches: () => false })).toBe(false);
  });

  test('an unsupported selector (matches throws) is not active, and never throws', () => {
    expect(isToolFormActive({ matches: () => { throw new SyntaxError('not a valid selector'); } })).toBe(false);
    expect(isToolFormActive(undefined)).toBe(false);
  });
});

describe('handleDeclarativeSubmit, form matches :tool-form-active', () => {
  const run = (formEl: { matches: (s: string) => boolean } | undefined, agentTouched = false, classification: 'mutating' | 'read' = 'mutating') => {
    const { ev } = fakeEvent({ agentInvoked: false });
    const calls: unknown[] = [];
    let human = 0;
    const out = handleDeclarativeSubmit({
      nativeEvent: ev,
      formEl,
      classification,
      agentTouched,
      toolName: 'set_budget',
      getArgs: () => ({ category_id: 1, monthly_limit: 5 }),
      callServerTool: async (name, args, opts) => { calls.push([name, args, opts]); return { outcome: 'pending' }; },
      onHumanSubmit: () => { human += 1; },
    });
    return { out, calls, human: () => human };
  };

  test('a plain submit (agentInvoked false, tracker not touched) of an active tool form routes to operation, not the human REST path', async () => {
    const r = run({ matches: () => true });
    expect(r.out.route).toBe('operation');
    await r.out.settled;
    // Not agentInvoked: a person's (or a CDP click's) submit is never tracked as an agent call, so nothing can withdraw its card.
    expect(r.calls).toEqual([['set_budget', { category_id: 1, monthly_limit: 5 }, { transport: 'declarative', agentCall: false }]]);
    expect(r.human()).toBe(0);
  });

  test('matches() throwing falls back to the tracker flag: not touched -> human, touched -> operation', async () => {
    const throwing = { matches: () => { throw new SyntaxError('unsupported'); } };
    const human = run(throwing);
    expect(human.out.route).toBe('human');
    await human.out.settled;
    expect(human.human()).toBe(1);
    expect(run(throwing, true).out.route).toBe('operation');
  });

  test('matches() false and untouched stays human; a read form is unaffected by the pseudo-class', () => {
    expect(run({ matches: () => false }).out.route).toBe('human');
    expect(run({ matches: () => true }, false, 'read').out.route).toBe('human');
  });
});

describe('the React hook source', () => {
  const source = readFileSync(join(import.meta.dir, '../dashboard/ui/src/agent/useDeclarativeTool.ts'), 'utf8');

  test('reads the native event, listens through document.modelContext.addEventListener, never window.on*', () => {
    expect(source).toContain('nativeEvent');
    expect(source).toContain("modelContext");
    expect(source).toContain("addEventListener('toolactivated'");
    expect(source).toContain("addEventListener('toolcancel'");
    expect(source).toContain("removeEventListener('toolactivated'");
    expect(source).not.toMatch(/window\.ontool/);
    expect(source).not.toMatch(/\.ontoolactivated|\.ontoolcancel/);
  });

  test('also listens on window with addEventListener as a fallback, never an on* property', () => {
    expect(source).toContain("window.addEventListener('toolactivated'");
    expect(source).toContain("window.removeEventListener('toolcancel'");
  });

  test('resets the agent-filled values whenever the touched flag drops, including when the tool stops being live', () => {
    expect(source).toContain('onAgentCleared');
    expect(source).toMatch(/if \(!live\)[\s\S]{0,200}apply\(\{ type: 'reset' \}\)|!live[\s\S]{0,200}reset/);
  });

  test('passes the form element so the submit handler can check :tool-form-active', () => {
    expect(source).toContain('formEl');
    expect(source).toMatch(/handleDeclarativeSubmit\(\{[\s\S]*formEl[\s\S]*\}\)/);
  });

  test('guards a browser with no modelContext', () => {
    expect(source).toMatch(/modelContext\?\.addEventListener|!mc\b|typeof mc\.addEventListener/);
  });
});

describe('useDeclarativeTool ignores activations while the form is not live', () => {
  const source = readFileSync(join(import.meta.dir, '../dashboard/ui/src/agent/useDeclarativeTool.ts'), 'utf8');
  test('a toolactivated event is dropped when the tool has no live info', () => {
    expect(source).toContain("if (event.type === 'toolactivated' && infoRef.current === undefined) return;");
  });
});
