// ── Browser-only: the local-model Web Worker ────────────────────────────────
//
// Owns the transformers.js import, the ORT/WebGPU session and every
// generation, so inference never blocks the main thread. Imported with
// `?worker&inline` from standalone.ts, which only vite.hybrid.config.ts
// builds: the worker lands inside dist-hybrid/hybrid-chat.js as a blob module
// worker, and the singlefile app build never sees transformers or ORT.
//
// The worker holds no auth token and makes no authed requests. Its only
// network access is the HF Hub (weights, global fetch) and same-origin
// /assets/ort/*. Protocol: worker-protocol.ts (pure, unit tested).
//
// Must never be imported from a root test (it touches `self`).

import * as transformers from '@huggingface/transformers';
import { createModelEngine, toWorkerError, type TransformersModule } from './model-engine.js';
import { runSubagentOnPort } from './subagent-runner.js';
import type { PortLike } from '../store/mirror-port-protocol.js';
import {
  checkWorkerOrigin,
  isMainToWorker,
  shouldAbort,
  shouldStart,
  type MainToWorker,
  type WorkerError,
  type WorkerToMain,
} from './worker-protocol.js';

// Minimal worker-scope shape: DedicatedWorkerGlobalScope lives in
// lib.webworker.d.ts, which the UI tsconfig does not include (mirrors
// store/mirror-worker.ts's WorkerScope shim).
interface WorkerScope {
  postMessage(message: unknown): void;
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  origin?: string;
}

const ctx = self as unknown as WorkerScope;

const engine = createModelEngine({
  // Static import above: the inlined worker bundle never needs a runtime chunk.
  loadTransformers: async () => transformers as unknown as TransformersModule,
});

function send(msg: WorkerToMain): void {
  ctx.postMessage(msg);
}

function fail(id: number, error: WorkerError): void {
  send({ t: 'result', id, ok: false, error });
}

/** Set when `init` found an opaque or mismatched origin; the worker then loads nothing. */
let refusal: string | null = null;
/** Highest run id seen (bundleAnswer or subagentRun); a cancel bumps it past the cancelled id. */
let activeRunId = 0;
/** In-flight subagent runs, so a cancel or a newer run can interrupt generation. */
const runControllers = new Map<number, AbortController>();

function closePort(port: unknown): void {
  try {
    (port as { close?: () => void } | null)?.close?.();
  } catch {
    // already closed
  }
}

async function handle(msg: MainToWorker): Promise<void> {
  switch (msg.t) {
    case 'init': {
      const check = checkWorkerOrigin(ctx.origin, msg.origin);
      if (!check.ok) {
        refusal = check.reason;
        return;
      }
      refusal = null;
      engine.setModel(msg.model, msg.origin);
      return;
    }
    case 'probe': {
      if (refusal) return send({ t: 'result', id: msg.id, ok: true, result: 'unavailable' });
      return send({ t: 'result', id: msg.id, ok: true, result: await engine.probe() });
    }
    case 'load': {
      if (refusal) return fail(msg.id, { phase: 'protocol', message: `model worker refused to run: ${refusal}` });
      try {
        const result = await engine.load((label) => send({ t: 'progress', id: msg.id, label }));
        send({ t: 'result', id: msg.id, ok: true, result });
      } catch (err) {
        fail(msg.id, toWorkerError(err, 'load'));
      }
      return;
    }
    case 'bundleAnswer': {
      if (refusal) return fail(msg.id, { phase: 'protocol', message: `model worker refused to run: ${refusal}` });
      if (!shouldStart(msg.runId, activeRunId)) {
        return fail(msg.id, { phase: 'cancelled', message: 'superseded by a newer run' });
      }
      activeRunId = msg.runId;
      try {
        const verdict = await engine.bundleAnswer(msg.query, msg.bundleText, msg.today);
        if (shouldAbort(msg.runId, activeRunId)) {
          return fail(msg.id, { phase: 'cancelled', message: 'cancelled' });
        }
        send({ t: 'result', id: msg.id, ok: true, result: verdict });
      } catch (err) {
        fail(msg.id, toWorkerError(err, 'generate'));
      }
      return;
    }
    case 'categorize': {
      if (refusal) return fail(msg.id, { phase: 'protocol', message: `model worker refused to run: ${refusal}` });
      try {
        send({ t: 'result', id: msg.id, ok: true, result: await engine.categorize(msg.opts) });
      } catch (err) {
        fail(msg.id, toWorkerError(err, 'generate'));
      }
      return;
    }
    case 'subagentRun': {
      if (refusal) {
        closePort(msg.port);
        return fail(msg.id, { phase: 'protocol', message: `model worker refused to run: ${refusal}` });
      }
      if (!shouldStart(msg.runId, activeRunId)) {
        closePort(msg.port);
        return fail(msg.id, { phase: 'cancelled', message: 'superseded by a newer run' });
      }
      // A newer run supersedes every older one: interrupt their generation.
      for (const [id, c] of runControllers) if (id < msg.runId) c.abort();
      activeRunId = msg.runId;
      const ac = new AbortController();
      runControllers.set(msg.runId, ac);
      try {
        const result = await runSubagentOnPort({
          port: msg.port as PortLike,
          generate: (req) =>
            engine.generate({ system: req.system, user: req.user, maxNewTokens: req.maxNewTokens, signal: req.signal ?? ac.signal }),
          input: {
            query: msg.query,
            nowIso: msg.nowIso,
            expectedProfile: msg.expectedProfile,
            priorLocalTurns: msg.priorLocalTurns,
            limits: msg.limits,
            ...(msg.routeHint !== undefined ? { routeHint: msg.routeHint } : {}),
          },
          signal: ac.signal,
          emit: (event) => send({ t: 'step', id: msg.id, runId: msg.runId, event }),
        });
        send({ t: 'result', id: msg.id, ok: true, result });
      } catch (err) {
        closePort(msg.port);
        fail(msg.id, toWorkerError(err, 'generate'));
      } finally {
        runControllers.delete(msg.runId);
      }
      return;
    }
    case 'cancel': {
      // Bump past the cancelled id so its result is dropped and a same-id replay can never restart it.
      activeRunId = Math.max(activeRunId, msg.runId + 1);
      runControllers.get(msg.runId)?.abort();
      return;
    }
  }
}

ctx.onmessage = (event) => {
  const msg = event.data;
  if (!isMainToWorker(msg)) return;
  // Deliberately not awaited: the handler must return immediately so the
  // message queue keeps draining (a cancel or newer run can arrive mid-generation).
  void handle(msg).catch((err) => {
    if ('id' in msg) fail(msg.id, toWorkerError(err, 'protocol'));
  });
};
