// Slice 8 measurement worker (no product code). Runs the REAL model engine
// (transformers.js + WebGPU) and the REAL runSubagent loop; only the mirror
// port is replaced by an HTTP bridge to scripts/subagent-route-eval-server.ts,
// which runs the real mirror executors under bun:sqlite.
import * as transformers from '@huggingface/transformers';
import { createModelEngine, type TransformersModule } from '../../src/dashboard/ui/src/hybrid/model-engine.js';
import { runSubagent, type GenerateRequest } from '../../src/dashboard/ui/src/hybrid/subagent-core.js';
import { DEFAULT_SUBAGENT_LIMITS, type StepEvent } from '../../src/dashboard/ui/src/hybrid/worker-protocol.js';

interface Ctx {
  postMessage(m: unknown): void;
  onmessage: ((e: MessageEvent<any>) => void) | null;
}
const ctx = self as unknown as Ctx;

const engine = createModelEngine({ loadTransformers: async () => transformers as unknown as TransformersModule });
let sidecar = '';

async function rpc(body: Record<string, unknown>): Promise<{ res: any; execMs: number }> {
  const r = await fetch(`${sidecar}/rpc`, { method: 'POST', body: JSON.stringify(body) });
  return (await r.json()) as { res: any; execMs: number };
}

async function adapterInfo(): Promise<Record<string, unknown>> {
  const gpu = (navigator as any).gpu;
  const a = await gpu?.requestAdapter?.();
  if (!a) return { adapter: null };
  const info = a.info ?? (await a.requestAdapterInfo?.()) ?? {};
  return {
    vendor: info.vendor,
    architecture: info.architecture,
    description: info.description,
    isFallbackAdapter: a.isFallbackAdapter ?? info.isFallbackAdapter ?? false,
    shaderF16: a.features?.has?.('shader-f16') ?? null,
    crossOriginIsolated: (self as any).crossOriginIsolated,
  };
}

async function handle(msg: any): Promise<unknown> {
  switch (msg.t) {
    case 'init': {
      sidecar = msg.sidecar;
      engine.setModel(msg.model, msg.origin);
      return { adapter: await adapterInfo() };
    }
    case 'load': {
      const r = await engine.load();
      return r;
    }
    case 'run': {
      const gens: Array<{ kind: string; ms: number; chars: number }> = [];
      const tools: Array<{ tool: string; wallMs: number; execMs: number; args?: unknown; result?: unknown }> = [];
      const events: Array<{ at: number; e: StepEvent }> = [];
      const t0 = performance.now();
      let statusMs = 0;
      const outcome = await runSubagent(
        {
          async generate(req: GenerateRequest) {
            const s = performance.now();
            const out = await engine.generate({ system: req.system, user: req.user, maxNewTokens: req.maxNewTokens, signal: req.signal });
            gens.push({ kind: req.kind, ms: performance.now() - s, chars: out.length });
            return out;
          },
          async toolRead(req) {
            const s = performance.now();
            const { res, execMs } = await rpc({ t: 'toolRead', tool: req.tool, args: req.args, nowIso: req.nowIso, persona: msg.persona ?? null });
            tools.push({ tool: req.tool, wallMs: performance.now() - s, execMs, args: req.args, result: res.ok ? res.result : { error: res.error } });
            if (!res.ok) throw new Error(res.error);
            return res.result;
          },
          async status() {
            const s = performance.now();
            const { res } = await rpc({ t: 'status', persona: msg.persona ?? null });
            statusMs = performance.now() - s;
            return res.result;
          },
          now: () => Date.now(),
          emit: (e) => events.push({ at: performance.now() - t0, e }),
        },
        {
          query: msg.q,
          nowIso: msg.nowIso,
          expectedProfile: 'default',
          priorLocalTurns: [],
          limits: { ...DEFAULT_SUBAGENT_LIMITS, ...(msg.limits ?? {}) },
          // Round 4 arm O: the main thread's open-jev pick, re-checked by the core against the frozen cut.
          ...(msg.routeHint ? { routeHint: msg.routeHint } : {}),
        }
      );
      const totalMs = performance.now() - t0;
      return {
        outcome: outcome.kind,
        reason: outcome.kind === 'handoff' ? outcome.reason : null,
        text: outcome.kind === 'answer' ? outcome.text : null,
        steps: outcome.kind === 'answer' ? outcome.steps.map((s) => ({ tool: s.tool, rows: (s as any).rows })) : null,
        handoffSteps: outcome.kind === 'handoff' ? outcome.handoff.steps.map((s: any) => ({ tool: s.tool, rows: s.rows })) : null,
        suggestedCall: outcome.kind === 'handoff' ? ((outcome.handoff as any).suggestedCall ?? null) : null,
        gens,
        tools,
        statusMs,
        events,
        totalMs,
      };
    }
    default:
      throw new Error('unknown message ' + msg.t);
  }
}

ctx.onmessage = async (e) => {
  const { id } = e.data;
  try {
    ctx.postMessage({ id, ok: true, result: await handle(e.data) });
  } catch (err) {
    ctx.postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
