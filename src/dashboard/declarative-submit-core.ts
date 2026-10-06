/**
 * Decision logic for the declarative WebMCP forms, free of node and DOM imports (it imports only the import-free text-hygiene rule) so the React dashboard can bundle
 * it (alias `@declarative-submit`) and root tests can import it without a browser.
 *
 * A declarative form is an ordinary `<form>` that the page marks with `toolname` / `tooldescription` (and each
 * field with `toolparamdescription`) so a browser agent can call it as a tool. Everything an agent does through
 * one still goes through the single enforcement path (grant, role, policy, prepare, card, commit), because an
 * `agentInvoked` submit never runs the page's own handler: it is turned into one `callServerTool` call.
 *
 *  - `routeSubmit`:   the routing truth table (who submitted, whether an agent touched the form, what it is).
 *  - `handleDeclarativeSubmit`: runs a route on a native SubmitEvent (preventDefault first, then respondWith).
 *  - `formToArgs`:    FormData strings -> typed args, using the catalog's JSON Schema.
 *  - `build*Options`: `<option>` lists made only of ids, dates, amounts, enums and safe category labels,
 *                     because option labels become part of the tool schema an agent reads (threat T20).
 */

import { SAFE_CUSTOM_CATEGORY } from '../mcp/text-hygiene.js'; // the one category-name rule, shared with the server (import-free module)
import { errorResult, isAbortError, isErrorResult } from './webmcp-tool-error.js'; // import-free: a refusal is a result, not a throw

export type FormClass = 'read' | 'mutating' | 'proposal' | 'page';

/** The one thing the page needs to know about each declarative form that the catalog also knows. A test pins them together. */
export const DECLARATIVE_FORMS: Readonly<Record<string, { classification: FormClass; autosubmit: boolean }>> = {
  list_transactions: { classification: 'read', autosubmit: true },
  resolve_review_item: { classification: 'mutating', autosubmit: false },
  set_budget: { classification: 'mutating', autosubmit: false },
  update_goal: { classification: 'mutating', autosubmit: false },
  propose_judgment: { classification: 'proposal', autosubmit: false },
  fill_forecast_inputs: { classification: 'page', autosubmit: true },
};

/**
 * `type="hidden"` inputs of the declarative forms. Chrome exposes a hidden input to the agent as a settable string
 * property, so a hidden id would be a way around the server's checks. Today there are none; adding one means listing
 * it here (a source guard fails otherwise) and the server validating it like any other argument.
 */
export const ALLOWED_HIDDEN_INPUTS: Readonly<Record<string, readonly string[]>> = {};

/**
 * Read-only inputs. Chrome leaves a `readonly` input out of the schema it derives, so the agent cannot set it, but the
 * browser still submits its value, so the server treats it as untrusted input like any other. `propose_judgment`'s
 * `interaction_id` is the interaction the panel is open on.
 */
export const ALLOWED_READONLY_INPUTS: Readonly<Record<string, readonly string[]>> = {
  propose_judgment: ['interaction_id'],
};

export const AGENT_BANNER_TEXT = 'Agent filled this form — review before submitting.';
export const PROPOSAL_BLOCKED_TEXT = 'This form is for agents. Use the rating controls above.';

// ── Routing ──────────────────────────────────────────────────────────────────

export interface SubmitRouteInput {
  /** `SubmitEvent.agentInvoked`: true when the browser's agent submitted the form. Undefined without the API. */
  agentInvoked: boolean | undefined;
  /** An agent activated this form (`toolactivated`) and it has not been cancelled, reset or submitted since. */
  agentTouched: boolean;
  classification: FormClass;
}

export interface SubmitRoute {
  /**
   * `operation`: the server call may return a confirmation card to wait on (mutating, proposal).
   * `call`: the server call answers directly (read, page).
   * `blocked`: nothing runs. `human`: the page's own handler runs.
   */
  route: 'operation' | 'call' | 'blocked' | 'human';
  /** The page answers the agent through `respondWith`. */
  respond: boolean;
  message?: string;
}

const isChange = (c: FormClass) => c === 'mutating' || c === 'proposal';

export function routeSubmit(input: SubmitRouteInput): SubmitRoute {
  const { agentInvoked, agentTouched, classification } = input;
  if (agentInvoked === true) return { route: isChange(classification) ? 'operation' : 'call', respond: true };
  // Not the agent's submit. A proposal form is for agents only: a human can never submit it, touched or not.
  if (classification === 'proposal') return { route: 'blocked', respond: false, message: PROPOSAL_BLOCKED_TEXT };
  // An agent filled this form and then something clicked Submit (possibly the agent itself, through CDP):
  // `agentInvoked` is false, but the form still goes through the card, never the human REST path (threat T21).
  if (classification === 'mutating' && agentTouched) return { route: 'operation', respond: false };
  return { route: 'human', respond: false };
}

// ── Submit handling ──────────────────────────────────────────────────────────

/** The slice of `SubmitEvent` this needs; `agentInvoked` and `respondWith` are Chrome's declarative-WebMCP additions. */
export interface SubmitEventLike {
  preventDefault(): void;
  agentInvoked?: boolean;
  respondWith?: (answer: Promise<unknown>) => void;
}

export interface HandleSubmitParams {
  /**
   * The `<form>` being submitted. When it matches `:tool-form-active` (Chrome's own "an agent is driving this
   * form" state) the submit is treated as agent-touched even if no `toolactivated` event reached the page.
   */
  formEl?: ToolFormLike;
  /** React's `e.nativeEvent`: the synthetic event does not carry `agentInvoked` or `respondWith`. */
  nativeEvent: SubmitEventLike;
  classification: FormClass;
  agentTouched: boolean;
  toolName?: string;
  getArgs: () => Record<string, unknown>;
  callServerTool: (name: string, args: Record<string, unknown>, opts: { transport: 'declarative'; agentCall: boolean }) => Promise<unknown>;
  /** After the server answered an agent's call: the page applies it (filters, forecast) and may replace the answer. */
  afterServer?: (args: Record<string, unknown>, serverResult: unknown) => unknown | Promise<unknown>;
  /**
   * The server authorized the agent's call (a card was approved, or the policy allowed it). Runs BEFORE `afterServer`, so
   * whatever the page held back while the card was open (see `AgentValueGuard`) is released first.
   */
  onAuthorized?: (args: Record<string, unknown>, serverResult: unknown) => void;
  /**
   * The server did NOT authorize it: a rejected, expired, stale or cancelled card, or a refusal (the `{ error }` result,
   * or a rejection turned into one). The page puts the human's values back.
   */
  onUnauthorized?: (reason: unknown) => void;
  /**
   * A PERSON's save of this form is in flight right now. An `agentInvoked` submit that arrives meanwhile is refused with a
   * `busy` result and creates no server operation: the form's fields are locked for the person's save (Chrome's agent fill
   * was dropped by that lock), so the agent's submit would send the PERSON's values under the AGENT's call.
   */
  humanBusy?: boolean;
  /** The page's existing human handler (REST), run only on the `human` route. */
  onHumanSubmit?: (args: Record<string, unknown>) => void | Promise<void>;
  /** The outcome of an agent-touched human submit, shown inline. */
  onOutcome?: (outcome: unknown) => void;
  onBlocked?: (message: string) => void;
}

export interface HandleSubmitResult {
  /** `busy`: an agent's submit was refused because a person's save is in flight (no server call was made). */
  route: SubmitRoute['route'] | 'busy';
  /** Resolves when the work started by this submit has finished (never rejects). Tests await it. */
  settled: Promise<void>;
}

/**
 * An Ask card (or a card for a change) that did not end in an approval comes back from the bridge as a RESOLVED
 * `{ outcome, operationId }` object, not a rejection. A page or read tool must treat that as "the human said no":
 * the page does nothing and the agent is told the outcome. `committed` is the approved case; a read that was
 * approved returns its data, and a page tool the policy allows returns `{ authorized: true }`.
 */
export function isUnauthorizedOutcome(result: unknown): boolean {
  if (result === null || typeof result !== 'object') return false;
  // A refusal comes back as a normal `{ error: { code, message } }` result (Chrome hides thrown text): nothing was authorized.
  if (isErrorResult(result)) return true;
  const r = result as { outcome?: unknown; operationId?: unknown };
  return typeof r.outcome === 'string' && typeof r.operationId === 'string' && r.outcome !== 'committed';
}

/** What `onAuthorized` / `afterServer` receive as the server answer when a PERSON submitted an agent-filled read or page form. */
export const HUMAN_AUTHORIZED = Object.freeze({ authorized: true, by: 'human' });

/** A read or page form never changes data, so a human submit of it can adopt the agent's (possibly edited) values. */
function releasesGuardOnHumanSubmit(c: FormClass): boolean {
  return c === 'read' || c === 'page';
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The slice of `HTMLFormElement` the active-state check needs. */
export interface ToolFormLike {
  matches(selector: string): boolean;
}

/**
 * Whether the browser itself says an agent is driving this form right now (`:tool-form-active`). A second,
 * independent signal next to the `toolactivated` event, so the T21 control does not hang on one event name or
 * target. A browser that does not know the selector throws from `matches`: that reads as "not active" (the
 * tracker flag still applies), never as an error.
 */
export function isToolFormActive(formEl: ToolFormLike | undefined): boolean {
  if (!formEl || typeof formEl.matches !== 'function') return false;
  try {
    return formEl.matches(':tool-form-active') === true;
  } catch {
    return false;
  }
}

/** What an agent is told when it submits a form while a person's save of it is in flight. A RESULT, like every refusal. */
export const BUSY_MESSAGE = 'The person is saving this form; try again in a moment.';
export function busyResult(): { error: { code: 'busy'; message: string } } {
  return { error: { code: 'busy', message: BUSY_MESSAGE } };
}

export function handleDeclarativeSubmit(params: HandleSubmitParams): HandleSubmitResult {
  const { nativeEvent: ev } = params;
  const agentTouched = params.agentTouched || isToolFormActive(params.formEl);
  const decision = routeSubmit({ agentInvoked: ev.agentInvoked, agentTouched, classification: params.classification });

  // preventDefault first, always: respondWith needs a prevented event, and a human submit must not navigate.
  ev.preventDefault();

  if (decision.route === 'blocked') {
    params.onBlocked?.(decision.message ?? PROPOSAL_BLOCKED_TEXT);
    return { route: 'blocked', settled: Promise.resolve() };
  }

  if (decision.route === 'human') {
    const pending: unknown[] = [];
    const attempt = (fn: () => unknown) => {
      try {
        pending.push(fn());
      } catch {
        // A handler that throws is the page's problem; the submit still settles.
      }
    };
    let args: Record<string, unknown> | undefined;
    attempt(() => {
      args = params.getArgs();
    });
    // A person submitting a read or page form an agent filled is an explicit human decision about those values: the
    // page applies what is in the form NOW (the person may have edited it) and the hold on the agent's values lifts, so
    // no later cancel or reset has an unreleased guard to discard (G1). Nothing a server never authorized is kept
    // otherwise: this is the person's own act, not the agent's.
    if (agentTouched && releasesGuardOnHumanSubmit(params.classification)) {
      const applied = args ?? {};
      attempt(() => params.onAuthorized?.(applied, HUMAN_AUTHORIZED));
      attempt(() => params.afterServer?.(applied, HUMAN_AUTHORIZED));
    }
    if (args) {
      const handlerArgs = args;
      attempt(() => params.onHumanSubmit?.(handlerArgs));
    }
    return { route: 'human', settled: Promise.all(pending.map((p) => Promise.resolve(p).catch(() => undefined))).then(() => undefined) };
  }

  // An agent's submit while a person's save is in flight: no operation, the person's values and save are left alone.
  if (decision.respond && params.humanBusy === true) {
    const answer = Promise.resolve(busyResult());
    if (typeof ev.respondWith === 'function') ev.respondWith(answer);
    return { route: 'busy', settled: answer.then(() => undefined) };
  }

  // operation | call: exactly one server call, the same one an imperative tool makes.
  const name = params.toolName ?? '';
  let args: Record<string, unknown>;
  let serverAnswer: Promise<unknown>;
  try {
    args = params.getArgs();
    const serverCall = params.callServerTool(name, args, { transport: 'declarative', agentCall: decision.respond });
    const afterServer = params.afterServer;
    // The page acts only on an authorized call: a rejected, expired, stale or unknown card passes straight through.
    serverAnswer = serverCall.then(
      (result) => {
        if (isUnauthorizedOutcome(result)) {
          params.onUnauthorized?.(result);
          return result;
        }
        params.onAuthorized?.(args, result);
        return afterServer ? afterServer(args, result) : result;
      },
      (err) => {
        // A refusal told to the page too: the agent's values were not authorized.
        if (!isAbortError(err)) params.onUnauthorized?.(errorResult(err));
        throw err;
      }
    );
  } catch (err) {
    params.onUnauthorized?.(errorResult(err));
    serverAnswer = Promise.reject(err);
  }

  if (decision.respond) {
    // Chrome hides the text of a thrown error behind a generic one, so a refusal is handed to the agent as an `{ error }`
    // RESULT. Only an abort (the agent gave up) still rejects.
    const answer = serverAnswer.catch((err) => {
      if (isAbortError(err)) throw err;
      return errorResult(err);
    });
    if (typeof ev.respondWith === 'function') ev.respondWith(answer);
    // Either way the promise must not become an unhandled rejection on the page; the agent sees it through respondWith.
    return { route: decision.route, settled: answer.then(() => undefined, () => undefined) };
  }

  // An agent-touched form submitted by a human click: the same card, and the outcome shown inline.
  const settled = serverAnswer.then(
    (outcome) => params.onOutcome?.(outcome),
    (err) => params.onOutcome?.({ outcome: 'error', message: errorMessage(err) })
  );
  return { route: decision.route, settled };
}

// ── Agent-touched flag and remount key ───────────────────────────────────────

export type TouchedEvent =
  | { type: 'toolactivated'; toolName?: string }
  | { type: 'toolcancel'; toolName?: string }
  | { type: 'reset' }
  | { type: 'submitted' }
  /**
   * An agent's page tool (not a form tool) chose what a mutating form will act on, e.g. `open_review_item`
   * pre-selecting the review. The form is then agent-touched until it is submitted or reset (T21).
   */
  | { type: 'prefilled' }
  /**
   * The browser's agent wrote a field of THIS form (see `isBrowserAgentFill`). In Chrome 154 the fill comes BEFORE
   * `toolactivated`, so this is the first moment the page can snapshot the human's values and hold the agent's.
   */
  | { type: 'agentfill' }
  /** An `agentInvoked` submit of THIS form. Chrome 154 dispatches it before `toolactivated`. */
  | { type: 'agentsubmit' };

/** What `isBrowserAgentFill` needs from an `input` event. */
export interface FillEventFacts {
  /** `event.isTrusted`: script-dispatched events are never the browser's agent. */
  isTrusted: boolean;
  /** `event instanceof InputEvent`: typing, pasting and deleting are InputEvents. */
  isInputEvent: boolean;
  /** The field is `document.activeElement`: a person's spinner click, arrow key or wheel acts on the focused field. */
  targetFocused: boolean;
}

/**
 * Whether an `input` event is Chrome writing an agent's value into a form field (observed live in Chrome 154: a trusted
 * plain `Event`, not an `InputEvent`, on a field that does not have focus, dispatched before `toolactivated`). A
 * person's edits are InputEvents or act on the focused field, so they never match.
 */
export function isBrowserAgentFill(facts: FillEventFacts): boolean {
  return facts.isTrusted && !facts.isInputEvent && !facts.targetFocused;
}

/**
 * Whether a `toolactivated` event marks the form for `toolName` as agent-touched. Fail closed: an event whose
 * `toolName` is missing, not a string or not one of the declarative form tools cannot be attributed to a form, so
 * it marks EVERY mounted mutating form (a stray banner is cheap; a human REST write of agent-filled values is not).
 * Read and page forms never change data, so an unattributable event leaves them alone.
 */
export function activatesTool(event: TouchedEvent, toolName: string): boolean {
  // A page-tool prefill addresses one form directly; only a form that changes data needs the flag.
  if (event.type === 'prefilled') return DECLARATIVE_FORMS[toolName]?.classification === 'mutating';
  // Seen on this form's own fields or submit: always this form.
  if (event.type === 'agentfill' || event.type === 'agentsubmit') return true;
  if (event.type !== 'toolactivated') return false;
  const named = event.toolName;
  const recognized = typeof named === 'string' && Object.prototype.hasOwnProperty.call(DECLARATIVE_FORMS, named);
  if (recognized) return named === toolName;
  return DECLARATIVE_FORMS[toolName]?.classification === 'mutating';
}

/**
 * `toolactivated` for THIS tool (or an unattributable one, see `activatesTool`) sets the flag; `toolcancel` for it,
 * a form reset or a completed submit clears it. An anonymous `toolcancel` clears nothing.
 */
export function nextAgentTouched(prev: boolean, event: TouchedEvent, toolName: string): boolean {
  switch (event.type) {
    case 'toolactivated':
    case 'prefilled':
    case 'agentfill':
    case 'agentsubmit':
      return activatesTool(event, toolName) ? true : prev;
    case 'toolcancel':
      return event.toolName === toolName ? false : prev;
    case 'reset':
    case 'submitted':
      return false;
  }
}

/**
 * The agent-touched flag with the two rules a bare reducer cannot hold:
 *  - a `submitted` event from a submit that started BEFORE the latest activation is ignored (a long-pending
 *    earlier submit settling must not clear a newer agent fill), via a generation counter;
 *  - every time the flag drops from set to clear, `cleared` is true so the form can also reset the values the
 *    agent filled in (otherwise the next plain click would send them down the human path with no card, T21).
 */
export class AgentTouchTracker {
  touched = false;
  private generation = 0;

  constructor(readonly toolName: string) {}

  /** Apply an event; returns whether the agent's values must now be cleared from the form. */
  apply(event: TouchedEvent): { touched: boolean; cleared: boolean } {
    const prev = this.touched;
    if (activatesTool(event, this.toolName)) this.generation += 1;
    this.touched = nextAgentTouched(prev, event, this.toolName);
    return { touched: this.touched, cleared: prev && !this.touched };
  }

  /** Call when a submit starts; pass the token to `settle` when it ends. */
  beginSubmit(): number {
    return this.generation;
  }

  /** A submit ended. Ignored when a newer activation happened since it started. */
  settle(token: number): { touched: boolean; cleared: boolean } {
    if (token !== this.generation) return { touched: this.touched, cleared: false };
    return this.apply({ type: 'submitted' });
  }
}

// ── Agent values held until the server authorizes them (L1) ──────────────────

/**
 * Whether an agent's form values must stay out of the page (no filters applied, no projection recomputed) until the
 * server outcome authorizes them. Ask means a card the human has not answered yet. A policy the page does not know
 * (an older server) is treated as Ask: holding back is the safe direction.
 */
export function shouldHoldAgentValues(policy: 'allow' | 'ask' | undefined): boolean {
  return policy !== 'allow';
}

/**
 * The bookkeeping that keeps an agent's form values from taking effect before the server says so:
 *
 *  - `activate` (`toolactivated`): snapshot the HUMAN's values once, and hold the agent's values when the policy is Ask;
 *  - `authorize` (the server authorized the call): the snapshot is dropped, the hold lifts, the values stay;
 *  - `discard` (rejected, expired, stale, cancelled, forbidden, `toolcancel`, reset): hands back the snapshot to restore.
 *
 * A generation counter makes a long-pending EARLIER submit that settles after a newer activation a no-op, so it can
 * neither release nor wipe the newer fill. Generic: every read and page form uses it through `useDeclarativeTool`.
 */
export class AgentValueGuard<S = unknown> {
  private snapshot: { value: S } | null = null;
  private gen = 0;
  held = false;

  get generation(): number {
    return this.gen;
  }

  /** An agent activated the form and no outcome has settled its values yet. */
  get active(): boolean {
    return this.snapshot !== null;
  }

  /** Call when a submit starts; pass the token to `authorize` / `discard` when it ends. */
  beginSubmit(): number {
    return this.gen;
  }

  activate(policy: 'allow' | 'ask' | undefined, take: () => S): { held: boolean } {
    this.gen += 1;
    // A repeated activation (the agent fills the form again) keeps the first snapshot: that is the human's.
    if (this.snapshot === null) this.snapshot = { value: take() };
    this.held = shouldHoldAgentValues(policy);
    return { held: this.held };
  }

  authorize(token: number): { held: boolean } {
    if (token !== this.gen) return { held: this.held };
    this.snapshot = null;
    this.held = false;
    return { held: false };
  }

  discard(token: number): { restore: { value: S } | null } {
    if (token !== this.gen) return { restore: null };
    const restore = this.snapshot;
    this.snapshot = null;
    this.held = false;
    return { restore };
  }
}

/**
 * One form's agent-touched flag and value guard, kept consistent: `tracker.touched === false` implies
 * `guard.active === false`, after ANY sequence of events. The tracker flag can drop through a path that never reaches the
 * guard (a human-route submit settling, a stale token, a reset while not live); whenever it does and the guard is
 * still active, the agent's unauthorized values are discarded (the human's snapshot is handed back to restore), so a
 * guard is never left holding with nothing left that could release it.
 */
export class AgentFormSession<S = unknown> {
  readonly tracker: AgentTouchTracker;
  readonly guard = new AgentValueGuard<S>();
  /**
   * The session was activated early (an agent fill or agentInvoked submit, Chrome 154's order) and the `toolactivated`
   * that belongs to the same call has not arrived yet: it is absorbed instead of starting a new session, which would
   * bump the generation and make the running submit's tokens stale.
   */
  private echoPending = false;
  /**
   * While a person's save was in flight (`humanBusy`), the page's field lock dropped Chrome's agent fill and the session
   * ignored the activation signals: the form holds the PERSON's values, so nothing may be snapshotted, held or restored.
   *  - `fillDropped`: an agent fill was dropped; an agent submit of that call would send values the agent never set;
   *  - `activationIgnored`: this call's `toolactivated` (explainer order) was already seen and ignored;
   *  - `echoSkip`: an agent submit was refused before its `toolactivated` (Chrome 154 order); that one is to be ignored.
   */
  private fillDropped = false;
  private activationIgnored = false;
  private echoSkip = false;
  /**
   * What the browser's agent wrote into each field (name -> text), taken from the fill events themselves. The form's DOM is
   * NOT a reliable record of what the agent submitted: the hold is published to React state in the capture phase of the
   * very `input` event that carries the fill, React flushes it before the field's own `onChange`, and the re-render puts the
   * HUMAN's text back into the controlled field (the `onChange` then sees no change and never fires). An `agentInvoked`
   * submit therefore builds its args from this record (`buildFormArgs`), never from the DOM after a hold (V1).
   */
  private readonly fills = new Map<string, string>();

  constructor(toolName: string) {
    this.tracker = new AgentTouchTracker(toolName);
  }

  /**
   * Record one field the browser's agent filled (call after `apply({ type: 'agentfill' })`). Only while an agent call is
   * active: a fill the session ignored (a person's save was in flight) is never recorded.
   */
  noteFill(name: string, value: string): void {
    if (!this.guard.active || name === '') return;
    this.fills.set(name, value);
  }

  /** A person changed this field after the agent filled it: that value is theirs now, not the agent's. */
  noteHumanEdit(name: string): void {
    this.fills.delete(name);
  }

  /** The agent's recorded values for the call in progress. Empty once the call's values were authorized, discarded or cancelled. */
  agentFills(): ReadonlyMap<string, string> {
    return this.guard.active ? this.fills : NO_FILLS;
  }

  /** A new agent call begins: nothing of an earlier one carries over. */
  private beginCall(policy: 'allow' | 'ask' | undefined, take: () => S): void {
    if (!this.guard.active) this.fills.clear();
    this.guard.activate(policy, take);
  }

  /**
   * An `agentInvoked` submit must be refused (answered `busy`, no operation): a person's save is in flight, or an agent fill
   * was dropped because one was. Never while an agent's own activation is already in effect.
   */
  shouldRefuseAgentSubmit(humanBusy: boolean): boolean {
    return !this.guard.active && (humanBusy || this.fillDropped);
  }

  /** Call when such a submit was refused: the same call's late `toolactivated` must not activate the session. */
  refuseAgentSubmit(): void {
    if (this.activationIgnored) this.activationIgnored = false;
    else this.echoSkip = true;
    this.fillDropped = false;
  }

  /**
   * Apply a touch event. The first sign of an agent call on this form (an `agentfill`, an `agentsubmit`, or a
   * `toolactivated`) snapshots the human's values (`take`) and sets the hold BEFORE the flag flips. Chrome 154 fills the
   * fields and submits before `toolactivated`, so the page reports the fill itself; the late `toolactivated` of that same
   * call is then absorbed (`echoPending`).
   */
  apply(event: TouchedEvent, ctx: { policy?: 'allow' | 'ask'; take?: () => S; humanBusy?: boolean } = {}): { touched: boolean; cleared: boolean; restore: { value: S } | null } {
    const idle = { touched: this.tracker.touched, cleared: false, restore: null };
    if (event.type === 'toolcancel' || event.type === 'reset') {
      this.fillDropped = false;
      this.activationIgnored = false;
      this.echoSkip = false;
    }
    // A person's save is in flight: the form holds the person's values and an agent's signals change nothing about them.
    if (ctx.humanBusy === true && !this.guard.active) {
      if (event.type === 'agentfill') {
        this.fillDropped = true;
        return idle;
      }
      if (event.type === 'agentsubmit') return idle;
      if (event.type === 'toolactivated' && activatesTool(event, this.tracker.toolName)) {
        this.activationIgnored = true;
        return idle;
      }
    }
    // The late `toolactivated` of a submit that was refused while busy: absorbed, whatever the busy state is by now.
    if (event.type === 'toolactivated' && this.echoSkip && activatesTool(event, this.tracker.toolName)) {
      this.echoSkip = false;
      return idle;
    }
    if (event.type === 'agentfill') {
      // A new call began in Chrome 154's order: its own `toolactivated` follows, so a refused call's leftover echo is stale.
      this.fillDropped = false;
      this.echoSkip = false;
    }
    if (event.type === 'agentfill' || event.type === 'agentsubmit') {
      // Already activated (a previous field of this fill, or toolactivated first in the explainer's order): same call,
      // the first snapshot (the human's) stays.
      if (this.guard.active) return { touched: this.tracker.touched, cleared: false, restore: null };
      this.beginCall(ctx.policy, ctx.take ?? (() => undefined as S));
      this.echoPending = true;
      const early = this.tracker.apply(event);
      return { ...early, restore: this.enforce() };
    }
    if (event.type === 'toolactivated' && activatesTool(event, this.tracker.toolName) && this.echoPending) {
      this.echoPending = false;
      return { touched: this.tracker.touched, cleared: false, restore: null };
    }
    if (event.type === 'toolactivated' && activatesTool(event, this.tracker.toolName)) {
      this.beginCall(ctx.policy, ctx.take ?? (() => undefined as S));
    }
    const next = this.tracker.apply(event);
    return { ...next, restore: this.enforce() };
  }

  /** A submit ended (see `AgentTouchTracker.settle`). */
  settle(token: number): { touched: boolean; cleared: boolean; restore: { value: S } | null } {
    const next = this.tracker.settle(token);
    return { ...next, restore: this.enforce() };
  }

  private enforce(): { value: S } | null {
    if (this.tracker.touched || !this.guard.active) return null;
    return this.guard.discard(this.guard.generation).restore;
  }
}

/**
 * The hold as a live flag: `.current` reads the guard itself, so it is true from the instant `AgentFormSession.apply`
 * handled `toolactivated` (inside the window listener) and false the instant the hold lifts, with no render in between.
 * An input handler that decides "draft or apply" must read this, not the render-time `effectsHeld`, which still says
 * `false` when the agent's first `input` events arrive right after the event.
 */
export function liveHeldFlag(guard: { readonly held: boolean }): { readonly current: boolean } {
  return {
    get current() {
      return guard.held;
    },
  };
}

// ── The agent's submitted args (V1) ──────────────────────────────────────────

const NO_FILLS: ReadonlyMap<string, string> = new Map();

/** The slice of a form control `readFill` reads. */
export interface FillTargetLike {
  name?: unknown;
  value?: unknown;
  type?: unknown;
}

/**
 * The field and text of one browser-agent fill, or null when it cannot be recorded by name and text: no name, a value that
 * is not text, or a checkable / file control (their submitted value is not the control's `value`; the DOM stays the source).
 */
export function readFill(target: FillTargetLike): { name: string; value: string } | null {
  if (typeof target.name !== 'string' || target.name === '' || typeof target.value !== 'string') return null;
  if (target.type === 'checkbox' || target.type === 'radio' || target.type === 'file') return null;
  return { name: target.name, value: target.value };
}

/** The form's entries with the agent's recorded values on top: the named entry (and duplicates of it) replaced, a missing one appended. */
export function overlayAgentFills(entries: Iterable<[string, unknown]>, fills: ReadonlyMap<string, string>): Array<[string, unknown]> {
  const list = [...entries];
  if (fills.size === 0) return list;
  const out: Array<[string, unknown]> = [];
  const placed = new Set<string>();
  for (const [key, value] of list) {
    if (!fills.has(key)) {
      out.push([key, value]);
    } else if (!placed.has(key)) {
      placed.add(key);
      out.push([key, fills.get(key) as string]);
    }
  }
  for (const [key, value] of fills) if (!placed.has(key)) out.push([key, value]);
  return out;
}

/**
 * The args of a submit: the form's entries (with the agent's recorded fills on top, for an agent's submit) typed by the
 * tool's schema. Without a schema only text entries pass through.
 */
export function buildFormArgs(input: { entries: Iterable<[string, unknown]>; schema: unknown; fills: ReadonlyMap<string, string> }): Record<string, unknown> {
  const entries = overlayAgentFills(input.entries, input.fills);
  return input.schema ? formToArgs(entries, input.schema) : Object.fromEntries(entries.filter(([, v]) => typeof v === 'string'));
}

// ── Locking a field without changing the schema ──────────────────────────────

/** The CSS class that dims a locked field's wrapper and blocks the pointer (`styles/app.css`). A class, so Chrome never reads it. */
export const FIELD_LOCK_CLASS = 'tool-field-locked';

export interface FieldLock {
  /** For the field's wrapper (its `<label>`): `FIELD_LOCK_CLASS` while locked, else empty. */
  wrapperClass: string;
  /** Spread onto the field: `aria-disabled="true"` while locked. Never `disabled` or `readOnly`. */
  fieldProps: { 'aria-disabled'?: 'true' };
  /** Wrap a field's change handler: while locked a human's change is ignored (the controlled value snaps back). */
  guard<A extends unknown[]>(handler: (...args: A) => void): (...args: A) => void;
}

/**
 * How a field of a declarative form is locked while the form is busy (a person's save in flight). Chrome derives the
 * tool's schema from the form DOM and cancels a running call when it changes ("Tool execution cancelled, since tool
 * definition was updated"); `disabled` and `readonly` fields are OMITTED from that schema, so toggling either mid-call
 * changes the definition. This lock is invisible to the schema: an ARIA state, a class, and a handler that ignores changes.
 */
export function fieldLock(locked: boolean): FieldLock {
  return {
    wrapperClass: locked ? FIELD_LOCK_CLASS : '',
    fieldProps: locked ? { 'aria-disabled': 'true' } : {},
    guard: (handler) => (...args) => {
      if (!locked) handler(...args);
    },
  };
}

// ── Showing a live tool's info ───────────────────────────────────────────────

/**
 * The info a form advertises. While an agent call is in flight a CHANGE to a still-live tool waits: rewriting
 * `toolname` / `tooldescription` / `toolparamdescription` makes Chrome re-register the form and cancel the call
 * ('Tool execution cancelled, since tool definition was updated'). A tool that went away (revoked, kill switch, policy
 * Off) is never deferred: revocation applies at once.
 */
export function resolveShownInfo<T>(shown: T | undefined, next: T | undefined, busy: boolean): T | undefined {
  if (next === undefined) return undefined;
  if (shown === undefined) return next;
  return busy ? shown : next;
}

export interface FormKeyState {
  key: number;
  live: boolean;
}

/**
 * The React `key` of a declarative form. It changes when the tool goes from live to not live, so React replaces
 * the element and the browser unregisters the form tool whether or not it reacts to attributes being removed.
 */
export function nextFormKey(prev: FormKeyState | undefined, live: boolean): FormKeyState {
  if (!prev) return { key: 0, live };
  return { key: prev.live && !live ? prev.key + 1 : prev.key, live };
}

// ── Attributes a live form carries ───────────────────────────────────────────

export interface FormToolInfo {
  name: string;
  description: string;
  classification: string;
  autosubmit: boolean;
  /** The user's effective policy; absent (an older server) is treated as Ask. */
  policy?: 'allow' | 'ask';
  inputSchema: unknown;
}

const PARAM_DESCRIPTION_MAX = 150;

/** `toolname`, `tooldescription` and (read/page tools only) `toolautosubmit`. Empty unless the tool is live. */
export function declarativeAttrs(info: FormToolInfo | undefined): Record<string, string> {
  if (!info) return {};
  const attrs: Record<string, string> = { toolname: info.name, tooldescription: info.description };
  // Never on a form that changes data, whatever the metadata says.
  if (info.autosubmit && (info.classification === 'read' || info.classification === 'page')) attrs.toolautosubmit = '';
  return attrs;
}

/** `toolparamdescription` for one field, from the catalog's JSON Schema. Empty when not live or undescribed. */
export function paramAttrs(info: FormToolInfo | undefined, field: string): Record<string, string> {
  if (!info) return {};
  const props = (info.inputSchema as { properties?: Record<string, { description?: unknown }> } | null | undefined)?.properties;
  const description = props?.[field]?.description;
  if (typeof description !== 'string' || description.length === 0) return {};
  return { toolparamdescription: description.slice(0, PARAM_DESCRIPTION_MAX) };
}

// ── FormData -> args ─────────────────────────────────────────────────────────

interface JsonSchemaProp {
  type?: string;
}

/**
 * Convert a form's entries to the typed args the strict server schema expects. Empty strings are dropped (an
 * empty field is not a value); a value that does not parse as its declared type is passed through as text so the
 * server's own message ("must be a number") reaches the agent. Keys the schema does not know are ignored.
 */
export function formToArgs(entries: Iterable<[string, unknown]>, schema: unknown): Record<string, unknown> {
  const props = (schema as { properties?: Record<string, JsonSchemaProp> } | null | undefined)?.properties ?? {};
  const args: Record<string, unknown> = {};
  for (const [key, raw] of entries) {
    if (typeof raw !== 'string') continue;
    const prop = props[key];
    if (!prop) continue;
    const text = prop.type === 'string' || prop.type === undefined ? raw : raw.trim();
    if (text === '') continue;
    switch (prop.type) {
      case 'integer': {
        const n = Number(text);
        args[key] = Number.isFinite(n) && Number.isInteger(n) ? n : text;
        break;
      }
      case 'number': {
        const n = Number(text);
        args[key] = Number.isFinite(n) ? n : text;
        break;
      }
      case 'boolean':
        args[key] = !(text === 'false' || text === '0' || text === 'off');
        break;
      default:
        args[key] = text;
    }
  }
  return args;
}

// ── Option builders ──────────────────────────────────────────────────────────

export interface SelectOption {
  value: string;
  label: string;
}

/** The same classes as `HIDDEN_SINGLE_LINE` in src/mcp/output.ts (a test pins the two together). */
const HIDDEN_CHARS = /[\u0000-\u001F\u007F-\u009F\u00ad\u061c\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2069\ufeff]/;

/**
 * How a category appears in an `<option>` label: system names as they are; a custom one (which a prompt-injected
 * chat agent can create) only when it is short and plain, otherwise `#<id> (custom)`.
 */
export function categoryOptionLabel(cat: { id: number; name: string; is_system: number | boolean }): string {
  if (cat.is_system) return cat.name;
  if (!HIDDEN_CHARS.test(cat.name) && SAFE_CUSTOM_CATEGORY.test(cat.name)) return cat.name;
  return `#${cat.id} (custom)`;
}

/** `<option value="<id>">` for every category, labelled by `categoryOptionLabel`. The tool takes `category_id`. */
export function buildCategoryOptions(rows: Array<{ id: number; name: string; is_system: number | boolean }>): SelectOption[] {
  return rows.map((row) => ({ value: String(row.id), label: categoryOptionLabel(row) }));
}

function formatMoney(n: number): string {
  const abs = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${n < 0 ? '-' : ''}$${abs}`;
}

const PLAIN_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * `#<id> · YYYY-MM-DD · -$12.34`. Built only from the id, the date and the amount: a merchant or description is
 * bank text and never goes into a label an agent reads. A row whose date is not a plain date is left out.
 */
export function buildReviewOptions(rows: Array<{ review_id: number; date: string; amount: number }>): SelectOption[] {
  const out: SelectOption[] = [];
  for (const row of rows) {
    if (!Number.isInteger(row.review_id) || !PLAIN_DATE.test(row.date) || !Number.isFinite(row.amount)) continue;
    out.push({ value: String(row.review_id), label: `#${row.review_id} · ${row.date} · ${formatMoney(row.amount)}` });
  }
  return out;
}

/** `#<id> · <type> · $target` (or `N%`, or `no target`). Never the goal's title or notes. */
export function buildGoalOptions(
  rows: Array<{ id: number; goal_type: string; target_amount: number | null; target_percent?: number | null }>
): SelectOption[] {
  return rows.map((row) => {
    const target =
      row.target_amount !== null && row.target_amount !== undefined
        ? formatMoney(row.target_amount)
        : row.target_percent !== null && row.target_percent !== undefined
          ? `${row.target_percent}%`
          : 'no target';
    const type = row.goal_type === 'financial' || row.goal_type === 'behavioral' ? row.goal_type : 'goal';
    return { value: String(row.id), label: `#${row.id} · ${type} · ${target}` };
  });
}
