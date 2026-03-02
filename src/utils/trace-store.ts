/**
 * In-memory ring buffer for LLM call traces.
 * Visible in the dashboard Traces tab — no external collector needed.
 */

export interface LlmTrace {
  id: string;
  timestamp: string;
  model: string;
  provider: string;
  promptLength: number;
  responseLength: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  durationMs: number;
  status: 'ok' | 'error';
  error?: string;
}

export type TraceSubscriber = (traces: LlmTrace[]) => void;

const MAX_TRACES = 200;

class TraceStore {
  private traces: LlmTrace[] = [];
  private subscribers: Set<TraceSubscriber> = new Set();

  record(trace: LlmTrace): void {
    this.traces.push(trace);
    if (this.traces.length > MAX_TRACES) {
      this.traces = this.traces.slice(-MAX_TRACES);
    }
    this.notify();
  }

  getTraces(): LlmTrace[] {
    return [...this.traces];
  }

  getRecentTraces(limit: number = 50): LlmTrace[] {
    return this.traces.slice(-limit);
  }

  subscribe(fn: TraceSubscriber): () => void {
    this.subscribers.add(fn);
    fn([...this.traces]);
    return () => this.subscribers.delete(fn);
  }

  clear(): void {
    this.traces = [];
    this.notify();
  }

  /**
   * Summary stats for the current session.
   */
  getStats(): TraceStats {
    const ok = this.traces.filter(t => t.status === 'ok');
    const errors = this.traces.filter(t => t.status === 'error');
    const totalTokens = ok.reduce((s, t) => s + t.totalTokens, 0);
    const totalDuration = ok.reduce((s, t) => s + t.durationMs, 0);
    const avgDuration = ok.length > 0 ? Math.round(totalDuration / ok.length) : 0;

    // Group by model
    const byModel: Record<string, { calls: number; tokens: number; avgMs: number }> = {};
    for (const t of ok) {
      if (!byModel[t.model]) byModel[t.model] = { calls: 0, tokens: 0, avgMs: 0 };
      byModel[t.model].calls++;
      byModel[t.model].tokens += t.totalTokens;
    }
    for (const model of Object.keys(byModel)) {
      const modelTraces = ok.filter(t => t.model === model);
      const modelDuration = modelTraces.reduce((s, t) => s + t.durationMs, 0);
      byModel[model].avgMs = Math.round(modelDuration / modelTraces.length);
    }

    return {
      totalCalls: this.traces.length,
      successfulCalls: ok.length,
      errorCalls: errors.length,
      totalTokens,
      totalDurationMs: totalDuration,
      avgDurationMs: avgDuration,
      byModel,
    };
  }

  private notify(): void {
    this.subscribers.forEach(fn => fn([...this.traces]));
  }
}

export interface TraceStats {
  totalCalls: number;
  successfulCalls: number;
  errorCalls: number;
  totalTokens: number;
  totalDurationMs: number;
  avgDurationMs: number;
  byModel: Record<string, { calls: number; tokens: number; avgMs: number }>;
}

// Singleton
export const traceStore = new TraceStore();
