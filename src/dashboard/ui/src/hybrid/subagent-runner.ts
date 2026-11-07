/**
 * The worker side of one subagent run: a request/response client over the
 * scoped mirror MessagePort, and `runSubagentOnPort`, which wires that client
 * plus a `generate` function into the pure state machine (subagent-core.ts).
 *
 * Pure of DOM, Worker and transformers.js (the port and generate are injected),
 * so it is unit tested under bun with a fake port. model.worker.ts is a thin
 * shell over it.
 *
 * Port traffic is exactly `status` and `toolRead` (mirror-port-protocol.ts);
 * that is the worker's only data access. The port is closed when the run ends
 * whatever the outcome.
 *
 * Loop hardening (teardown §3, patterns 2-4): every tool read goes through
 * `runToolCall`, so a failed read becomes an `is_error` result and an identical
 * repeat of a failed read is not sent to the port again. A context overflow
 * from generation is a typed error and does not count as a device fault.
 */

import type { MirrorPortStatus, PortLike, ToolReadResult } from '../store/mirror-port-protocol.js';
import {
  FailedCallMemory,
  ToolCallError,
  isContextOverflowError,
  runSubagent,
  runToolCall,
  type GenerateRequest,
  type SubagentDeps,
  type SubagentInput,
  type ToolCallResult,
} from './subagent-core.js';
import type { StepEvent, SubagentRunResult } from './worker-protocol.js';

export const PORT_REQUEST_TIMEOUT_MS = 5_000;

export interface PortClient {
  status(): Promise<MirrorPortStatus>;
  toolRead(req: { tool: string; args: Record<string, unknown>; nowIso: string }): Promise<ToolReadResult>;
  /** Close the port and reject whatever is still waiting. Idempotent. */
  close(): void;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

export function createPortClient(port: PortLike, opts: { requestTimeoutMs?: number } = {}): PortClient {
  const timeoutMs = opts.requestTimeoutMs ?? PORT_REQUEST_TIMEOUT_MS;
  let nextId = 1;
  let closed = false;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();

  port.onmessage = (ev) => {
    const data = ev.data;
    if (!isRecord(data) || typeof data.id !== 'number') return;
    const entry = pending.get(data.id);
    if (!entry) return;
    pending.delete(data.id);
    clearTimeout(entry.timer);
    if (data.ok === true) entry.resolve(data.result);
    else entry.reject(new Error(typeof data.error === 'string' ? data.error : 'mirror port error'));
  };

  function request<T>(build: (id: number) => Record<string, unknown>): Promise<T> {
    if (closed) return Promise.reject(new Error('mirror port closed'));
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('mirror port timeout'));
      }, timeoutMs);
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      try {
        port.postMessage(build(id));
      } catch (err) {
        pending.delete(id);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  return {
    status: () => request<MirrorPortStatus>((id) => ({ id, t: 'status' })),
    toolRead: (req) => request<ToolReadResult>((id) => ({ id, t: 'toolRead', tool: req.tool, args: req.args, nowIso: req.nowIso })),
    close() {
      if (closed) return;
      closed = true;
      for (const [, entry] of pending) {
        clearTimeout(entry.timer);
        entry.reject(new Error('mirror port closed'));
      }
      pending.clear();
      port.onmessage = null;
      try {
        port.close();
      } catch {
        // already closed
      }
    },
  };
}

/** What a read contributes as tool-result text: its summary only (row data never leaves the worker). */
function readContent(r: ToolReadResult): string {
  return isRecord(r) && r.servable === true && typeof r.summary === 'string' ? r.summary : '';
}

export interface RunOnPortOpts {
  port: PortLike;
  /** One model generation (the engine's, in the worker). */
  generate(req: GenerateRequest): Promise<string>;
  input: SubagentInput;
  signal?: AbortSignal;
  emit?(event: StepEvent): void;
  now?(): number;
  /** Per-request port timeout (tests shorten it). */
  portTimeoutMs?: number;
  /**
   * Failed-call memory. Defaults to a fresh one per run; pass one to share it
   * across runs (a success in any run clears it).
   */
  failedCalls?: FailedCallMemory;
  /** Every tool read's result, success or `is_error`, in order. Exceptions are swallowed. */
  onToolResult?(result: ToolCallResult<ToolReadResult>): void;
}

/**
 * Run one turn. ALWAYS resolves. `deviceFault` is set when `generate` threw:
 * a failed OrtRun can poison the WebGPU session, so the main thread respawns
 * the worker after this result. A ContextOverflowError is the exception: the
 * prompt never reached the GPU, so the session is fine.
 */
export async function runSubagentOnPort(opts: RunOnPortOpts): Promise<SubagentRunResult> {
  const client = createPortClient(opts.port, { requestTimeoutMs: opts.portTimeoutMs });
  const failedCalls = opts.failedCalls ?? new FailedCallMemory();
  let deviceFault = false;
  const deps: SubagentDeps = {
    generate: async (req) => {
      try {
        return await opts.generate(req);
      } catch (err) {
        if (!isContextOverflowError(err)) deviceFault = true;
        throw err;
      }
    },
    // The core's contract is unchanged: a read resolves or rejects. An is_error result rejects with a
    // ToolCallError, which the core turns into its usual 'error' handoff.
    toolRead: async (req) => {
      const result = await runToolCall(failedCalls, { tool: req.tool, args: req.args }, () => client.toolRead(req), readContent);
      try {
        opts.onToolResult?.(result);
      } catch {
        // observers must never break a run
      }
      if (result.is_error) throw new ToolCallError(result);
      return result.value;
    },
    status: () => client.status(),
    now: opts.now ?? (() => Date.now()),
    signal: opts.signal,
    emit: opts.emit,
  };
  try {
    const outcome = await runSubagent(deps, opts.input);
    return { outcome, deviceFault };
  } finally {
    client.close();
  }
}
