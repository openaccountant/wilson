import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  ALLOWED_HIDDEN_INPUTS,
  ALLOWED_READONLY_INPUTS,
  AgentFormSession,
  AgentValueGuard,
  DECLARATIVE_FORMS,
  declarativeAttrs,
  handleDeclarativeSubmit,
  isUnauthorizedOutcome,
  liveHeldFlag,
  resolveShownInfo,
  shouldHoldAgentValues,
  type FormToolInfo,
  type SubmitEventLike,
} from '../dashboard/declarative-submit-core.js';

/**
 * L1: an agent-filled form must not change anything the human sees (a forecast projection, the transaction filters)
 * until the server outcome authorizes it. Ask means a card the human has not answered yet; Reject, expiry, a cancel,
 * a refusal or a stale card must leave the human's own values where they were.
 */

function agentEvent() {
  let responded: Promise<unknown> | null = null;
  const ev: SubmitEventLike = { agentInvoked: true, preventDefault: () => {}, respondWith: (p) => { responded = p; } };
  return { ev, responded: () => responded };
}

describe('shouldHoldAgentValues', () => {
  test('an Ask tool holds, and so does an unknown policy (fail closed); Allow does not', () => {
    expect(shouldHoldAgentValues('ask')).toBe(true);
    expect(shouldHoldAgentValues(undefined)).toBe(true);
    expect(shouldHoldAgentValues('allow')).toBe(false);
  });
});

describe('AgentValueGuard', () => {
  test('activation snapshots the human values once and holds under Ask', () => {
    const g = new AgentValueGuard<{ n: number }>();
    let human = { n: 1 };
    const first = g.activate('ask', () => human);
    expect(first.held).toBe(true);
    human = { n: 99 }; // the agent filled the form
    expect(g.activate('ask', () => human).held).toBe(true); // a second activation keeps the FIRST snapshot
    expect(g.discard(g.generation)).toEqual({ restore: { value: { n: 1 } } });
  });

  test('under Allow nothing is held, but the snapshot is still kept so a refusal can restore it', () => {
    const g = new AgentValueGuard<string>();
    expect(g.activate('allow', () => 'human').held).toBe(false);
    expect(g.discard(g.generation)).toEqual({ restore: { value: 'human' } });
  });

  test('authorize drops the snapshot and the hold: the agent values stay and take effect', () => {
    const g = new AgentValueGuard<string>();
    g.activate('ask', () => 'human');
    expect(g.authorize(g.generation)).toEqual({ held: false });
    expect(g.held).toBe(false);
    expect(g.discard(g.generation)).toEqual({ restore: null }); // nothing left to restore
  });

  test('discard with nothing snapshotted restores nothing (a human edit is never overwritten)', () => {
    const g = new AgentValueGuard<string>();
    expect(g.discard(g.generation)).toEqual({ restore: null });
  });

  test('a long-pending EARLIER submit settling after a newer activation neither authorizes nor discards the newer fill', () => {
    const g = new AgentValueGuard<string>();
    g.activate('ask', () => 'human-1');
    const first = g.beginSubmit();
    g.discard(first); // first call ends unauthorized, snapshot consumed
    g.activate('ask', () => 'human-2');
    expect(g.authorize(first)).toEqual({ held: true }); // stale token: ignored, still held
    expect(g.discard(first)).toEqual({ restore: null });
    expect(g.discard(g.generation)).toEqual({ restore: { value: 'human-2' } });
  });

  test('active is true from activation until an outcome settles the values', () => {
    const g = new AgentValueGuard<string>();
    expect(g.active).toBe(false);
    g.activate('ask', () => 'h');
    expect(g.active).toBe(true);
    g.authorize(g.generation);
    expect(g.active).toBe(false);
    g.activate('allow', () => 'h');
    g.discard(g.generation);
    expect(g.active).toBe(false);
  });

  test('the snapshot value may be undefined (a form that routes agent writes into a draft needs none)', () => {
    const g = new AgentValueGuard<undefined>();
    g.activate('ask', () => undefined);
    expect(g.discard(g.generation)).toEqual({ restore: { value: undefined } });
  });
});

describe('isUnauthorizedOutcome covers refusals returned as {error}', () => {
  test('a non-committed outcome and an {error:{code,message}} result are both unauthorized; data and committed are not', () => {
    for (const outcome of ['rejected', 'expired', 'stale', 'cancelled', 'unknown']) expect(isUnauthorizedOutcome({ outcome, operationId: 'op' })).toBe(true);
    expect(isUnauthorizedOutcome({ error: { code: 'forbidden', message: 'no' } })).toBe(true);
    expect(isUnauthorizedOutcome({ outcome: 'committed', operationId: 'op' })).toBe(false);
    expect(isUnauthorizedOutcome({ rows: [] })).toBe(false);
    expect(isUnauthorizedOutcome({ authorized: true })).toBe(false);
  });
});

describe('handleDeclarativeSubmit reports whether the server authorized the agent values', () => {
  const run = async (answer: () => Promise<unknown>) => {
    const { ev, responded } = agentEvent();
    const log: string[] = [];
    const out = handleDeclarativeSubmit({
      nativeEvent: ev,
      classification: 'page',
      agentTouched: true,
      toolName: 'set_forecast_inputs',
      getArgs: () => ({ monthly_income: 4000 }),
      callServerTool: answer,
      afterServer: async () => { log.push('afterServer'); return 'applied'; },
      onAuthorized: () => { log.push('authorized'); },
      onUnauthorized: (why) => { log.push(`unauthorized:${(why as { outcome?: string; error?: { code: string } }).outcome ?? (why as { error?: { code: string } }).error?.code}`); },
    });
    await out.settled;
    return { log, answer: await responded() };
  };

  test('an authorized answer runs onAuthorized BEFORE afterServer (the hold lifts before the page recomputes)', async () => {
    expect((await run(async () => ({ authorized: true }))).log).toEqual(['authorized', 'afterServer']);
  });

  test('Reject, expiry, stale and cancelled each report unauthorized and never run afterServer', async () => {
    for (const outcome of ['rejected', 'expired', 'stale', 'cancelled']) {
      const r = await run(async () => ({ outcome, operationId: 'op1' }));
      expect(r.log).toEqual([`unauthorized:${outcome}`]);
    }
  });

  test('a server refusal (rejection) is unauthorized too, and the agent is handed an {error} RESULT (Chrome hides thrown text)', async () => {
    const r = await run(async () => { throw Object.assign(new Error('forbidden here'), { code: 'role_forbidden' }); });
    expect(r.log).toEqual(['unauthorized:role_forbidden']);
    expect(r.answer).toEqual({ error: { code: 'role_forbidden', message: 'forbidden here' } });
  });

  test('an {error} result from the bridge is unauthorized', async () => {
    const r = await run(async () => ({ error: { code: 'policy_off', message: 'off' } }));
    expect(r.log).toEqual(['unauthorized:policy_off']);
  });
});

describe('L3: a live info change is deferred while an agent call is in flight', () => {
  const info = (extra: Partial<FormToolInfo> = {}): FormToolInfo => ({ name: 't', description: 'd', classification: 'read', autosubmit: true, inputSchema: {}, ...extra });

  test('idle: the next info is shown at once', () => {
    const a = info();
    const b = info({ description: 'changed' });
    expect(resolveShownInfo(a, b, false)).toBe(b);
  });

  test('busy: a change to a still-live tool waits (the attributes the browser registered are not rewritten mid-call)', () => {
    const a = info();
    expect(resolveShownInfo(a, info({ description: 'changed' }), true)).toBe(a);
    expect(declarativeAttrs(resolveShownInfo(a, info({ description: 'changed' }), true))).toEqual(declarativeAttrs(a));
  });

  test('busy: a tool that went away (revoked, kill switch, policy Off) is applied at once, never deferred', () => {
    expect(resolveShownInfo(info(), undefined, true)).toBeUndefined();
  });

  test('a tool that becomes live while busy is shown (nothing to preserve)', () => {
    const b = info();
    expect(resolveShownInfo(undefined, b, true)).toBe(b);
  });

  test('identical object: returned as it is', () => {
    const a = info();
    expect(resolveShownInfo(a, a, true)).toBe(a);
  });
});

describe('L7: hidden and read-only inputs of declarative forms', () => {
  test('no declarative form carries a type=hidden input today (Chrome exposes hidden inputs to the agent as settable string properties)', () => {
    expect(ALLOWED_HIDDEN_INPUTS).toEqual({});
  });

  test('every read-only input of a declarative form is listed with the reason the agent cannot be handed it', () => {
    // Chrome omits a readonly input from the derived schema, so the agent cannot set it; the server validates it anyway.
    expect(ALLOWED_READONLY_INPUTS).toEqual({ judge_interaction: ['interaction_id'] });
    for (const tool of Object.keys(ALLOWED_READONLY_INPUTS)) expect(DECLARATIVE_FORMS[tool], tool).toBeDefined();
  });

  const uiRoot = join(import.meta.dir, '../dashboard/ui/src');
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      return statSync(full).isDirectory() ? walk(full) : /\.(tsx|ts)$/.test(name) ? [full] : [];
    });
  const formFiles = walk(uiRoot).filter((f) => /useDeclarativeTool\(\{/.test(readFileSync(f, 'utf8')) && !f.endsWith('useDeclarativeTool.ts'));

  test('source guard: a declarative form file declares no hidden input unless it is on the allow-list', () => {
    expect(formFiles.length).toBeGreaterThanOrEqual(5);
    const allowedNames = new Set(Object.values(ALLOWED_HIDDEN_INPUTS).flat());
    for (const file of formFiles) {
      const code = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
      const hidden = [...code.matchAll(/<input\b[^>]*\btype=(?:"hidden"|'hidden'|\{['"]hidden['"]\})[^>]*>/g)];
      for (const m of hidden) {
        const name = /\bname=["']([\w-]+)["']/.exec(m[0])?.[1];
        expect(name && allowedNames.has(name), `${file}: hidden input ${name ?? '(unnamed)'} is not on the allow-list`).toBe(true);
      }
    }
  });

  test('source guard: a read-only input in a form file is on the read-only list', () => {
    const allowed = new Set(Object.values(ALLOWED_READONLY_INPUTS).flat());
    for (const file of formFiles) {
      const code = readFileSync(file, 'utf8');
      for (const m of code.matchAll(/<input\b[^>]*\breadOnly\b[^>]*>/g)) {
        const name = /\bname=["']([\w-]+)["']/.exec(m[0])?.[1];
        expect(name && allowed.has(name), `${file}: readOnly input ${name ?? '(unnamed)'} is not on the allow-list`).toBe(true);
      }
    }
  });
});

describe('source guards: the hook and the forms use the guard (L1), stay still mid-call (L3), listen on window first (L5)', () => {
  const ui = join(import.meta.dir, '../dashboard/ui/src');
  const read = (rel: string) => readFileSync(join(ui, rel), 'utf8');
  const strip = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const hook = strip(read('agent/useDeclarativeTool.ts'));

  test('L5: window is the primary listener target (registered first), document.modelContext the secondary', () => {
    const windowAt = hook.indexOf("window.addEventListener('toolactivated'");
    const contextAt = hook.indexOf("mc.addEventListener('toolactivated'");
    expect(windowAt).toBeGreaterThan(-1);
    expect(contextAt).toBeGreaterThan(windowAt);
    expect(hook).toContain("window.addEventListener('toolcancel'");
    expect(hook).toContain("mc.addEventListener('toolcancel'");
    expect(hook).toContain('new WeakSet<Event>()'); // an event delivered to both targets is handled once
    expect(hook).not.toMatch(/\.ontool(activated|cancel)/);
  });

  test('L1: the hook snapshots at toolactivated, releases on authorize, restores on unauthorized, cancel, reset and revocation', () => {
    expect(hook).toContain('new AgentFormSession(tool)'); // the tracker and the guard, kept consistent (G1)
    expect(hook).toMatch(/\.apply\(event, \{\s*policy: infoRef\.current\?\.policy,\s*take: \(\) => optionsRef\.current\.snapshot\?\.\(\)/);
    expect(hook).toMatch(/onAuthorized:[\s\S]{0,120}guard\.authorize\(guardToken\)/);
    expect(hook).toMatch(/onUnauthorized: \(\) => discardAgentValues\(guardToken\)/);
    expect(hook).toMatch(/if \(next\.restore\) optionsRef\.current\.restore\?\.\(next\.restore\.value\)/); // toolcancel, reset, tool no longer live
    expect(hook).toContain('optionsRef.current.restore?.(restore.value)');
    expect(hook).toContain('effectsHeld');
  });

  test('L3: while a call is in flight the shown info is deferred, the lists are held, and a refetch waits for the settle', () => {
    expect(hook).toContain('resolveShownInfo(shownRef.current, registryInfo, busy)');
    expect(hook).toContain('const hold = ');
    expect(hook).toMatch(/optionsRef\.current\.onSettled\?\.\(\)/);
  });

  test('L1 generalized: every read and page form passes snapshot/restore to the hook, and honours effectsHeld', () => {
    const files = ['tabs/TransactionsTab.tsx', 'components/ManualInputsForm.tsx'];
    const sources = files.map((f) => strip(read(f))).join('\n');
    const readOrPage = Object.entries(DECLARATIVE_FORMS).filter(([, f]) => f.classification === 'read' || f.classification === 'page');
    expect(readOrPage.map(([n]) => n).sort()).toEqual(['filter_transactions', 'set_forecast_inputs']);
    for (const [tool] of readOrPage) {
      const at = sources.indexOf(`tool: '${tool}'`);
      expect(at, tool).toBeGreaterThan(-1);
      const call = sources.slice(at, at + 1800);
      expect(call, `${tool} snapshot`).toContain('snapshot:');
      expect(call, `${tool} restore`).toContain('restore:');
    }
    expect(sources).toContain('declarative.effectsHeld'); // ManualInputsForm
    expect(sources).toContain('filterForm.effectsHeld'); // the filter bar
  });

  test('L1: the forecast boxes do not feed the projection while held, and re-run when the hold lifts', () => {
    const code = strip(read('components/ManualInputsForm.tsx'));
    expect(code).toMatch(/if \(isHeldNow \? isHeldNow\(\) : held\) return;/);
    expect(code).toMatch(/\}, \[raw, held, holdEpoch\]\)/);
  });

  test('L1: the filter bar writes into a draft while held and drops it on restore', () => {
    const code = strip(read('tabs/TransactionsTab.tsx'));
    expect(code).toContain('if (filterForm.effectsHeldRef.current) setDraft(');
    expect(code).toMatch(/restore: \(snap\) => \{\s*setDraft\(null\);/);
    expect(code).toMatch(/afterServer: \(args, server\) => \{\s*setDraft\(null\);/);
  });

  test('L2: review_action advertises itself only once its option lists exist, and the category options never depend on the chosen review or action', () => {
    const code = strip(read('tabs/ReviewTab.tsx'));
    expect(code).toContain('ready: reviewOptions.length > 0 && categoryOptions.length > 0');
    expect(code).toContain('const categoryOptions = useMemo(() => buildCategoryOptions(categoryRows), [categoryRows]);');
    // The select renders every option unconditionally: no branch on the review or the action around it.
    const select = code.slice(code.indexOf('name="category_id"'), code.indexOf('Resolve\n'));
    expect(select).toContain('shownCategoryOptions.map(');
    expect(select).not.toMatch(/reviewId\s*(\?|&&)|action\s*(===|!==)|\{reviewId/);
  });
});

describe('G2: the hold is read at event time, not from render state', () => {
  const ui = join(import.meta.dir, '../dashboard/ui/src');
  const strip = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const read = (rel: string) => strip(readFileSync(join(ui, rel), 'utf8'));

  test('pure: the live flag is true the instant toolactivated is handled and false the instant the hold lifts (no render needed)', () => {
    const s = new AgentFormSession<string>('filter_transactions');
    const flag = liveHeldFlag(s.guard);
    expect(flag.current).toBe(false);
    s.apply({ type: 'toolactivated', toolName: 'filter_transactions' }, { policy: 'ask', take: () => 'human' });
    expect(flag.current).toBe(true); // same tick as the event: the agent's first input events already see it
    s.guard.authorize(s.guard.generation);
    expect(flag.current).toBe(false);
    s.apply({ type: 'toolactivated', toolName: 'filter_transactions' }, { policy: 'allow', take: () => 'human' });
    expect(flag.current).toBe(false); // Allow never holds
  });

  test('pure: the flag follows a discard (toolcancel) as well', () => {
    const s = new AgentFormSession<string>('set_forecast_inputs');
    const flag = liveHeldFlag(s.guard);
    s.apply({ type: 'toolactivated', toolName: 'set_forecast_inputs' }, { policy: undefined, take: () => 'h' });
    expect(flag.current).toBe(true); // unknown policy fails closed
    s.apply({ type: 'toolcancel', toolName: 'set_forecast_inputs' });
    expect(flag.current).toBe(false);
  });

  test('source guard: the hook exposes the live flag built from the session guard and a hold epoch', () => {
    const hook = read('agent/useDeclarativeTool.ts');
    expect(hook).toContain('effectsHeldRef.current = liveHeldFlag(sessionRef.current.guard)');
    expect(hook).toMatch(/effectsHeldRef: effectsHeldRef\.current,\s*holdEpoch: guardView\.epoch/);
  });

  test('source guard: the filter bar decides draft-or-apply from effectsHeldRef.current (never render-time effectsHeld) and batches draft edits functionally', () => {
    const code = read('tabs/TransactionsTab.tsx');
    const edit = code.slice(code.indexOf('const editFilter'), code.indexOf('const filterCategoryOptions'));
    expect(edit).toContain('filterForm.effectsHeldRef.current');
    expect(edit).not.toContain('filterForm.effectsHeld)');
    expect(edit).toMatch(/setDraft\(\(d\) => \(\{ \.\.\.\(d \?\? humanFilters\), \.\.\.patch \}\)\)/);
  });

  test('source guard: no tab or form reads effectsHeld from render state to decide an edit; the forecast boxes read the ref at effect time', () => {
    const forecast = read('components/ManualInputsForm.tsx');
    expect(forecast).toContain('isHeldNow={() => declarative.effectsHeldRef.current}');
    expect(forecast).toContain('holdEpoch={declarative.holdEpoch}');
    expect(forecast).not.toMatch(/if \(held\) return;/);
    // The only render-state use left is display / effect dependencies, never an `if (x.effectsHeld)` decision.
    for (const rel of ['tabs/TransactionsTab.tsx', 'components/ManualInputsForm.tsx']) {
      expect(read(rel), rel).not.toMatch(/if \([\w.]*effectsHeld\b/);
    }
  });
});
