import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type FormEvent, type FormHTMLAttributes, type SyntheticEvent } from 'react';
import { getPageRegistry, type LiveToolInfo } from '@webmcp-registry';
import {
  DECLARATIVE_FORMS,
  declarativeAttrs,
  buildFormArgs,
  AgentFormSession,
  liveHeldFlag,
  handleDeclarativeSubmit,
  isBrowserAgentFill,
  nextFormKey,
  paramAttrs,
  readFill,
  resolveShownInfo,
  type FormKeyState,
  type TouchedEvent,
  type SubmitEventLike,
} from '@declarative-submit';

/**
 * Wires one declarative WebMCP form to the page registry and to React state.
 *
 * Everything that decides anything lives in `@declarative-submit` (pure, tested from the root):
 *  - the form carries `toolname`, `tooldescription` (and `toolautosubmit` for a read or page form) only while
 *    the bridge says the tool is live (and the form says it is `ready`, i.e. its option lists are loaded, because
 *    Chrome derives the schema from the DOM it sees), and each field's `toolparamdescription` comes from the same info;
 *  - when the tool stops being live the form's React `key` changes, so React replaces the element and the
 *    browser unregisters the form tool whether or not it reacts to attributes being removed;
 *  - while an agent call is in flight the form is NEVER re-keyed for a change to a still-live tool, its attributes are
 *    not rewritten, and `hold` freezes the option lists: Chrome cancels a running call when its tool definition is
 *    updated. Revocation (the tool is no longer live) is applied at once;
 *  - an `agentInvoked` submit never runs the page's handler: `nativeEvent.preventDefault()` first, then
 *    `nativeEvent.respondWith(callServerTool(...))`, so a change resolves only after the human answered the card;
 *  - a human submit of a form an agent filled (`toolactivated` was seen) goes through the same card;
 *  - an agent's VALUES take no effect on the page until the server authorizes the call (`AgentValueGuard`): the human's
 *    values are snapshotted at the first sign of the call (Chrome 154 order: agent fill, agentInvoked submit, then
 *    `toolactivated`; the fill is detected by `onInputCapture`), `effectsHeld` tells the page to hold back (Ask policy), and they are put
 *    back (`restore`) on a rejected / expired / stale / cancelled / refused outcome and on `toolcancel`.
 *
 * `toolactivated` / `toolcancel` are dispatched on `window` (a trusted `WebMCPEvent` with `toolName`; observed live in
 * Chrome 154), so that is the primary target. `document.modelContext` is listened on as a secondary one (the explainer
 * and some builds name it; `toolchange` is the event that does live there), de-duplicated per event. Always
 * `addEventListener`, never `window.on*`.
 * Whenever the agent-touched flag drops (cancel, reset, a completed submit, the tool no longer live) the form is
 * also told to clear the values the agent filled (`onAgentCleared`), so a later plain click cannot send them down
 * the human path with no card.
 */

export interface UseDeclarativeToolOptions {
  /** The catalog name of the tool this form exposes. Must be in `DECLARATIVE_FORMS`. */
  tool: string;
  /**
   * After the server answered an agent's call: apply it to the page (filters, forecast inputs) and return what the
   * agent should be told. Default: the server's answer.
   */
  afterServer?: (args: Record<string, unknown>, serverResult: unknown) => unknown | Promise<unknown>;
  /** Clear the controlled field state of a mutating form: called when the agent-touched flag drops. */
  onAgentCleared?: () => void;
  /** The page's existing handler for a human submit (the REST path). */
  onHumanSubmit?: (args: Record<string, unknown>) => void | Promise<void>;
  /**
   * The human's values, captured when an agent activates this form (before it fills anything). Optional: a form that
   * routes the agent's writes into a draft (see `effectsHeld`) has nothing to capture.
   */
  snapshot?: () => unknown;
  /**
   * Put the human's values back: the agent's call was not authorized (rejected, expired, stale, cancelled, refused), or
   * the agent cancelled. Receives what `snapshot` returned.
   */
  restore?: (snapshot: unknown) => void;
  /**
   * Whether a PERSON's save of this form is in flight (read at event time; use `useHumanBusy`). While it is, the form's fields
   * are locked and Chrome's agent fill is dropped, so an `agentInvoked` submit is answered `busy` with no server operation
   * and the person's values and save are left alone.
   */
  humanBusy?: () => boolean;
  /** After a submit has fully settled (the agent has its answer): refetch lists here, never mid-call. */
  onSettled?: () => void;
  /**
   * False while the form's option lists are not loaded yet. The form then carries no tool attributes, so the schema
   * Chrome derives is always the complete one (a select with only its empty option would be unusable by an agent).
   */
  ready?: boolean;
}

export interface DeclarativeFormBinding {
  /** Spread onto the `<form>`: the tool attributes (only while live) and the submit and reset handlers. */
  formProps: FormHTMLAttributes<HTMLFormElement> & Record<string, unknown>;
  /** Use as the form's React `key`. */
  formKey: string;
  /** Spread onto a field: its `toolparamdescription` (only while live). */
  field: (name: string) => Record<string, string>;
  live: boolean;
  /** An agent filled this form and has not cancelled, reset or submitted since. Show `AgentFilledBanner`. */
  agentTouched: boolean;
  /**
   * A page tool of an agent chose what this mutating form acts on (e.g. pre-selected the review). Flags the form
   * as agent-touched, even when the form tool itself is not live, so the next human submit goes through the card.
   * It lasts until a submit settles, a reset or a cancel (never a visual timer). Safe to call from an effect.
   */
  markAgentTouched: () => void;
  /**
   * An agent filled this form and the server has not authorized it yet, and the policy is Ask (or unknown): the page must
   * NOT apply the agent's values (recompute a projection, filter a list). Route the writes into a draft or skip the
   * effect while this is true; it lifts when the server authorizes the call, and `restore` runs when it does not.
   */
  effectsHeld: boolean;
  /**
   * The same hold as `effectsHeld`, read at EVENT time: `effectsHeldRef.current` is the guard's own flag, set synchronously
   * by the form's input-capture listener on the agent's first fill (before that field's onChange; Chrome 154 fills before
   * `toolactivated`). Use it in input handlers: render
   * state lags the event by a render, and the agent's first `input` events can arrive before that render.
   */
  effectsHeldRef: { readonly current: boolean };
  /** Changes every time the hold turns on or off, so an effect gated on the hold re-runs even if a render never saw it. */
  holdEpoch: number;
  /** An agent call is in flight (the form was activated and has not settled or been cancelled). */
  busy: boolean;
  /**
   * `hold('key', options)`: the value, except that while an agent call is in flight it is the one last returned when
   * idle. Pass option lists through it so a refetch cannot change the select Chrome derived the schema from mid-call.
   */
  hold: <T>(key: string, value: T) => T;
  /** The outcome of a human submit of an agent-touched form, to show inline (null otherwise). */
  outcome: unknown;
  /** Set when a human tried to submit a form that is for agents only. */
  blockedMessage: string | null;
}

interface ModelContextEvents {
  addEventListener?: (type: string, listener: (e: Event) => void) => void;
  removeEventListener?: (type: string, listener: (e: Event) => void) => void;
}

/** No recorded agent fills: a person's submit reads the form as it is. */
const NO_FILLS: ReadonlyMap<string, string> = new Map();

function modelContextOf(): ModelContextEvents | undefined {
  return (document as unknown as { modelContext?: ModelContextEvents }).modelContext;
}

function registryOf() {
  return getPageRegistry(window as unknown as Parameters<typeof getPageRegistry>[0]);
}

/**
 * A person's own save in flight, as state (for `fieldLock`) AND as a ref the hook reads at event time (render state lags a
 * Chrome event by a render). Pass `isBusy` as `humanBusy`.
 */
export function useHumanBusy(): { busy: boolean; setBusy: (value: boolean) => void; isBusy: () => boolean } {
  const [busy, setBusyState] = useState(false);
  const ref = useRef(false);
  const setBusy = useCallback((value: boolean) => {
    ref.current = value;
    setBusyState(value);
  }, []);
  const isBusy = useCallback(() => ref.current, []);
  return { busy, setBusy, isBusy };
}

export function useDeclarativeTool(options: UseDeclarativeToolOptions): DeclarativeFormBinding {
  const { tool } = options;
  const form = DECLARATIVE_FORMS[tool];
  const registry = registryOf();
  const ready = options.ready ?? true;

  // The registry's own info object: identity-stable until the bridge publishes a real change to this tool.
  const registryInfo: LiveToolInfo | undefined = useSyncExternalStore(
    useCallback((onChange) => registry.subscribe(onChange), [registry]),
    () => registry.toolInfo(tool),
    () => undefined
  );

  const [agentTouched, setAgentTouched] = useState(false);
  const [submitting, setSubmitting] = useState(0);
  // The guard's two public facts, mirrored into state so a change re-renders: `held` (the agent's values take no effect
  // yet) and `active` (an agent activated the form and nothing has settled its values). A form that is only
  // pre-selected by an agent page tool (`markAgentTouched`) is NOT busy: its lists keep refreshing.
  const [guardView, setGuardView] = useState({ held: false, active: false, epoch: 0 });
  const effectsHeld = guardView.held;
  const busy = guardView.active || submitting > 0;

  // What the form advertises. A change to a still-live tool waits for an in-flight agent call; revocation does not.
  const shownRef = useRef<LiveToolInfo | undefined>(undefined);
  const info = resolveShownInfo(shownRef.current, registryInfo, busy);
  shownRef.current = info;
  const live = info !== undefined && ready;
  const exposedInfo = live ? info : undefined;

  // Derived state: the key moves on live -> not live, in the same render that learns it.
  const [keyState, setKeyState] = useState<FormKeyState>(() => nextFormKey(undefined, live));
  const nextKey = nextFormKey(keyState, live);
  if (nextKey.key !== keyState.key || nextKey.live !== keyState.live) setKeyState(nextKey);

  // The tracker and the guard live in one session, which keeps `tracker.touched === false` => `guard.active === false`.
  const sessionRef = useRef<AgentFormSession | null>(null);
  if (!sessionRef.current) sessionRef.current = new AgentFormSession(tool);
  // The hold, read live (never render state): see `effectsHeldRef` on the binding.
  const effectsHeldRef = useRef<{ readonly current: boolean } | null>(null);
  if (!effectsHeldRef.current) {
    effectsHeldRef.current = liveHeldFlag(sessionRef.current.guard);
  }
  /** Mirror the guard's two facts into state; a change of `held` also bumps the epoch. */
  const publishGuard = useCallback(() => {
    const g = (sessionRef.current as AgentFormSession).guard;
    setGuardView((prev) => ({ held: g.held, active: g.active, epoch: prev.held !== g.held ? prev.epoch + 1 : prev.epoch }));
  }, []);
  const [outcome, setOutcome] = useState<unknown>(null);
  const [blockedMessage, setBlockedMessage] = useState<string | null>(null);

  // Latest options and info, read at submit time without re-subscribing anything.
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const infoRef = useRef(exposedInfo);
  infoRef.current = exposedInfo;

  /** Put the human's values back, if an agent's are still unauthorized. A no-op when nothing is snapshotted. */
  const discardAgentValues = useCallback((token?: number) => {
    const guard = (sessionRef.current as AgentFormSession).guard;
    const { restore } = guard.discard(token ?? guard.generation);
    publishGuard();
    if (restore) optionsRef.current.restore?.(restore.value);
  }, [publishGuard]);

  const touch = useCallback(
    (event: TouchedEvent) => {
      // A form that is not live carries no tool attributes, so no agent can have filled it: ignore activations
      // (an unattributable one would otherwise flag it and later wipe what the human typed).
      if (event.type === 'toolactivated' && infoRef.current === undefined) return;
      if ((event.type === 'agentfill' || event.type === 'agentsubmit') && infoRef.current === undefined) return;
      // The human's values are captured BEFORE the tracker flips (the agent fills the form after this event), and
      // whenever the flag drops while the guard is still active the session discards the agent's values (never a
      // cleared tracker over an active guard): the snapshot comes back as `restore`.
      const next = (sessionRef.current as AgentFormSession).apply(event, {
        policy: infoRef.current?.policy,
        take: () => optionsRef.current.snapshot?.(),
        humanBusy: optionsRef.current.humanBusy?.() === true,
      });
      publishGuard();
      setAgentTouched(next.touched);
      if (next.restore) optionsRef.current.restore?.(next.restore.value);
      if (next.cleared) {
        // Cancel, reset, tool revoked: the agent's values go, the human's come back.
        optionsRef.current.onAgentCleared?.();
      }
    },
    [tool, publishGuard]
  );

  useEffect(() => {
    // One event is handled once even if both targets deliver it.
    const seen = new WeakSet<Event>();
    const handle = (type: 'toolactivated' | 'toolcancel') => (e: Event) => {
      if (seen.has(e)) return;
      seen.add(e);
      touch({ type, toolName: (e as Event & { toolName?: string }).toolName });
    };
    const onActivated = handle('toolactivated');
    const onCancel = handle('toolcancel');
    // Primary target: window (observed live in Chrome 154). Secondary: document.modelContext, in case a build dispatches there.
    window.addEventListener('toolactivated', onActivated);
    window.addEventListener('toolcancel', onCancel);
    const mc = modelContextOf();
    if (mc && typeof mc.addEventListener === 'function') {
      mc.addEventListener('toolactivated', onActivated);
      mc.addEventListener('toolcancel', onCancel);
    }
    return () => {
      window.removeEventListener('toolactivated', onActivated);
      window.removeEventListener('toolcancel', onCancel);
      if (mc && typeof mc.removeEventListener === 'function') {
        mc.removeEventListener('toolactivated', onActivated);
        mc.removeEventListener('toolcancel', onCancel);
      }
    };
  }, [touch]);

  // A tool that is no longer live cannot have been touched by an agent, and what it filled must not linger.
  useEffect(() => {
    if (!live) touch({ type: 'reset' });
  }, [live, touch]);

  const onSubmit = useCallback(
    (e: FormEvent<HTMLFormElement>) => {
      const formEl = e.currentTarget;
      // React's synthetic event has no `agentInvoked` or `respondWith`: those live on the native SubmitEvent.
      const nativeEvent = e.nativeEvent as unknown as SubmitEventLike;
      // A person's save is in flight: the lock dropped the agent's fill, so this submit would carry the PERSON's values under the
      // agent's call. Refuse it (`busy`, no operation) and touch nothing: the person's values and save stay as they are.
      if (nativeEvent.agentInvoked === true && (sessionRef.current as AgentFormSession).shouldRefuseAgentSubmit(optionsRef.current.humanBusy?.() === true)) {
        (sessionRef.current as AgentFormSession).refuseAgentSubmit();
        handleDeclarativeSubmit({
          nativeEvent,
          formEl,
          classification: form.classification,
          agentTouched: false,
          toolName: tool,
          humanBusy: true,
          getArgs: () => ({}),
          callServerTool: () => Promise.reject(new Error('unreachable: a refused submit makes no server call')),
        });
        return;
      }
      // Chrome 154 dispatches the agentInvoked submit BEFORE `toolactivated`: activate now, so the tokens below belong to
      // this call (the late `toolactivated` is absorbed by the session instead of making them stale).
      if (nativeEvent.agentInvoked === true) touch({ type: 'agentsubmit' });
      const { tracker, guard } = sessionRef.current as AgentFormSession;
      const token = tracker.beginSubmit();
      const guardToken = guard.beginSubmit();
      setBlockedMessage(null);
      setOutcome(null);
      setSubmitting((n) => n + 1);
      const result = handleDeclarativeSubmit({
        nativeEvent,
        // Also asks the browser (`:tool-form-active`) whether an agent is driving this form, besides the event flag.
        formEl,
        classification: form.classification,
        agentTouched: tracker.touched,
        toolName: tool,
        // An agent's submit carries what the agent filled (recorded from its fill events), never the DOM after the hold: the
        // re-render of the held form puts the person's text back over the agent's (V1). A person's submit reads the form.
        getArgs: () =>
          buildFormArgs({
            entries: new FormData(formEl).entries(),
            schema: infoRef.current?.inputSchema,
            fills: nativeEvent.agentInvoked === true ? (sessionRef.current as AgentFormSession).agentFills() : NO_FILLS,
          }),
        callServerTool: (name, args, opts) => {
          const call = registryOf().callServerTool;
          if (!call) return Promise.reject(new Error('Agent access is not connected to this page. Reload it and grant the tool again.'));
          // `agentCall`: only an agent's own submit is tracked (and withdrawn on its `toolcancel`); a person's is never.
          return call(name, args, { transport: opts.transport, agentCall: opts.agentCall });
        },
        // Authorized: the hold lifts BEFORE the page applies the values and computes from them.
        onAuthorized: () => {
          guard.authorize(guardToken);
          publishGuard();
        },
        // Not authorized (rejected, expired, stale, cancelled, refused): the human's values come back.
        onUnauthorized: () => discardAgentValues(guardToken),
        afterServer: optionsRef.current.afterServer,
        onHumanSubmit: optionsRef.current.onHumanSubmit,
        onOutcome: setOutcome,
        onBlocked: setBlockedMessage,
      });
      void result.settled.then(() => {
        setSubmitting((n) => Math.max(0, n - 1));
        const next = (sessionRef.current as AgentFormSession).settle(token);
        publishGuard();
        setAgentTouched(next.touched);
        if (next.restore) optionsRef.current.restore?.(next.restore.value);
        if (next.cleared) optionsRef.current.onAgentCleared?.();
        // The agent has its answer: only now may the page refetch and re-render lists (never mid-call). A human's own
        // submit (or a blocked one) has its own refresh.
        if (result.route === 'operation' || result.route === 'call') optionsRef.current.onSettled?.();
      });
    },
    [form.classification, tool, discardAgentValues, publishGuard, touch]
  );

  // Chrome 154 writes the agent's values into the fields BEFORE `toolactivated` (trusted plain `input` Events on fields
  // without focus). This capture listener runs before the field's own onChange, so the session snapshots the human's
  // values and sets the hold before the page can apply the first agent value.
  const onInputCapture = useCallback(
    (e: SyntheticEvent<HTMLFormElement>) => {
      const ev = e.nativeEvent;
      const isInputEvent = typeof InputEvent !== 'undefined' && ev instanceof InputEvent;
      const fill = readFill(e.target as unknown as Parameters<typeof readFill>[0]);
      if (isBrowserAgentFill({ isTrusted: ev.isTrusted, isInputEvent, targetFocused: e.target === document.activeElement })) {
        touch({ type: 'agentfill' });
        // Record what the agent wrote NOW: `touch` re-renders the form before the field's onChange, which resets a controlled field.
        if (fill) (sessionRef.current as AgentFormSession).noteFill(fill.name, fill.value);
      } else if (fill) {
        (sessionRef.current as AgentFormSession).noteHumanEdit(fill.name);
      }
    },
    [touch]
  );

  const onReset = useCallback(() => touch({ type: 'reset' }), [touch]);
  const markAgentTouched = useCallback(() => touch({ type: 'prefilled' }), [touch]);

  // Option lists, frozen while an agent call is in flight.
  const heldValues = useRef(new Map<string, unknown>());
  const hold = <T,>(key: string, value: T): T => {
    const store = heldValues.current;
    if (busy && store.has(key)) return store.get(key) as T;
    store.set(key, value);
    return value;
  };

  return {
    formProps: { ...declarativeAttrs(exposedInfo), onSubmit, onReset, onInputCapture },
    formKey: `${tool}:${nextKey.key}`,
    field: (name) => paramAttrs(exposedInfo, name),
    live,
    agentTouched,
    markAgentTouched,
    effectsHeld,
    effectsHeldRef: effectsHeldRef.current,
    holdEpoch: guardView.epoch,
    busy,
    hold,
    outcome,
    blockedMessage,
  };
}
