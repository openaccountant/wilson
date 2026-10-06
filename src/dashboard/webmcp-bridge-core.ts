/**
 * Decision logic of the in-page WebMCP bridge, kept DOM-free (its one import is the import-free tool-error module)
 * so Bun.build can bundle it into /webmcp-bridge.js and root tests can import
 * it without a browser.
 *
 * Three jobs:
 *  - `reconcile`: given the tool names the server says this tab may use and the
 *    names currently registered with `document.modelContext`, which to
 *    register and which to abort;
 *  - `registerLiveTools`: do that reconcile against `registerTool`, for the
 *    tools the server marks `imperative` only. A `declarative` tool is exposed by
 *    its form and never registered here, so no name is ever registered both ways.
 *    A tab's tools (the server's `surface`) are registered only while that tab
 *    shows, and a page tool only while React has a handler mounted for it, so
 *    switching tabs aborts one tab's registrations and adds the next tab's in a
 *    single pass (`desiredTools`, `createReconcileScheduler`);
 *  - `executePageTool`: what a registered page tool does when called: the server
 *    authorizes it, then the tab's own handler does the visible work and answers;
 *  - `callServerTool`: send one call to the server's single tool endpoint
 *    (`POST /api/mcp/call`) and turn the answer into what an agent's
 *    `execute` returns: data for a read, or the polled outcome of a change that
 *    waits for the user's approval card.
 *
 * This file never names a tool and never decides what is a read and what is a
 * change: the server classifies every call and says so in `kind`.
 */

import { ToolCallError, errorResult, isAbortError, runToolSafely, toolErrorFromResponse } from './webmcp-tool-error.js';

/** Header carrying the tab's session generation (a UUID v4). Mirrors src/mcp/schemas.ts. */
export const SESSION_HEADER = 'X-Wilson-Agent-Session';

export interface ReconcileResult {
  toRegister: string[];
  toAbort: string[];
}

/** Tools to register (wanted, not registered) and to abort (registered, no longer wanted). Order follows the inputs. */
export function reconcile(desired: Iterable<string>, registered: Iterable<string>): ReconcileResult {
  const want = new Set(desired);
  const have = new Set(registered);
  return {
    toRegister: [...want].filter((name) => !have.has(name)),
    toAbort: [...have].filter((name) => !want.has(name)),
  };
}

/** One row of the server's `/api/mcp/tools`: what this tab may use right now. */
export interface LiveToolDescriptor {
  name: string;
  description: string;
  inputSchema: unknown;
  annotations?: unknown;
  /** As the server classified it. The bridge never decides this. */
  classification: string;
  /** `imperative`: the bridge registers it. `declarative`: only its form exposes it. */
  exposure: 'imperative' | 'declarative';
  autosubmit: boolean;
  /** The user's effective policy for the tool (Off tools are never listed). Absent (an older server): treated as Ask by the forms. */
  policy?: 'allow' | 'ask';
  /** `global`, or the one tab the tool belongs to. Absent (an older server): global. */
  surface?: 'global' | { tab: string };
  /** For a tab tool: what to tell an agent that calls it while the tab is not showing. Written by the server. */
  openHint?: string;
  grantId: string;
}

/**
 * A change in any of this means the pages' forms must re-read the live set; order does not. The grant id is NOT in
 * it (a re-grant must not rewrite a form's tool attributes or re-register a tool); the policy is (Ask holds an agent's
 * form values back until the card is answered).
 */
export function liveToolsSignature(tools: LiveToolDescriptor[]): string {
  return JSON.stringify(
    [...tools]
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map((t) => [t.name, t.classification, t.exposure, t.autosubmit, t.policy ?? null, t.surface ?? 'global', t.description, t.inputSchema])
  );
}

export interface RegistrableTool {
  name: string;
  description: string;
  inputSchema: unknown;
  annotations?: unknown;
  execute: (args: Record<string, unknown>, options: { signal: AbortSignal }) => Promise<unknown>;
}

/** Where the tab is right now: which tab shows, and whether React has mounted a handler for a page tool. */
export interface RegistrationView {
  activeTab?: string;
  /** Without it no page tool is wanted: a page tool with nothing to run would only mislead the agent. */
  hasHandler?: (name: string) => boolean;
}

/**
 * The tools that should be registered right now: live (the server listed them, so granted, policy not Off, access
 * on) and `imperative`, on this surface (global, or the tab that shows), and, for a page tool, with a handler mounted.
 */
export function desiredTools(tools: LiveToolDescriptor[], view: RegistrationView): LiveToolDescriptor[] {
  return tools.filter((t) => {
    if (t.exposure !== 'imperative') return false;
    if (t.surface !== undefined && t.surface !== 'global' && t.surface.tab !== view.activeTab) return false;
    if (t.classification === 'page' && view.hasHandler?.(t.name) !== true) return false;
    return true;
  });
}

export interface RegisterLiveToolsDeps extends RegistrationView {
  tools: LiveToolDescriptor[];
  /** One AbortController per registered name: aborting it is the only way to unregister. Owned by the caller across syncs. */
  registered: Map<string, AbortController>;
  registerTool: (tool: RegistrableTool, options: { signal: AbortSignal }) => Promise<unknown>;
  makeExecute: (tool: LiveToolDescriptor) => RegistrableTool['execute'];
  /** How long one `registerTool` may take before it is given up on. Default `REGISTER_TIMEOUT_MS`. */
  registerTimeoutMs?: number;
  /**
   * Whether an agent call to `name` is running right now. Chrome cancels a running call when its tool is unregistered
   * ('Tool execution cancelled, since tool definition was updated'), so a tool that is still LIVE but only fell out of
   * view (another tab showing, a handler remounting) keeps its registration until the call settles. A tool the server no
   * longer lists (revoked, policy Off, kill switch) is always unregistered at once.
   */
  isBusy?: (name: string) => boolean;
}

export interface RegisterLiveToolsResult {
  /** Tools whose unregistration waits for a call in flight. The caller reconciles again when that call settles. */
  deferred: string[];
}

/** A `registerTool` that has not settled by now is treated as refused: one stuck call must not block later passes. */
export const REGISTER_TIMEOUT_MS = 2000;

/**
 * Make `registered` match `desiredTools`: abort what is no longer wanted (revoked, kill switch, another tab now
 * showing), register what is new. A tool whose registration is refused stays unregistered, so the next pass retries it.
 */
export async function registerLiveTools(deps: RegisterLiveToolsDeps): Promise<RegisterLiveToolsResult> {
  // One registration per NAME. The server lists a tool once per live grant, so a tab that granted the same tool twice
  // gets it twice. Registering both rows overwrote the first AbortController in `registered` with the second; the
  // browser refused the second (already registered), which aborted and dropped it, and the first registration was left
  // with no controller anywhere: nothing could unregister it again (kill switch, revoke, policy Off) until a reload.
  const byName = new Map<string, LiveToolDescriptor>();
  for (const t of desiredTools(deps.tools, deps)) if (!byName.has(t.name)) byName.set(t.name, t);
  const imperative = [...byName.values()];
  const { toRegister, toAbort } = reconcile(
    imperative.map((t) => t.name),
    deps.registered.keys()
  );
  const stillLive = new Set(deps.tools.filter((t) => t.exposure === 'imperative').map((t) => t.name));
  const deferred: string[] = [];
  for (const name of toAbort) {
    if (stillLive.has(name) && deps.isBusy?.(name)) {
      deferred.push(name);
      continue;
    }
    deps.registered.get(name)?.abort();
    deps.registered.delete(name);
  }
  const timeoutMs = deps.registerTimeoutMs ?? REGISTER_TIMEOUT_MS;
  // Distinct names, so the registrations can proceed together: a pass lasts at most one timeout however many hang.
  await Promise.all(
    imperative
      .filter((t) => toRegister.includes(t.name))
      .map(async (tool) => {
        const controller = new AbortController();
        deps.registered.set(tool.name, controller);
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            deps.registerTool(
              {
                name: tool.name,
                description: tool.description,
                inputSchema: tool.inputSchema,
                annotations: tool.annotations,
                execute: deps.makeExecute(tool),
              },
              { signal: controller.signal }
            ),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error('registerTool timed out')), timeoutMs);
            }),
          ]);
        } catch {
          // NotAllowedError (permissions policy), a registration that never settled, or similar: give up on it. Aborting
          // means that if the browser does finish it later, the tool is unregistered again. The next pass retries.
          controller.abort();
          if (deps.registered.get(tool.name) === controller) deps.registered.delete(tool.name);
        } finally {
          clearTimeout(timer);
        }
      })
  );
  return { deferred };
}

export interface ServerCallDeps {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  /** This tab's session generation. Sent as a header on every request, never in a URL or a body. */
  sessionGeneration: string;
  /** Dashboard auth header, if the user is logged in. */
  authHeaders?: () => Record<string, string>;
  /** Pause between polls. Resolves early when `signal` aborts. Injected by tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  pollIntervalMs?: number;
  /** How long to wait for the user to answer an approval card. */
  timeoutMs?: number;
  /**
   * The bridge's record of what each AGENT call created. A call that creates an operation attaches it to its own call
   * here until the outcome is delivered, so that when Chrome ends THAT call without telling the page (see `endChromeCall`)
   * the card is withdrawn instead of left behind. A person's own submit never registers anything here.
   */
  ledger?: OperationLedger;
}

// ── Orphaned operations (Chrome cancels a call without a signal) ─────────────

/**
 * One agent call (an imperative `execute`, a page tool, or a declarative form's `agentInvoked` submit). Its identity, not
 * its tool's name, decides which operations may be withdrawn: a person's card, or another call's card of the same tool,
 * is never touched.
 */
export interface AgentCall {
  readonly id: number;
  readonly tool: string;
}

/**
 * How Chrome can end an agent call, as the page can observe it:
 *  - `execute-rejected`: that call's `execute` promise ended in a rejection (an abort, or Chrome gave up on it);
 *  - `toolcancel`: Chrome's own cancel event, which names a TOOL. It ends the agent call of that tool that is in flight.
 *
 * Deliberately absent: a form that unmounts or stops being live, `toolchange` (named or not), and a `respondWith` that
 * ended. Chrome's `toolchange` carries no tool name, and the form events say nothing about which call they ended; a
 * cancel on any of them could withdraw a card that a person, or another call, is waiting on. An orphan left by those
 * causes is not cleaned up: it expires on its own (the operation window, 5 minutes), and the schema is kept stable
 * while a call runs so that nothing re-derives it in the first place.
 */
export type ChromeCallEnd = { type: 'execute-rejected'; call: AgentCall } | { type: 'toolcancel'; tool?: string };

/** What the cancel route answered for an operation: `{ outcome }`, where anything but `cancelled` means it had already resolved. */
export interface CancelAnswer {
  outcome?: string;
  reason?: string;
}

export interface OperationLedger {
  /** An agent call of `tool` started. */
  beginCall(tool: string): AgentCall;
  /** The call settled (answered, aborted or rejected). Forgets it and anything it still holds. Idempotent. */
  endCall(call: AgentCall): void;
  /**
   * `call` created the server operation `id` and is waiting on it. False when the call was already withdrawn (a `toolcancel`
   * arrived before its operation existed): the caller must cancel the operation at once.
   */
  attach(call: AgentCall, id: string): boolean;
  /** The operation's outcome reached the caller (or it was withdrawn): nothing is left to cancel. Idempotent. */
  release(id: string): void;
  /** The operation is attached to a call and neither released nor being withdrawn. */
  has(id: string): boolean;
  /** Operation ids `call` holds, in creation order. */
  opsOf(call: AgentCall): string[];
  /** Agent calls of `tool` in flight. */
  inFlight(tool: string): AgentCall[];
  /**
   * Chrome ended a call: the operation ids to cancel server-side. Each is marked as being withdrawn (and handed back once);
   * `resolveWithdrawal` records what the cancel route said.
   */
  cancelled(event: ChromeCallEnd): string[];
  /** What the cancel of `id` answered. Settles `withdrawal(id)`. */
  resolveWithdrawal(id: string, answer: CancelAnswer | undefined): void;
  /** Set once `cancelled` handed `id` back: resolves with the cancel route's answer (undefined: it could not be confirmed). */
  withdrawal(id: string): Promise<CancelAnswer | undefined> | undefined;
}

export function createOperationLedger(): OperationLedger {
  interface CallState {
    call: AgentCall;
    ops: string[];
    withdrawn: boolean;
  }
  interface OpState {
    call: CallState;
    withdrawal?: { promise: Promise<CancelAnswer | undefined>; resolve: (a: CancelAnswer | undefined) => void };
  }
  let nextId = 1;
  const calls = new Map<number, CallState>();
  const ops = new Map<string, OpState>();

  const withdraw = (state: CallState): string[] => {
    state.withdrawn = true;
    const ids: string[] = [];
    for (const id of state.ops) {
      const op = ops.get(id);
      if (!op || op.withdrawal) continue;
      let resolve!: (a: CancelAnswer | undefined) => void;
      const promise = new Promise<CancelAnswer | undefined>((r) => (resolve = r));
      op.withdrawal = { promise, resolve };
      ids.push(id);
    }
    return ids;
  };
  const inFlight = (tool: string) => [...calls.values()].filter((c) => c.call.tool === tool).map((c) => c.call);

  return {
    beginCall(tool) {
      const call: AgentCall = { id: nextId++, tool };
      calls.set(call.id, { call, ops: [], withdrawn: false });
      return call;
    },
    endCall(call) {
      const state = calls.get(call.id);
      if (!state) return;
      calls.delete(call.id);
      for (const id of state.ops) ops.delete(id);
    },
    attach(call, id) {
      const state = calls.get(call.id);
      if (!state) return false;
      if (state.withdrawn) return false;
      state.ops.push(id);
      ops.set(id, { call: state });
      return true;
    },
    release(id) {
      const op = ops.get(id);
      if (!op) return;
      ops.delete(id);
      op.call.ops = op.call.ops.filter((x) => x !== id);
    },
    has: (id) => {
      const op = ops.get(id);
      return op !== undefined && op.withdrawal === undefined;
    },
    opsOf: (call) => [...(calls.get(call.id)?.ops ?? [])],
    inFlight,
    cancelled(event) {
      if (event.type === 'execute-rejected') {
        const state = calls.get(event.call.id);
        return state ? withdraw(state) : [];
      }
      // `toolcancel` names a tool, not a call. Exactly one agent call of it in flight: that one ended. None: nothing of an
      // agent's is open (a person's card is never in the ledger). Several: it cannot be told which one, and withdrawing a
      // card another call is waiting on is worse than leaving one to expire, so nothing is withdrawn.
      if (event.tool === undefined) return [];
      const running = inFlight(event.tool);
      if (running.length !== 1) return [];
      return withdraw(calls.get(running[0].id) as CallState);
    },
    resolveWithdrawal(id, answer) {
      ops.get(id)?.withdrawal?.resolve(answer);
    },
    withdrawal: (id) => ops.get(id)?.withdrawal?.promise,
  };
}

/**
 * Chrome ended an agent call: cancel the server operations THAT call had open (the route an abort already uses), best
 * effort. Resolves with the ids it tried. Never throws: an offline tab or an operation that already resolved expires on
 * its own.
 */
export async function endChromeCall(deps: Pick<ServerCallDeps, 'fetch' | 'sessionGeneration' | 'authHeaders'>, ledger: OperationLedger, event: ChromeCallEnd): Promise<string[]> {
  const ids = ledger.cancelled(event);
  await Promise.all(
    ids.map(async (id) => {
      const answer = await cancelOperation(deps, id);
      ledger.resolveWithdrawal(id, answer);
    })
  );
  return ids;
}

/** The route's answer, or undefined when it could not be reached or said nothing usable. Never throws. */
async function cancelOperation(deps: Pick<ServerCallDeps, 'fetch' | 'sessionGeneration' | 'authHeaders'>, id: string): Promise<CancelAnswer | undefined> {
  try {
    const res = await deps.fetch(`/api/mcp/operations/${id}/cancel`, { method: 'POST', headers: requestHeaders(deps) });
    const body = (await readJson(res)) as { outcome?: unknown; reason?: unknown } | undefined;
    if (typeof body?.outcome !== 'string') return undefined;
    return { outcome: body.outcome, ...(typeof body.reason === 'string' ? { reason: body.reason } : {}) };
  } catch {
    // Offline or already resolved: the operation expires on its own.
    return undefined;
  }
}

function requestHeaders(deps: Pick<ServerCallDeps, 'sessionGeneration' | 'authHeaders'>): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    ...(deps.authHeaders?.() ?? {}),
    [SESSION_HEADER]: deps.sessionGeneration,
  };
}

export interface ServerCall {
  grantId: string;
  tool: string;
  args: Record<string, unknown>;
  /** Client-reported, recorded for audit only; the server never authorizes on it. */
  transport?: 'imperative' | 'declarative' | 'page';
  /**
   * The agent call this is (from `ledger.beginCall`). Absent for a person's own submit: an operation it creates is never
   * registered, so nothing here can withdraw it.
   */
  agentCall?: AgentCall;
}

interface WireOperation {
  id: string;
  status: string;
  /** `read` for a read the user is being asked to allow (policy Ask); absent for a change. */
  kind?: string;
  /** Sanitized post-commit result (the server's `?view=agent`); never raw row text. */
  result?: unknown;
  /** A committed read's data, delivered once to the tab that asked. */
  data?: unknown;
}

const DEFAULT_POLL_INTERVAL_MS = 800;
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

function abortError(): Error {
  const err = new Error('The operation was aborted.');
  err.name = 'AbortError';
  return err;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });
}

async function readJson(res: Response): Promise<any> {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}

/**
 * What the server's answer means for the caller. `page`: the call is authorized (directly, or once the user
 * allowed it) and the page may act, with the row the server read for it, if any. `value`: anything else, to be
 * handed back to the agent as it is (data, or an outcome such as rejected).
 */
export type ServerAnswer = { type: 'page'; pageData?: unknown } | { type: 'value'; value: unknown };

export interface AnswerOptions {
  /**
   * The tool is a page tool: a read the user allowed (policy Ask) is an authorization carrying the stored row,
   * not data to hand back. The bridge learns this from the server's own `classification`, never from a tool name.
   */
  pageMode?: boolean;
}

export async function callServerToolAnswer(deps: ServerCallDeps, call: ServerCall, signal?: AbortSignal, options: AnswerOptions = {}): Promise<ServerAnswer> {
  const headers = (): Record<string, string> => requestHeaders(deps);

  throwIfAborted(signal);
  const res = await deps.fetch('/api/mcp/call', {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ grantId: call.grantId, tool: call.tool, args: call.args, transport: call.transport ?? 'imperative' }),
    signal,
  });
  const body = await readJson(res);
  if (!res.ok) throw toolErrorFromResponse(res.status, body);

  if (body?.kind === 'read') return { type: 'value', value: body.data };
  // A page tool: the server authorized (and audited) the call; the page does the rest and answers the agent itself.
  if (body?.kind === 'page') return { type: 'page', pageData: body.pageData };
  if (body?.kind === 'operation' && body.operation?.id) {
    return waitForOperation(deps, headers, call.agentCall, body.operation as WireOperation, signal, options);
  }
  throw new ToolCallError('bad_response', 'Unexpected response from the server.');
}

/** One call to the server's single tool endpoint, as an agent's `execute` returns it: data, or the polled outcome of a change. */
export async function callServerTool(deps: ServerCallDeps, call: ServerCall, signal?: AbortSignal): Promise<unknown> {
  const answer = await callServerToolAnswer(deps, call, signal);
  return answer.type === 'page' ? (answer.pageData ?? { authorized: true }) : answer.value;
}

/**
 * What an agent is told when its call was withdrawn (Chrome ended it) and the cancel route answered. A cancel that lost
 * the race to the person's answer comes back RESOLVED (`committed`, `rejected`, ...): that is what happened, so that is
 * what is reported, never `cancelled`. Only a cancel that took effect says `cancelled`; one that could not be confirmed
 * says `unknown`.
 */
function withdrawnAnswer(id: string, answer: CancelAnswer | undefined): ServerAnswer {
  const value = (v: unknown): ServerAnswer => ({ type: 'value', value: v });
  if (answer?.outcome === 'cancelled') {
    return value({ outcome: 'cancelled', operationId: id, reason: 'The browser cancelled this call, so the request was withdrawn.' });
  }
  if (answer?.outcome !== undefined) return value({ outcome: answer.outcome, operationId: id, ...(answer.reason ? { reason: answer.reason } : {}) });
  return value({ outcome: 'unknown', operationId: id, reason: 'The browser cancelled this call, but the server could not be reached to withdraw the request. It expires on its own.' });
}

async function waitForOperation(
  deps: ServerCallDeps,
  headers: () => Record<string, string>,
  agentCall: AgentCall | undefined,
  operation: WireOperation,
  signal: AbortSignal | undefined,
  options: AnswerOptions
): Promise<ServerAnswer> {
  const id = operation.id;
  // Registered, under THIS call, for as long as the card is open: Chrome can end this call without any signal (see
  // `endChromeCall`). A person's own submit has no agent call and registers nothing.
  if (agentCall && deps.ledger && !deps.ledger.attach(agentCall, id)) {
    // Chrome already ended this call (a toolcancel arrived before its operation existed): withdraw the card now.
    return withdrawnAnswer(id, await cancelOperation(deps, id));
  }
  try {
    return await pollOperation(deps, headers, id, signal, options);
  } finally {
    // The outcome was delivered (or the call was withdrawn): nothing is left to cancel.
    deps.ledger?.release(id);
  }
}

async function pollOperation(
  deps: ServerCallDeps,
  headers: () => Record<string, string>,
  id: string,
  signal: AbortSignal | undefined,
  options: AnswerOptions
): Promise<ServerAnswer> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  const interval = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const deadline = now() + (deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const value = (v: unknown): ServerAnswer => ({ type: 'value', value: v });

  // The agent gave up (its execute was aborted): withdraw the card's operation, best effort.
  const cancelAndThrow = async (): Promise<never> => {
    deps.ledger?.release(id); // this cancel is the one; the ledger must not offer it again
    await cancelOperation(deps, id);
    throw abortError();
  };

  // Chrome ended this call and `endChromeCall` is cancelling (or has cancelled) its operation server-side: stop polling for a
  // card nobody is waiting on, and report what the cancel route said (it may have lost the race to the person's answer).
  const withdrawal = () => deps.ledger?.withdrawal(id);
  const withdrawnResult = async (pending: Promise<CancelAnswer | undefined>) => withdrawnAnswer(id, await pending);

  while (now() < deadline) {
    if (signal?.aborted) return cancelAndThrow();
    const w0 = withdrawal();
    if (w0) return withdrawnResult(w0);
    try {
      // `view=agent`: the agent gets the status and a sanitized result, never the stored row text.
      const res = await deps.fetch(`/api/mcp/operations/${id}?view=agent`, { headers: headers(), signal });
      // A cancel that started while this request was in flight has marked the row resolved: its answer is the truth.
      const w1 = withdrawal();
      if (w1) return withdrawnResult(w1);
      if (res.status === 404) {
        return value({ outcome: 'unknown', operationId: id, reason: 'The request is no longer available.' });
      }
      if (res.ok) {
        const op = (await readJson(res))?.operation as WireOperation | undefined;
        if (op && op.status !== 'pending') {
          if (op.kind === 'read' && op.status === 'committed') {
            // The user allowed the read: the agent gets what a direct read would have returned. For a page tool the
            // same data is the row the page may now show.
            if (op.data !== undefined) return options.pageMode ? { type: 'page', pageData: op.data } : value(op.data);
            return value({ outcome: 'committed', operationId: op.id, reason: 'The data was already delivered. Ask again if you need it.' });
          }
          return value({
            outcome: op.status,
            operationId: op.id,
            result: op.result,
          });
        }
      }
    } catch {
      // Transport hiccup mid-poll: the row is durable server-side, so reconcile by
      // operation id on the next tick rather than assuming failure.
    }
    await sleep(interval, signal);
    if (signal?.aborted) return cancelAndThrow();
    const w2 = withdrawal();
    if (w2) return withdrawnResult(w2);
  }
  return value({ outcome: 'unknown', operationId: id, reason: 'No response within the approval window — the card is still open.' });
}

// ── Reconcile scheduling ─────────────────────────────────────────────────────

export interface ReconcileSchedulerOptions {
  /** One reconcile pass. Never called twice at once. */
  run: () => Promise<void>;
  /** Debounce for `request`. Default 50 ms, so one tab change (unmount, mount, active tab) is one pass. */
  delayMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface ReconcileScheduler {
  /** Something that affects the registered set changed: reconcile soon (debounced). */
  request(): void;
  /** Reconcile now, after any pass in flight. Resolves when that pass is done. */
  flush(): Promise<void>;
  /** Resolves when every pass requested so far has finished. */
  settled(): Promise<void>;
}

/**
 * Registrations are async (`registerTool` returns a promise), so two overlapping passes could register a name twice.
 * Passes run one after another; requests inside the debounce window collapse into one.
 */
export function createReconcileScheduler(options: ReconcileSchedulerOptions): ReconcileScheduler {
  const delay = options.delayMs ?? 50;
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  let timer: unknown = null;
  let chain: Promise<void> = Promise.resolve();

  const enqueue = (): Promise<void> => {
    chain = chain.then(() => options.run()).catch(() => {
      // A failed pass leaves the registrations as they were; the next request or sync tries again.
    });
    return chain;
  };

  return {
    request() {
      if (timer !== null) clearTimer(timer);
      timer = setTimer(() => {
        timer = null;
        void enqueue();
      }, delay);
    },
    flush() {
      if (timer !== null) {
        clearTimer(timer);
        timer = null;
      }
      return enqueue();
    },
    settled: () => chain,
  };
}

// ── Page tools ───────────────────────────────────────────────────────────────

/** The most a page tool may hand an agent (the same bound as every other tool's output). */
const PAGE_OUTPUT_CAP = 1500;

/** What the bridge needs to know about the React handlers: structurally the page registry's `getHandler` and `activeTab`. */
export interface PageToolRuntime {
  activeTab(): string | undefined;
  getHandler(name: string): { tab: string; signal: AbortSignal; handler: (args: Record<string, unknown>, ctx: { signal: AbortSignal; pageData?: unknown }) => Promise<unknown> } | undefined;
}

export interface ExecutePageToolOptions {
  tool: Pick<LiveToolDescriptor, 'name' | 'surface' | 'openHint'>;
  args: Record<string, unknown>;
  /** The agent's `execute` signal. */
  signal: AbortSignal;
  /** The server call (grant, policy, limits, audit, pageData), with the same signal. */
  serverCall: (signal: AbortSignal) => Promise<ServerAnswer>;
  runtime: PageToolRuntime;
}

/** One signal that aborts when any of `signals` does. */
function joinSignals(signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort();
      break;
    }
    signal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  return controller.signal;
}

function markStale(value: unknown): unknown {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? { ...(value as Record<string, unknown>), stale: true } : { result: value, stale: true };
}

function capPageAnswer(value: unknown): unknown {
  let size: number;
  try {
    size = JSON.stringify(value)?.length ?? 0;
  } catch {
    size = Infinity;
  }
  if (size <= PAGE_OUTPUT_CAP) return value;
  return {
    error: { code: 'output_too_long', message: `The page's answer was longer than ${PAGE_OUTPUT_CAP} characters and was dropped.` },
    truncated: true,
  };
}

/**
 * Run a page tool: the server decides first (grant, policy, rate limit, audit, and an Ask card if the user wants one),
 * then the tab's own handler does the visible work and answers. A handler that is gone (the tab changed, the tab never
 * mounted one) answers with the tool's hint instead of touching unmounted state. An answer that raced a tab change is
 * marked `stale`. Chrome keeps an in-flight run alive after a tool is unregistered; this is what that run returns.
 *
 * Nothing here throws an agent-actionable message: a server refusal (404, policy Off, kill switch, bad args) or a handler
 * that throws comes back as `{ error: { code, message } }`, because Chrome replaces a thrown error with a generic one.
 * Only an abort (the agent gave up) still rejects.
 */
export async function executePageTool(options: ExecutePageToolOptions): Promise<unknown> {
  return runToolSafely(async () => {
    const { tool, runtime } = options;
    const answer = await options.serverCall(options.signal);
    if (answer.type === 'value') return answer.value;

    const entry = runtime.getHandler(tool.name);
    if (!entry || entry.signal.aborted) {
      return { error: { code: 'tab_not_open', message: tool.openHint ?? `${tool.name} is not available on this page right now.` } };
    }

    const handlerSignal = joinSignals([options.signal, entry.signal]);
    const result = await entry.handler(options.args, { signal: handlerSignal, pageData: answer.pageData });
    if (options.signal.aborted) throw abortError();

    const wrongTab = tool.surface !== undefined && tool.surface !== 'global' && runtime.activeTab() !== tool.surface.tab;
    return capPageAnswer(entry.signal.aborted || wrongTab ? markStale(result) : result);
  });
}

/** What an imperative (non-page) tool's `execute` returns: its server call, with a refusal as a result instead of a throw. */
export function executeServerTool(call: () => Promise<unknown>): Promise<unknown> {
  return runToolSafely(call);
}

export { errorResult, isAbortError };
