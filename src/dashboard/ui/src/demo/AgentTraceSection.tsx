import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/api';
import { useApi } from '@/hooks/useApi';
import {
  parseStatementContent,
  sha256Hex,
  canCommitImport,
  type ParsedStatement,
} from '@import-tools/client-import';

/**
 * The statement-to-dashboard agent trace: drop a bank statement and watch
 * Wilson's offline chain run as a live four-node flow diagram —
 * import → embedding lookup → category prediction → reconciliation hint —
 * each node lit by its real server-measured duration.
 *
 * Boundary (round-1 decision): statements only — CSV/OFX/QIF. No image or OCR
 * input exists anywhere in this flow; the accept list IS the boundary.
 * Every request is a same-origin api() call; nothing external.
 */

// ── Wire shapes (mirror src/demo/statement-trace.ts) ────────────────────────

type TraceStepId = 'import' | 'embed' | 'predict' | 'reconcile';

interface TraceStepResponse {
  step: TraceStepId;
  status: 'ok' | 'skipped' | 'error';
  durationMs: number;
  error?: string;
  detail: {
    // import
    bank?: string;
    format?: string;
    rowCount?: number;
    imported?: number;
    skippedRows?: number;
    importedIds?: number[];
    previouslyImported?: { importedAt: string; transactionCount: number | null };
    message?: string;
    // embed
    model?: string;
    matches?: { description: string; label: string; category: string; score: number }[];
    // predict
    description?: string;
    category?: string;
    confidence?: number;
    displayOnly?: true;
    // reconcile
    duplicates?: {
      transactions: { id: number; date: string; description: string; amount: number }[];
      message: string;
    }[];
    spikes?: {
      transaction: { date: string; description: string; amount: number };
      message: string;
    }[];
  };
}

type NodeState = 'pending' | 'running' | 'done' | 'skipped' | 'error';

interface NodeUi {
  state: NodeState;
  /** The server-measured duration — the only number a settled node displays. */
  durationMs?: number;
  error?: string;
}

const STEP_LABELS: Record<TraceStepId, string> = {
  import: 'Import',
  embed: 'Embedding lookup',
  predict: 'Category prediction',
  reconcile: 'Reconciliation hint',
};

const ACCEPTED_EXTENSIONS = ['.csv', '.ofx', '.qif'];

function fmtUsd(n: number): string {
  return (
    '$' +
    Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  );
}

/** The demo chain drives steps one POST at a time — each node lights on its own response. */
async function postStep(body: Record<string, unknown>): Promise<TraceStepResponse> {
  return api<TraceStepResponse>('/api/demo/trace/step', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

/**
 * The api() helper throws `API <status>: <body>` on non-2xx. The trace endpoint
 * returns its error messages as JSON, so unwrap them for honest display.
 */
function traceErrorFrom(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const sep = err.message.indexOf(':');
  if (err.message.startsWith('API ') && sep !== -1) {
    try {
      const body = JSON.parse(err.message.slice(sep + 1)) as { error?: string; message?: string };
      if (body.error) return body.error;
      if (body.message) return body.message;
    } catch {
      /* fall through to the raw message */
    }
  }
  return err.message;
}

const PENDING_NODES: Record<TraceStepId, NodeUi> = {
  import: { state: 'pending' },
  embed: { state: 'pending' },
  predict: { state: 'pending' },
  reconcile: { state: 'pending' },
};

export function AgentTraceSection() {
  const { data: authStatus } = useApi<{ authEnabled: boolean; user: { role?: string } | null }>('/api/auth/status');
  const mayCommit = canCommitImport(authStatus ?? null);

  const [error, setError] = useState<string | null>(null);
  const [fileLabel, setFileLabel] = useState<string | null>(null);
  const [parsed, setParsed] = useState<ParsedStatement | null>(null);
  const [parseMs, setParseMs] = useState<number | null>(null);
  const [running, setRunning] = useState(false);
  const [nodes, setNodes] = useState<Record<TraceStepId, NodeUi>>(PENDING_NODES);
  const [importDetail, setImportDetail] = useState<TraceStepResponse['detail'] | null>(null);
  const [embedDetail, setEmbedDetail] = useState<TraceStepResponse['detail'] | null>(null);
  const [predictDetail, setPredictDetail] = useState<TraceStepResponse['detail'] | null>(null);
  const [reconcileDetail, setReconcileDetail] = useState<TraceStepResponse['detail'] | null>(null);
  const [predictingRow, setPredictingRow] = useState<string | null>(null);
  const [totalMs, setTotalMs] = useState<number | null>(null);

  const [now, setNow] = useState(0);
  const stepStartedAt = useRef<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const runIdRef = useRef(0);

  // In-flight ticker: real elapsed since the running node started. On settle,
  // the node snaps to the server-returned durationMs — never the tick value.
  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => {
      setNow(stepStartedAt.current !== null ? performance.now() - stepStartedAt.current : 0);
    }, 80);
    return () => window.clearInterval(id);
  }, [running]);

  const setNode = (step: TraceStepId, node: NodeUi) => {
    setNodes((prev) => ({ ...prev, [step]: node }));
  };

  const runChain = useCallback(async (statement: ParsedStatement, hash: string, filename: string) => {
    const runId = ++runIdRef.current;
    const alive = () => runIdRef.current === runId;
    // totalMs mirrors the orchestrator's contract: the exact sum of the
    // server-measured durations of the steps that ran (skipped steps: 0).
    const durations: number[] = [];
    const recordTotal = () => {
      setTotalMs(durations.reduce((s, n) => s + n, 0));
    };
    const beginStep = () => {
      stepStartedAt.current = performance.now();
      setNow(0);
    };
    const endRun = () => {
      stepStartedAt.current = null;
      setRunning(false);
      recordTotal();
    };

    setRunning(true);
    setError(null);
    setTotalMs(null);
    setNodes(PENDING_NODES);
    setImportDetail(null);
    setEmbedDetail(null);
    setPredictDetail(null);
    setReconcileDetail(null);
    const firstRow = statement.transactions[0];
    setPredictingRow(firstRow?.description ?? null);

    // ── Node 1: import ────────────────────────────────────────────────────
    setNode('import', { state: 'running' });
    beginStep();
    let importedIds: number[] = [];
    try {
      const res = await postStep({
        step: 'import',
        filename,
        bank: statement.bank,
        format: statement.format,
        fileHash: hash,
        transactions: statement.transactions,
      });
      if (!alive()) return;
      durations.push(res.durationMs);
      setImportDetail(res.detail);
      setNode('import', {
        state: res.status === 'error' ? 'error' : res.status === 'skipped' ? 'skipped' : 'done',
        durationMs: res.durationMs,
        error: res.error,
      });
      if (res.status === 'ok') {
        importedIds = res.detail.importedIds ?? [];
      } else {
        // Re-drop (skipped) or failure: the chain stops here, later steps render skipped.
        const reason = res.status === 'skipped' ? 'statement already imported' : (res.error ?? 'import failed');
        setNode('embed', { state: 'skipped', error: reason });
        setNode('predict', { state: 'skipped', error: reason });
        setNode('reconcile', { state: 'skipped', error: reason });
        endRun();
        return;
      }
    } catch (err) {
      if (!alive()) return;
      const message = traceErrorFrom(err);
      setNode('import', { state: 'error', error: message });
      setNode('embed', { state: 'skipped', error: message });
      setNode('predict', { state: 'skipped', error: message });
      setNode('reconcile', { state: 'skipped', error: message });
      endRun();
      return;
    }

    const rows = statement.transactions.map((t) => ({ description: t.description }));

    // ── Node 2: embedding lookup ──────────────────────────────────────────
    setNode('embed', { state: 'running' });
    beginStep();
    try {
      const res = await postStep({ step: 'embed', transactions: rows });
      if (!alive()) return;
      durations.push(res.durationMs);
      setEmbedDetail(res.detail);
      setNode('embed', { state: res.status === 'error' ? 'error' : 'done', durationMs: res.durationMs, error: res.error });
      if (res.status === 'error') {
        const reason = res.error ?? 'embedding lookup failed';
        setNode('predict', { state: 'skipped', error: reason });
        setNode('reconcile', { state: 'skipped', error: reason });
        endRun();
        return;
      }
    } catch (err) {
      if (!alive()) return;
      const message = traceErrorFrom(err);
      setNode('embed', { state: 'error', error: message });
      setNode('predict', { state: 'skipped', error: message });
      setNode('reconcile', { state: 'skipped', error: message });
      endRun();
      return;
    }

    // ── Node 3: category prediction (display-only) ────────────────────────
    setNode('predict', { state: 'running' });
    beginStep();
    try {
      const res = await postStep({ step: 'predict', description: firstRow.description });
      if (!alive()) return;
      durations.push(res.durationMs);
      setPredictDetail(res.detail);
      setNode('predict', { state: res.status === 'error' ? 'error' : 'done', durationMs: res.durationMs, error: res.error });
      if (res.status === 'error') {
        const reason = res.error ?? 'prediction failed';
        setNode('reconcile', { state: 'skipped', error: reason });
        endRun();
        return;
      }
    } catch (err) {
      if (!alive()) return;
      const message = traceErrorFrom(err);
      setNode('predict', { state: 'error', error: message });
      setNode('reconcile', { state: 'skipped', error: message });
      endRun();
      return;
    }

    // ── Node 4: reconciliation hint ───────────────────────────────────────
    setNode('reconcile', { state: 'running' });
    beginStep();
    try {
      const res = await postStep({ step: 'reconcile', importedIds });
      if (!alive()) return;
      durations.push(res.durationMs);
      setReconcileDetail(res.detail);
      setNode('reconcile', { state: res.status === 'error' ? 'error' : 'done', durationMs: res.durationMs, error: res.error });
    } catch (err) {
      if (!alive()) return;
      setNode('reconcile', { state: 'error', error: traceErrorFrom(err) });
    }
    endRun();
  }, []);

  const handleFile = useCallback(
    async (file: File) => {
      runIdRef.current += 1; // cancel any in-flight run
      setError(null);
      setNodes(PENDING_NODES);
      setImportDetail(null);
      setEmbedDetail(null);
      setPredictDetail(null);
      setReconcileDetail(null);
      setTotalMs(null);
      setParsed(null);
      setParseMs(null);
      setFileLabel(null);
      setRunning(false);

      // The accept list is the boundary: statements only, never images.
      const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
      if (!ACCEPTED_EXTENSIONS.includes(ext)) {
        setError(`Unsupported file type "${ext || file.name}" — Wilson reads statements (CSV, OFX, QIF), not images.`);
        return;
      }
      try {
        // Client-side parse + hash — no requests until the parse succeeds.
        const t0 = performance.now();
        const content = await file.text();
        const hash = await sha256Hex(content);
        const statement = parseStatementContent(content);
        if (statement.transactions.length === 0) {
          setError(`No transactions recognized in ${file.name} — Wilson couldn't find a statement it understands.`);
          return;
        }
        setParsed(statement);
        setParseMs(Math.round(performance.now() - t0));
        setFileLabel(file.name);
        await runChain(statement, hash, file.name);
      } catch (err) {
        setError(
          `${file.name}: Wilson couldn't parse that as a bank statement (CSV, OFX, or QIF). ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
    [runChain],
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const file = e.dataTransfer.files?.[0];
      if (file) void handleFile(file);
    },
    [handleFile],
  );

  const onPick = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) void handleFile(file);
      e.target.value = '';
    },
    [handleFile],
  );

  /** "Pick any row" — re-runs the prediction node on that row (a fresh POST, fresh real timing). */
  const rerunPredict = useCallback(async (description: string) => {
    setPredictingRow(description);
    setNode('predict', { state: 'running' });
    stepStartedAt.current = performance.now();
    setNow(0);
    try {
      const res = await postStep({ step: 'predict', description });
      setPredictDetail(res.detail);
      setNode('predict', {
        state: res.status === 'error' ? 'error' : 'done',
        durationMs: res.durationMs,
        error: res.error,
      });
    } catch (err) {
      setNode('predict', { state: 'error', error: traceErrorFrom(err) });
    } finally {
      stepStartedAt.current = null;
    }
  }, []);

  const bankLabel =
    parsed && parsed.bank && parsed.format
      ? `${parsed.bank.toUpperCase()} ${parsed.format.toUpperCase()}`
      : '';
  const importOk = nodes.import.state === 'done' && importDetail;
  const importSkipped = nodes.import.state === 'skipped' && importDetail;

  return (
    <div className="space-y-4">
      {!mayCommit && (
        <div className="bg-surface-raised border border-border rounded-lg p-4 text-sm text-text-secondary">
          Admin sign-in required to run the import step of this demo — sign in as an admin and
          drop the statement again.
        </div>
      )}

      {/* Drop zone — the accept list is the no-image/OCR boundary */}
      <div
        role="button"
        tabIndex={0}
        onClick={() => fileInputRef.current?.click()}
        onKeyDown={(e) => e.key === 'Enter' && fileInputRef.current?.click()}
        onDrop={onDrop}
        onDragOver={(e) => e.preventDefault()}
        className="border-2 border-dashed border-border rounded-lg p-6 text-center cursor-pointer hover:border-green transition-colors"
      >
        <input ref={fileInputRef} type="file" accept=".csv,.ofx,.qif" className="hidden" onChange={onPick} />
        <div className="text-sm text-text font-medium">
          Drop a bank statement — CSV, OFX, or QIF — or click to browse
        </div>
        <div className="text-xs text-text-muted mt-1">
          Parsed in your browser · SHA-256 dedup · nothing leaves this machine
        </div>
      </div>

      {error && <div className="bg-surface-raised border border-red rounded-lg p-3 text-sm text-red">{error}</div>}

      {parsed && (
        <div className="text-xs text-text-muted">
          {fileLabel} — parsed client-side in {parseMs} ms, {parsed.transactions.length} transactions (
          {parsed.dateRange.start} → {parsed.dateRange.end})
        </div>
      )}

      {/* Flow diagram */}
      <div className="flex flex-col">
        <TraceNode id="import" node={nodes.import} tick={now}>
          {importOk && (
            <div className="space-y-1">
              <div className="text-sm text-text">
                {bankLabel} · {importDetail.rowCount} transactions
              </div>
              <div className="text-xs text-text-secondary">{importDetail.message}</div>
            </div>
          )}
          {importSkipped && (
            <div className="space-y-1">
              <div className="text-sm text-text-secondary">Statement already imported</div>
              <div className="text-xs text-text-muted">{importDetail.message}</div>
            </div>
          )}
        </TraceNode>

        <TraceNode id="embed" node={nodes.embed} tick={now}>
          {nodes.embed.state === 'done' && embedDetail?.matches && (
            <div className="space-y-1">
              <div className="text-xs text-text-muted mb-1">
                {embedDetail.matches.length} descriptions matched against known merchants — click a row to
                re-predict it
              </div>
              <div className="max-h-64 overflow-y-auto border border-border-muted rounded">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-surface-raised">
                    <tr className="text-text-muted text-left">
                      <th className="px-2 py-1.5 font-medium">Description</th>
                      <th className="px-2 py-1.5 font-medium">Matched merchant</th>
                      <th className="px-2 py-1.5 font-medium">Category</th>
                      <th className="px-2 py-1.5 font-medium text-right">Score</th>
                    </tr>
                  </thead>
                  <tbody>
                    {embedDetail.matches.map((m, i) => (
                      <tr
                        key={`${m.description}-${i}`}
                        onClick={() => void rerunPredict(m.description)}
                        className={`cursor-pointer hover:bg-surface ${predictingRow === m.description ? 'bg-surface' : ''}`}
                      >
                        <td className="px-2 py-1 text-text font-mono">{m.description}</td>
                        <td className="px-2 py-1 text-text-secondary">{m.label}</td>
                        <td className="px-2 py-1 text-text-secondary">{m.category}</td>
                        <td className="px-2 py-1 text-text-muted text-right font-mono">{m.score.toFixed(3)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </TraceNode>

        <TraceNode id="predict" node={nodes.predict} tick={now}>
          {nodes.predict.state === 'done' && predictDetail?.category && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-mono text-text">{predictDetail.description}</span>
              <span className="text-text-muted">→</span>
              <span className="text-sm font-medium text-green">{predictDetail.category}</span>
              <span className="text-xs text-text-muted font-mono">
                similarity {predictDetail.confidence?.toFixed(3)}
              </span>
              <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-surface text-text-muted border border-border">
                prediction only — nothing written
              </span>
            </div>
          )}
        </TraceNode>

        <TraceNode id="reconcile" node={nodes.reconcile} tick={now} last>
          {nodes.reconcile.state === 'done' && reconcileDetail && (
            <div className="space-y-2">
              {(reconcileDetail.duplicates ?? []).map((d, i) => (
                <div key={`dup-${i}`} className="bg-surface-raised border border-yellow/40 rounded-lg p-3">
                  <div className="text-xs uppercase tracking-wide text-yellow font-medium mb-1">Possible duplicate</div>
                  <div className="text-sm text-text">
                    {d.transactions[0].description} — {fmtUsd(d.transactions[0].amount)} on{' '}
                    {d.transactions
                      .map((t) => t.date)
                      .sort()
                      .join(' and ')}
                  </div>
                  <div className="text-xs text-text-muted mt-1">{d.message}</div>
                </div>
              ))}
              {(reconcileDetail.spikes ?? []).map((s, i) => (
                <div key={`spike-${i}`} className="bg-surface-raised border border-red/40 rounded-lg p-3">
                  <div className="text-xs uppercase tracking-wide text-red font-medium mb-1">Spending spike</div>
                  <div className="text-xs text-text-secondary">{s.message}</div>
                </div>
              ))}
              {(reconcileDetail.duplicates ?? []).length === 0 && (reconcileDetail.spikes ?? []).length === 0 && (
                <div className="text-xs text-text-muted">No duplicates or spikes found in the imported rows.</div>
              )}
            </div>
          )}
        </TraceNode>
      </div>

      {totalMs !== null && (
        <div className="text-xs text-text-muted font-mono">chain total {totalMs} ms — all local, no cloud</div>
      )}
    </div>
  );
}

// ── Flow-diagram node ───────────────────────────────────────────────────────

function TraceNode(props: {
  id: TraceStepId;
  node: NodeUi;
  tick: number;
  last?: boolean;
  children?: React.ReactNode;
}) {
  const { id, node, tick, last, children } = props;
  const running = node.state === 'running';

  const icon =
    node.state === 'done' ? '✓' : node.state === 'error' ? '✕' : node.state === 'skipped' ? '–' : '';

  const circleStyle: React.CSSProperties =
    node.state === 'done' ? { borderColor: 'var(--color-green)', color: 'var(--color-green)' }
    : node.state === 'error' ? { borderColor: 'var(--color-red)', color: 'var(--color-red)' }
    : node.state === 'skipped' ? { borderColor: 'var(--color-border)', color: 'var(--color-text-muted)' }
    : running
      ? { borderColor: 'var(--color-green)', color: 'var(--color-green)', boxShadow: '0 0 0 3px rgba(34,197,94,0.15)' }
      : { borderColor: 'var(--color-border)', color: 'var(--color-text-muted)' };

  const titleColor = node.state === 'pending' || node.state === 'skipped' ? 'text-text-muted' : 'text-text';

  return (
    <div className="flex gap-3">
      <div className="flex flex-col items-center">
        <div
          className={`w-7 h-7 shrink-0 rounded-full border-2 flex items-center justify-center text-sm font-medium ${running ? 'animate-pulse' : ''}`}
          style={circleStyle}
        >
          {icon}
        </div>
        {!last && <div className="w-px flex-1 min-h-6 bg-border" />}
      </div>
      <div className={`flex-1 ${last ? '' : 'pb-5'}`}>
        <div className="flex items-center gap-2 flex-wrap">
          <span className={`text-sm font-medium ${titleColor}`}>{STEP_LABELS[id]}</span>
          {node.state === 'done' && node.durationMs !== undefined && (
            <span className="text-xs font-mono text-green">{node.durationMs} ms</span>
          )}
          {running && <span className="text-xs font-mono text-text-muted">{Math.max(0, Math.round(tick))} ms</span>}
          {node.state === 'skipped' && (
            <span className="text-xs text-text-muted" title={node.error}>
              skipped{node.error ? ` — ${node.error}` : ''}
            </span>
          )}
          {node.state === 'error' && node.error && <span className="text-xs text-red font-mono">{node.error}</span>}
        </div>
        {node.state !== 'pending' && children}
      </div>
    </div>
  );
}