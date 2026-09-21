import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/api';
import { useApi } from '@/hooks/useApi';
import {
  parseStatementContent,
  sha256Hex,
  canCommitImport,
  type ParsedStatement,
} from '@import-tools/client-import';
import {
  AUTOBOOK_TOOL,
  AUTOBOOK_COPY,
  AUTOBOOK_CONFIRM_WINDOW_MS,
  AUTOBOOK_POLL_INTERVAL_MS,
  pickGrant,
  phaseFor,
} from './auto-book';
import { WILSON_MCP_SESSION_KEY, WILSON_OPEN_AGENT_PANEL_EVENT } from '@webmcp-session';

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

type NodeState = 'pending' | 'running' | 'done' | 'skipped' | 'error' | 'denied';

/** Diagram nodes: the four timed chain steps plus the untimed auto-book beat. */
type DiagramNodeId = TraceStepId | 'autobook';

interface NodeUi {
  state: NodeState;
  /** The server-measured duration — the only number a settled node displays. */
  durationMs?: number;
  error?: string;
}

const STEP_LABELS: Record<DiagramNodeId, string> = {
  import: 'Import',
  embed: 'Embedding lookup',
  predict: 'Category prediction',
  reconcile: 'Reconciliation hint',
  autobook: 'Auto-book',
};

/** One candidate row the server resolved for the predicted description (mirror of src/demo/auto-book.ts). */
interface AutoBookCandidate {
  id: number;
  date: string;
  description: string;
  amount: number;
  category: string | null;
}

/**
 * Auto-book beat state. The confirmation itself never lives here: `awaiting`
 * means the bridge's confirmation card is the only approve/deny surface.
 */
type AutoBookUi =
  | { phase: 'pending' }
  | { phase: 'needs-grant'; note?: string }
  | { phase: 'choose'; candidates: AutoBookCandidate[] }
  | { phase: 'awaiting'; operationId: string; summary: string | null; timedOut?: boolean }
  | { phase: 'booked'; summary: string | null; description: string }
  | { phase: 'denied' }
  | { phase: 'stale' }
  | { phase: 'error'; message: string };

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

/** Numeric status from the api() helper's `API <status>: <body>` errors, when parseable. */
function httpStatusFrom(err: unknown): number | null {
  if (!(err instanceof Error)) return null;
  const m = err.message.match(/^API (\d{3}):/);
  return m ? Number(m[1]) : null;
}

/**
 * Per-tab agent-session id — same create-if-absent rule as the bridge reads
 * (sessionStorage is per-tab, so two tabs never share grants).
 */
function ensureSessionGeneration(): string {
  let id = sessionStorage.getItem(WILSON_MCP_SESSION_KEY);
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem(WILSON_MCP_SESSION_KEY, id);
  }
  return id;
}

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
  const [autoBook, setAutoBook] = useState<AutoBookUi>({ phase: 'pending' });
  const [bookedRow, setBookedRow] = useState<{ description: string; summary: string | null } | null>(null);
  const autoBookBusyRef = useRef(false);
  const predictDescriptionRef = useRef<string | null>(null);
  const importDetailRef = useRef<TraceStepResponse['detail'] | null>(null);

  // The auto-book driver reads the import detail through a ref so the
  // callback graph stays stable across re-renders.
  useEffect(() => {
    importDetailRef.current = importDetail;
  }, [importDetail]);

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
    setAutoBook({ phase: 'pending' });
    setBookedRow(null);
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
      setAutoBook({ phase: 'pending' });
      setBookedRow(null);
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

  // ── Auto-book (the visible confirmation gate — never a silent write) ──────
  //
  // Everything here rides the dashboard's WebMCP tool-gate substrate
  // (spec-50): the attendee opts the tab's agent session in via the Agent
  // access panel (zero tools exposed by default, revocable any time), the
  // booking is PREPARED through /api/mcp/prepare, and the write lands only
  // when the human approves the bridge's confirmation card. Denying — or
  // never approving — leaves the data untouched. This section never renders
  // its own approve/deny buttons and never calls a write route directly.

  /** Fresh grant check: the exposed-tools list for THIS tab. */
  const fetchExposedGrant = useCallback(async (): Promise<string | null> => {
    const sessionGeneration = ensureSessionGeneration();
    const res = await api<{ tools: Array<{ name: string; grantId: string }> }>(
      `/api/mcp/tools?sessionGeneration=${encodeURIComponent(sessionGeneration)}`,
    );
    return pickGrant(res.tools);
  }, []);

  /** Wait (bounded) for the attendee to opt in through the Agent access panel. */
  const awaitGrantOptIn = useCallback(async (): Promise<string | null> => {
    window.dispatchEvent(new CustomEvent(WILSON_OPEN_AGENT_PANEL_EVENT));
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1500));
      const grantId = await fetchExposedGrant();
      if (grantId) return grantId;
    }
    return null;
  }, [fetchExposedGrant]);

  /** Poll the prepared operation until it resolves (or the window elapses — still not a failure). */
  const awaitOperation = useCallback(
    async (runId: number, operationId: string, summary: string | null, description: string) => {
      const deadline = Date.now() + AUTOBOOK_CONFIRM_WINDOW_MS;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, AUTOBOOK_POLL_INTERVAL_MS));
        if (runIdRef.current !== runId) return;
        try {
          const res = await api<{ operation: { status: string } }>(`/api/mcp/operations/${operationId}`);
          const op = res.operation;
          if (op.status !== 'pending') {
            const phase = phaseFor(op);
            if (phase === 'booked') {
              setAutoBook({ phase: 'booked', summary, description });
              setBookedRow({ description, summary });
            } else if (phase === 'denied') {
              setAutoBook({ phase: 'denied' });
            } else if (phase === 'stale') {
              setAutoBook({ phase: 'stale' });
            } else {
              setAutoBook({ phase: 'error', message: AUTOBOOK_COPY.error });
            }
            return;
          }
        } catch {
          // Transport hiccup mid-poll: the row is durable server-side — keep polling.
        }
      }
      // Window elapsed with the card still pending: honest state, not an error —
      // the card is still open and approving it still commits through the substrate.
      setAutoBook((prev) => (prev.phase === 'awaiting' ? { ...prev, timedOut: true } : prev));
    },
    [],
  );

  /** Prepare the booking for one candidate row through /api/mcp/prepare — no write happens here. */
  const prepareBooking = useCallback(
    async (runId: number, grantId: string, transactionId: number, category: string) => {
      const description = predictDescriptionRef.current ?? '';
      const sessionGeneration = ensureSessionGeneration();
      try {
        const res = await api<{ operation: { id: string; status: string; summary: string | null } }>(
          '/api/mcp/prepare',
          {
            method: 'POST',
            body: JSON.stringify({
              sessionGeneration,
              grantId,
              tool: AUTOBOOK_TOOL,
              args: { id: transactionId, category },
            }),
          },
        );
        if (runIdRef.current !== runId) return;
        const op = res.operation;
        setAutoBook({ phase: 'awaiting', operationId: op.id, summary: op.summary });
        await awaitOperation(runId, op.id, op.summary, description);
      } catch (err) {
        if (runIdRef.current !== runId) return;
        // Un-gated (no/revoked/foreign grant, viewer) → back to the opt-in beat,
        // with the server's reason. Nothing was prepared and nothing was written.
        if (httpStatusFrom(err) === 403) {
          setAutoBook({ phase: 'needs-grant', note: traceErrorFrom(err) });
          return;
        }
        setAutoBook({ phase: 'error', message: traceErrorFrom(err) });
      }
    },
    [awaitOperation],
  );

  /** Entry point: the "Auto-book this" tap on the predict card. */
  const startAutoBook = useCallback(
    async (description: string, category: string) => {
      if (autoBookBusyRef.current) return; // one auto-book in flight per section
      autoBookBusyRef.current = true;
      const runId = runIdRef.current;
      predictDescriptionRef.current = description;
      try {
        setAutoBook({ phase: 'needs-grant' });
        setBookedRow(null);

        // 1. Gate: the exposed-tools list starts empty — the attendee opts in.
        let grantId = await fetchExposedGrant();
        if (runIdRef.current !== runId) return;
        if (!grantId) {
          grantId = await awaitGrantOptIn();
          if (runIdRef.current !== runId) return;
          if (!grantId) return; // still zero tools exposed — node keeps the opt-in copy
        }

        // 2. Which transaction? Server truth among the freshly imported rows.
        const importedIds = importDetailRef.current?.importedIds ?? [];
        if (importedIds.length === 0) {
          setAutoBook({ phase: 'error', message: AUTOBOOK_COPY.noImportedRows });
          return;
        }
        const candRes = await api<{ candidates: AutoBookCandidate[] }>('/api/demo/autobook/candidates', {
          method: 'POST',
          body: JSON.stringify({ description, importedIds }),
        });
        if (runIdRef.current !== runId) return;
        const candidates = candRes.candidates;
        if (candidates.length === 0) {
          setAutoBook({ phase: 'error', message: AUTOBOOK_COPY.noCandidates });
          return;
        }
        if (candidates.length > 1) {
          setAutoBook({ phase: 'choose', candidates });
          return; // the attendee picks one; chooseCandidate continues
        }
        await prepareBooking(runId, grantId, candidates[0].id, category);
      } catch (err) {
        if (runIdRef.current !== runId) return;
        setAutoBook({ phase: 'error', message: traceErrorFrom(err) });
      } finally {
        autoBookBusyRef.current = false;
      }
    },
    [fetchExposedGrant, awaitGrantOptIn, prepareBooking],
  );

  /** Continuation after the attendee picks one of several matching rows. */
  const chooseCandidate = useCallback(
    async (candidate: AutoBookCandidate) => {
      if (!predictDetail?.category || autoBookBusyRef.current) return;
      autoBookBusyRef.current = true;
      const runId = runIdRef.current;
      try {
        const grantId = await fetchExposedGrant();
        if (runIdRef.current !== runId) return;
        if (!grantId) {
          setAutoBook({ phase: 'needs-grant' });
          return;
        }
        await prepareBooking(runId, grantId, candidate.id, predictDetail.category);
      } catch (err) {
        if (runIdRef.current === runId) setAutoBook({ phase: 'error', message: traceErrorFrom(err) });
      } finally {
        autoBookBusyRef.current = false;
      }
    },
    [predictDetail, prepareBooking],
  );

  const bankLabel =
    parsed && parsed.bank && parsed.format
      ? `${parsed.bank.toUpperCase()} ${parsed.format.toUpperCase()}`
      : '';
  const importOk = nodes.import.state === 'done' && importDetail;
  const importSkipped = nodes.import.state === 'skipped' && importDetail;

  // The auto-book node is untimed — its state comes from the beat's phase,
  // never from a server-measured duration.
  const autoBookNodeUi: NodeUi = (() => {
    switch (autoBook.phase) {
      case 'pending':
        return { state: 'pending' };
      case 'needs-grant':
      case 'choose':
      case 'awaiting':
        return { state: 'running' };
      case 'booked':
        return { state: 'done' };
      case 'denied':
      case 'stale':
        return { state: 'denied' };
      case 'error':
        return { state: 'error', error: autoBook.message };
    }
  })();

  const autoBookAvailable =
    mayCommit && nodes.predict.state === 'done' && !!predictDetail?.description && !!predictDetail?.category;
  const autoBookInFlight =
    autoBook.phase === 'needs-grant' || autoBook.phase === 'choose' || autoBook.phase === 'awaiting';

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
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-mono text-text">{predictDetail.description}</span>
                <span className="text-text-muted">→</span>
                <span className="text-sm font-medium text-green">{predictDetail.category}</span>
                <span className="text-xs text-text-muted font-mono">
                  similarity {predictDetail.confidence?.toFixed(3)}
                </span>
                {bookedRow?.description === predictDetail.description ? (
                  <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-surface text-green border border-green/40">
                    booked — category written
                  </span>
                ) : (
                  <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-surface text-text-muted border border-border">
                    prediction only — nothing written
                  </span>
                )}
              </div>
              {autoBookAvailable && (
                <div>
                  <button
                    type="button"
                    disabled={autoBookInFlight}
                    onClick={() => void startAutoBook(predictDetail.description!, predictDetail.category!)}
                    className="text-xs px-2.5 py-1 rounded border border-border bg-surface-raised text-text hover:border-green hover:text-green disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:border-border disabled:hover:text-text"
                  >
                    Auto-book this
                  </button>
                  <span className="text-[10px] text-text-muted ml-2">
                    books it through the confirmation gate — nothing written until you approve
                  </span>
                </div>
              )}
            </div>
          )}
        </TraceNode>

        <TraceNode id="reconcile" node={nodes.reconcile} tick={now}>
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

        {/* Auto-book beat — additive to the timed chain; runs only through the
            WebMCP confirmation gate. The card (bridge-rendered) is the single
            approve/deny surface; this node shows the state, never buttons. */}
        <TraceNode id="autobook" node={autoBookNodeUi} tick={now} last>
          {autoBook.phase === 'needs-grant' && (
            <div className="space-y-2">
              <div className="text-sm text-text-secondary">{AUTOBOOK_COPY.needsGrant}</div>
              {autoBook.note && <div className="text-xs text-red font-mono">{autoBook.note}</div>}
              <button
                type="button"
                onClick={() => window.dispatchEvent(new CustomEvent(WILSON_OPEN_AGENT_PANEL_EVENT))}
                className="text-xs px-2.5 py-1 rounded border border-border bg-surface-raised text-text hover:border-green hover:text-green"
              >
                Open Agent access
              </button>
              <div className="text-xs text-text-muted">
                Default is zero tools exposed. Granting shows exactly which tools this tab's agent session has, and
                you can revoke at any time — every booking still waits for the confirmation card.
              </div>
            </div>
          )}
          {autoBook.phase === 'choose' && (
            <div className="space-y-2">
              <div className="text-sm text-text-secondary">
                {autoBook.candidates.length} transactions match — pick the one to book
              </div>
              <div className="space-y-1">
                {autoBook.candidates.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => void chooseCandidate(c)}
                    className="w-full text-left text-xs px-2.5 py-1.5 rounded border border-border bg-surface-raised text-text hover:border-green"
                  >
                    <span className="font-mono">{c.date}</span> · {fmtUsd(c.amount)} ·{' '}
                    <span className="font-mono">{c.description}</span> · current category:{' '}
                    <span>{c.category ?? '—'}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          {autoBook.phase === 'awaiting' && (
            <div className="space-y-1">
              <div className="text-sm text-text-secondary">
                {autoBook.timedOut ? AUTOBOOK_COPY.stillAwaiting : AUTOBOOK_COPY.awaiting}
              </div>
              {autoBook.summary && <div className="text-xs text-text-muted font-mono">{autoBook.summary}</div>}
              <div className="text-xs text-text-muted">No confirmation, no write — the row stays untouched.</div>
            </div>
          )}
          {autoBook.phase === 'booked' && (
            <div className="space-y-1">
              <div className="text-sm text-green">{AUTOBOOK_COPY.booked}</div>
              {autoBook.summary && <div className="text-xs text-text-muted font-mono">{autoBook.summary}</div>}
            </div>
          )}
          {autoBook.phase === 'denied' && (
            <div className="text-sm text-text-secondary">{AUTOBOOK_COPY.denied}</div>
          )}
          {autoBook.phase === 'stale' && (
            <div className="text-sm text-text-secondary">{AUTOBOOK_COPY.stale}</div>
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
  id: DiagramNodeId;
  node: NodeUi;
  tick: number;
  last?: boolean;
  children?: React.ReactNode;
}) {
  const { id, node, tick, last, children } = props;
  const running = node.state === 'running';

  const icon =
    node.state === 'done' ? '✓' : node.state === 'error' ? '✕' : node.state === 'skipped' || node.state === 'denied' ? '–' : '';

  const circleStyle: React.CSSProperties =
    node.state === 'done' ? { borderColor: 'var(--color-green)', color: 'var(--color-green)' }
    : node.state === 'error' ? { borderColor: 'var(--color-red)', color: 'var(--color-red)' }
    : node.state === 'skipped' ? { borderColor: 'var(--color-border)', color: 'var(--color-text-muted)' }
    : node.state === 'denied' ? { borderColor: 'var(--color-yellow, #d4a017)', color: 'var(--color-yellow, #d4a017)' }
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