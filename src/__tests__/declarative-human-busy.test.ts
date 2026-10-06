import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  AgentFormSession,
  BUSY_MESSAGE,
  busyResult,
  fieldLock,
  handleDeclarativeSubmit,
  isBrowserAgentFill,
  type SubmitEventLike,
  type TouchedEvent,
} from '../dashboard/declarative-submit-core.js';

/**
 * S1 regression: while a PERSON's save is in flight the form's fields are locked (`fieldLock`), so Chrome's agent fill is
 * dropped by the lock's handler guard. An `agentInvoked` submit that then arrived would read the PERSON's values out of
 * the form and send them as the AGENT's call. It must instead be refused: no server operation, a `busy` result for the
 * agent, and the person's values and save untouched.
 *
 * `FormModel` wires the pure pieces the way `useDeclarativeTool` + a form such as `BudgetEditForm` do (same session,
 * same `handleDeclarativeSubmit`, same lock), so the sequence is replayed on the real code without a React renderer.
 */

const BUSY_ERROR = { error: { code: 'busy' as const, message: 'The person is saving this form; try again in a moment.' } };

class FormModel {
  readonly session = new AgentFormSession<Record<string, string>>('set_budget');
  /** The controlled field values. */
  values: Record<string, string> = { category_id: '7', monthly_limit: '250' };
  humanBusy = false;
  operations: Array<{ args: Record<string, unknown>; agentCall: boolean }> = [];
  answers: unknown[] = [];
  restored = 0;
  cleared = 0;
  authorized = 0;
  unauthorized = 0;

  /** A field's onChange, behind the lock (what `lock.guard` does while the person's save is in flight). */
  private change(name: string, value: string) {
    fieldLock(this.humanBusy).guard((v: string) => { this.values[name] = v; })(value);
  }

  private applyEvent(event: TouchedEvent) {
    const r = this.session.apply(event, { policy: 'ask', take: () => ({ ...this.values }), humanBusy: this.humanBusy });
    if (r.restore) { this.values = { ...r.restore.value }; this.restored += 1; }
    if (r.cleared) this.cleared += 1;
  }

  /** Chrome 154's fill: a trusted plain `Event` on a field without focus; the capture listener reports it, then the field's onChange runs. */
  agentFill(name: string, value: string) {
    if (isBrowserAgentFill({ isTrusted: true, isInputEvent: false, targetFocused: false })) this.applyEvent({ type: 'agentfill' });
    this.change(name, value);
  }

  toolActivated() {
    this.applyEvent({ type: 'toolactivated', toolName: 'set_budget' });
  }

  /** The hook's onSubmit for an agentInvoked submit. */
  agentSubmit(): { route: string; settled: Promise<void> } {
    const respondWith = (answer: Promise<unknown>) => void answer.then((a) => this.answers.push(a));
    const ev: SubmitEventLike = { agentInvoked: true, preventDefault: () => {}, respondWith };
    if (this.session.shouldRefuseAgentSubmit(this.humanBusy)) {
      this.session.refuseAgentSubmit();
      return handleDeclarativeSubmit({
        nativeEvent: ev, classification: 'mutating', agentTouched: false, toolName: 'set_budget', humanBusy: true,
        getArgs: () => ({}), callServerTool: () => Promise.reject(new Error('unreachable')),
      });
    }
    this.applyEvent({ type: 'agentsubmit' });
    const { tracker, guard } = this.session;
    const token = tracker.beginSubmit();
    const guardToken = guard.beginSubmit();
    const result = handleDeclarativeSubmit({
      nativeEvent: ev, classification: 'mutating', agentTouched: tracker.touched, toolName: 'set_budget',
      humanBusy: this.humanBusy,
      getArgs: () => ({ ...this.values }),
      callServerTool: async (_n, args, opts) => { this.operations.push({ args, agentCall: opts.agentCall }); return { outcome: 'committed', operationId: 'op' }; },
      onAuthorized: () => { this.authorized += 1; guard.authorize(guardToken); },
      onUnauthorized: () => { this.unauthorized += 1; guard.discard(guardToken); },
    });
    void result.settled.then(() => { this.session.settle(token); });
    return result;
  }

  get touched() { return this.session.tracker.touched; }
  get guardActive() { return this.session.guard.active; }
}

const person = () => { const f = new FormModel(); f.humanBusy = true; return f; };

describe('T1: an agent submit while a person\'s save is in flight', () => {
  test('replay (Chrome 154 order): human save in flight -> agent fill -> agent submit -> no operation, busy error to the agent, the person\'s values untouched', async () => {
    const form = person();
    const before = { ...form.values };

    form.agentFill('category_id', '9');
    form.agentFill('monthly_limit', '1');
    expect(form.values, 'the lock dropped the agent\'s fill').toEqual(before);
    expect(form.touched, 'the fill is not an activation while busy').toBe(false);
    expect(form.guardActive).toBe(false);

    const result = form.agentSubmit();
    await result.settled;
    await Promise.resolve();

    expect(result.route).toBe('busy');
    expect(form.operations, 'no server operation is created').toEqual([]);
    expect(form.answers).toEqual([BUSY_ERROR]);
    expect(form.authorized + form.unauthorized).toBe(0);
    expect(form.values, 'the person\'s values are unchanged').toEqual(before);
    expect(form.restored + form.cleared, 'nothing was restored or cleared over the person\'s values').toBe(0);

    // Chrome's late `toolactivated` of the refused call must not flag the form or snapshot anything.
    form.toolActivated();
    expect(form.touched).toBe(false);
    expect(form.guardActive).toBe(false);
    expect(form.values).toEqual(before);
    expect(form.cleared).toBe(0);
  });

  test('replay (explainer order): toolactivated, fill, submit while busy is refused the same way', async () => {
    const form = person();
    const before = { ...form.values };
    form.toolActivated();
    form.agentFill('monthly_limit', '1');
    const result = form.agentSubmit();
    await result.settled;
    await Promise.resolve();
    expect(result.route).toBe('busy');
    expect(form.operations).toEqual([]);
    expect(form.answers).toEqual([BUSY_ERROR]);
    expect(form.values).toEqual(before);
    expect(form.touched).toBe(false);
    expect(form.guardActive).toBe(false);
  });

  test('the person\'s save finishing later: the form is clean, and the NEXT agent call is a normal, tracked one', async () => {
    const form = person();
    form.agentFill('monthly_limit', '1');
    await form.agentSubmit().settled;
    await Promise.resolve();
    form.toolActivated(); // the refused call's late event

    form.humanBusy = false; // the save finished
    form.values = { category_id: '', monthly_limit: '' }; // and the form was cleared, as saveAsHuman does

    form.agentFill('category_id', '9');
    form.agentFill('monthly_limit', '75');
    expect(form.touched, 'a fill with no save in flight is an activation again').toBe(true);
    expect(form.guardActive).toBe(true);
    form.toolActivated(); // this call's own echo is absorbed by the session, not a second activation
    const result = form.agentSubmit();
    await result.settled;
    expect(result.route).toBe('operation');
    expect(form.operations).toEqual([{ args: { category_id: '9', monthly_limit: '75' }, agentCall: true }]);
    expect(form.answers.at(-1)).toMatchObject({ outcome: 'committed' });
  });

  test('a fill that was dropped while busy poisons that call even if the save finished before its submit: refused, not sent with the person\'s values', async () => {
    const form = person();
    form.agentFill('category_id', '9'); // dropped by the lock
    form.humanBusy = false; // the save finishes before the agent submits
    const result = form.agentSubmit();
    await result.settled;
    await Promise.resolve();
    expect(result.route).toBe('busy');
    expect(form.operations).toEqual([]);
    expect(form.answers).toEqual([BUSY_ERROR]);
    // The agent retries as the message says: a complete call now goes through.
    form.agentFill('category_id', '9');
    form.agentFill('monthly_limit', '30');
    form.toolActivated();
    const retry = form.agentSubmit();
    await retry.settled;
    expect(retry.route).toBe('operation');
    expect(form.operations).toHaveLength(1);
  });

  test('a toolcancel or reset clears the leftovers of a refused call', async () => {
    const form = person();
    form.agentFill('category_id', '9');
    form.humanBusy = false;
    form.session.apply({ type: 'toolcancel', toolName: 'set_budget' });
    expect(form.session.shouldRefuseAgentSubmit(false)).toBe(false);
    form.humanBusy = true;
    await form.agentSubmit().settled; // refused (echoSkip set)
    form.session.apply({ type: 'reset' });
    form.humanBusy = false;
    form.toolActivated(); // an explainer-order call: not swallowed by a stale echo
    expect(form.touched).toBe(true);
  });

  test('the busy result is a RESULT with the exact code and message', () => {
    expect(busyResult()).toEqual(BUSY_ERROR);
    expect(BUSY_MESSAGE).toBe(BUSY_ERROR.error.message);
  });

  test('humanBusy changes nothing for a person\'s own submit, or for an agent submit when no save is in flight', async () => {
    let handled = 0;
    const human = handleDeclarativeSubmit({
      nativeEvent: { agentInvoked: false, preventDefault: () => {} }, classification: 'mutating', agentTouched: false,
      humanBusy: true, getArgs: () => ({}), callServerTool: async () => ({}), onHumanSubmit: () => { handled += 1; },
    });
    await human.settled;
    expect(human.route).toBe('human');
    expect(handled).toBe(1);

    const idle = new FormModel();
    const r = idle.agentSubmit();
    await r.settled;
    expect(r.route).toBe('operation');
    expect(idle.operations).toHaveLength(1);
  });

  test('a read or page form is refused the same way when a person\'s save is in flight (the guard is for every agentInvoked submit)', async () => {
    for (const classification of ['read', 'page', 'proposal'] as const) {
      let called = 0;
      const answers: unknown[] = [];
      const r = handleDeclarativeSubmit({
        nativeEvent: { agentInvoked: true, preventDefault: () => {}, respondWith: (a) => void a.then((x) => answers.push(x)) },
        classification, agentTouched: false, humanBusy: true, getArgs: () => ({}), callServerTool: async () => { called += 1; return {}; },
      });
      await r.settled;
      await Promise.resolve();
      expect(r.route, classification).toBe('busy');
      expect(called, classification).toBe(0);
      expect(answers, classification).toEqual([BUSY_ERROR]);
    }
  });
});

// ── Source guards ────────────────────────────────────────────────────────────

describe('T1 source guards: every form that locks its fields for a person\'s save tells the hook', () => {
  const uiRoot = join(import.meta.dir, '../dashboard/ui/src');
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      return statSync(full).isDirectory() ? walk(full) : /\.(tsx|ts)$/.test(name) ? [full] : [];
    });
  const strip = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const lockers = walk(uiRoot).filter((f) => /\bfieldLock\(/.test(strip(readFileSync(f, 'utf8'))));
  const rel = (f: string) => f.slice(uiRoot.length + 1);

  test('the scanner finds the forms that use fieldLock', () => {
    expect(lockers.map(rel).sort()).toEqual(['tabs/GoalsTab.tsx', 'tabs/ReviewTab.tsx']);
  });

  test('each passes `humanBusy` to its useDeclarativeTool call, backed by useHumanBusy (a ref read at event time)', () => {
    for (const file of lockers) {
      const code = strip(readFileSync(file, 'utf8'));
      const forms = (code.match(/\bfieldLock\(busy\)/g) ?? []).length;
      expect(forms, rel(file)).toBeGreaterThan(0);
      expect((code.match(/useHumanBusy\(\)/g) ?? []).length, `${rel(file)}: one useHumanBusy per locked form`).toBe(forms);
      expect((code.match(/humanBusy: isBusy/g) ?? []).length, `${rel(file)}: one humanBusy per locked form`).toBe(forms);
      expect(code, rel(file)).not.toMatch(/const \[busy, setBusy\] = useState\(false\);\s*\n\s*(?:const \[message|const options|const \{ data)/);
    }
  });

  test('the hook refuses an agentInvoked submit before it activates the session or takes tokens', () => {
    const hook = strip(readFileSync(join(uiRoot, 'agent/useDeclarativeTool.ts'), 'utf8'));
    const refuse = hook.indexOf('shouldRefuseAgentSubmit(');
    const activate = hook.indexOf("touch({ type: 'agentsubmit' })");
    const tokens = hook.indexOf('tracker.beginSubmit()');
    expect(refuse).toBeGreaterThan(-1);
    expect(refuse).toBeLessThan(activate);
    expect(refuse).toBeLessThan(tokens);
    expect(hook).toMatch(/refuseAgentSubmit\(\);[\s\S]{0,400}humanBusy: true[\s\S]{0,300}return;/);
    expect(hook).toMatch(/humanBusy: optionsRef\.current\.humanBusy\?\.\(\) === true/); // the session ignores fills while busy
  });
});
