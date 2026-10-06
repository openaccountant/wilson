import { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { useApi } from '@/hooks/useApi';
import { api } from '@/api';
import { Dialog } from '@/components/Dialog';
import { useWebMcpPageTools } from '@/agent/useWebMcpPageTools';
import { usePageContext } from '@/agent/WebMcpProvider';
import { pageError, pollUntil } from '@webmcp-page-tools';
import {
  AGENT_LABEL_NOTICE,
  BLIND_NOTICE,
  INITIAL_BLIND_STATE,
  annotateBody,
  isAgentPresentLabel,
  labelPrefill,
  labelsHidden,
  nextBlindState,
  withoutHumanLabels,
  type BlindState,
} from '@judge-ui';
import { JudgeQueue } from '@/components/judge/JudgeQueue';
import { JudgementHistory } from '@/components/judge/JudgementHistory';
import { ExportOptions } from '@/components/judge/ExportOptions';
import { JudgeInteractionForm } from '@/components/judge/JudgeInteractionForm';
import { agentErrorMessage } from '@/lib/agent-api';
import { parseDbTimestamp } from '@/format';
import type { InteractionRow, AnnotationStats, AnnotationVersion, JudgementRow, TraceRow, TraceStats } from '@/types';

type SubTab = 'traces' | 'training' | 'judge';

interface AuthStatus {
  authEnabled: boolean;
  user: { id: number; username: string; role: string } | null;
}

interface InteractionDetail extends InteractionRow {
  system_prompt: string | null;
  user_prompt: string;
  response_content: string | null;
  tool_calls_json: string | null;
  toolResults: { tool_name: string; tool_result: string | null }[];
  annotations: { rating: number | null; preference: string | null; pair_id: string | null; notes: string | null }[];
  /** The current human annotation, every human version (newest first), and the judge rows. */
  annotation?: AnnotationVersion | null;
  history?: AnnotationVersion[];
  judgements?: JudgementRow[];
  /** The prompt carries the browser subagent's on-device notes block. */
  handoff?: boolean;
}

function fmtNum(n: number): string {
  return n.toLocaleString();
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function fmtTime(timestamp: string): string {
  const d = parseDbTimestamp(timestamp);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function StarRating({ rating, onRate }: { rating: number | null; onRate: (r: number) => void }) {
  return (
    <span className="inline-flex gap-0.5">
      {[1, 2, 3, 4, 5].map((star) => (
        <button
          key={star}
          onClick={(e) => { e.stopPropagation(); onRate(star); }}
          className={`text-sm cursor-pointer hover:opacity-80 transition-opacity ${
            rating !== null && star <= rating ? 'text-green' : 'text-text-muted'
          }`}
          title={`Rate ${star}`}
        >
          {rating !== null && star <= rating ? '\u2605' : '\u2606'}
        </button>
      ))}
    </span>
  );
}

function DetailSection({ title, content }: { title: string; content: string | null | undefined }) {
  return (
    <div className="space-y-1">
      <div className="text-xs text-text-muted uppercase tracking-wide font-medium">{title}</div>
      <pre className="bg-surface border border-border rounded p-3 text-xs text-text-secondary font-mono whitespace-pre-wrap overflow-x-auto max-h-[300px] overflow-y-auto">
        {content || '(empty)'}
      </pre>
    </div>
  );
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="bg-surface-raised border border-border rounded-lg p-4">
      <div className="text-xs text-text-secondary uppercase tracking-wide">{label}</div>
      <div className="text-2xl font-bold font-mono text-text mt-1">{value}</div>
      {sub && <div className="text-xs text-text-muted mt-1">{sub}</div>}
    </div>
  );
}

/* ── Traces sub-tab ── */

function TracesContent() {
  const { data: traces, loading: tracesLoading } = useApi<TraceRow[]>('/api/traces?limit=100');
  const { data: stats, loading: statsLoading } = useApi<TraceStats>('/api/traces/stats');

  const loading = tracesLoading || statsLoading;

  if (loading) {
    return (
      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="shrink-0 p-6 pb-0 space-y-4">
          <div className="grid grid-cols-4 gap-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="bg-surface-raised border border-border rounded-lg p-4">
                <div className="h-[52px] animate-pulse bg-border-muted rounded" />
              </div>
            ))}
          </div>
        </div>
        <div className="flex-1 overflow-y-auto px-6 py-4 min-h-0">
          <div className="bg-surface-raised border border-border rounded-lg p-4">
            <div className="h-[200px] animate-pulse bg-border-muted rounded" />
          </div>
        </div>
      </div>
    );
  }

  const successRate = stats && stats.totalCalls > 0
    ? ((stats.successfulCalls / stats.totalCalls) * 100).toFixed(1)
    : '0';

  const modelEntries = stats?.byModel ? Object.entries(stats.byModel) : [];

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Fixed stat cards + model breakdown */}
      <div className="shrink-0 p-6 pb-0 space-y-4">
        <div className="grid grid-cols-4 gap-4">
          <StatCard label="Total Calls" value={fmtNum(stats?.totalCalls ?? 0)} sub={`${fmtNum(stats?.errorCalls ?? 0)} errors`} />
          <StatCard label="Success Rate" value={`${successRate}%`} sub={`${fmtNum(stats?.successfulCalls ?? 0)} successful`} />
          <StatCard label="Total Tokens" value={fmtNum(stats?.totalTokens ?? 0)} />
          <StatCard label="Avg Duration" value={fmtDuration(stats?.avgDurationMs ?? 0)} sub={`${fmtDuration(stats?.totalDurationMs ?? 0)} total`} />
        </div>

        {modelEntries.length > 0 && (
          <div className="bg-surface-raised border border-border rounded-lg p-4">
            <h3 className="text-xs text-text-secondary uppercase tracking-wide mb-3">By Model</h3>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-text-muted text-xs uppercase tracking-wide border-b border-border">
                  <th className="text-left py-2 font-medium">Model</th>
                  <th className="text-right py-2 font-medium">Calls</th>
                  <th className="text-right py-2 font-medium">Tokens</th>
                  <th className="text-right py-2 font-medium">Avg Duration</th>
                </tr>
              </thead>
              <tbody>
                {modelEntries.map(([model, info]) => (
                  <tr key={model} className="border-b border-border/50">
                    <td className="py-2 text-text font-mono text-xs">{model}</td>
                    <td className="py-2 text-right text-text font-mono">{fmtNum(info.calls)}</td>
                    <td className="py-2 text-right text-text font-mono">{fmtNum(info.tokens)}</td>
                    <td className="py-2 text-right text-text font-mono">{fmtDuration(info.avgMs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Scrollable trace table */}
      <div className="flex-1 overflow-y-auto px-6 py-4 min-h-0">
        <div className="bg-surface-raised border border-border rounded-lg p-4">
          <h3 className="text-xs text-text-secondary uppercase tracking-wide mb-3">Recent Traces</h3>
          {!traces || traces.length === 0 ? (
            <p className="text-sm text-text-muted">No traces recorded yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-surface-raised z-10">
                  <tr className="text-text-muted text-xs uppercase tracking-wide border-b border-border">
                    <th className="text-left py-2 font-medium">Time</th>
                    <th className="text-left py-2 font-medium">Model</th>
                    <th className="text-right py-2 font-medium">Tokens In</th>
                    <th className="text-right py-2 font-medium">Tokens Out</th>
                    <th className="text-right py-2 font-medium">Duration</th>
                    <th className="text-center py-2 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {[...traces].reverse().map((trace) => (
                    <tr key={trace.id} className="border-b border-border/50 hover:bg-border-muted/20">
                      <td className="py-2 text-text-muted text-xs whitespace-nowrap">{fmtTime(trace.timestamp)}</td>
                      <td className="py-2 text-text font-mono text-xs">{trace.model}</td>
                      <td className="py-2 text-right text-text font-mono">{fmtNum(trace.inputTokens)}</td>
                      <td className="py-2 text-right text-text font-mono">{fmtNum(trace.outputTokens)}</td>
                      <td className="py-2 text-right text-text font-mono">{fmtDuration(trace.durationMs)}</td>
                      <td className="py-2 text-center">
                        {trace.status === 'ok' ? (
                          <span className="inline-block w-2 h-2 rounded-full bg-green" title="OK" />
                        ) : (
                          <span className="inline-block w-2 h-2 rounded-full bg-red cursor-help" title={trace.error ?? 'Error'} />
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Training sub-tab ── */

/**
 * A request to open one interaction's detail panel. The nonce makes asking again for the same id count.
 * `byAgent` is true for `open_interaction` and false for a person following a link: an agent-opened panel keeps
 * the human's labels out until a person interacts with it (the blind rule, see `@judge-ui`).
 */
type OpenRequest = { id: number; nonce: number; byAgent: boolean };

function TrainingContent({
  openRequest,
  onRequestHandled,
  onOpened,
  version,
  onJudgementsChanged,
}: {
  openRequest: OpenRequest | null;
  onRequestHandled: () => void;
  onOpened: (id: number | null) => void;
  /** Bumped when the judge queue changed something, so the stats and the list refetch. */
  version: number;
  onJudgementsChanged: () => void;
}) {
  const [callTypeFilter, setCallTypeFilter] = useState('');
  const [modelFilter, setModelFilter] = useState('');
  const [ratingFilter, setRatingFilter] = useState('');
  const [annotatedFilter, setAnnotatedFilter] = useState('');
  const [judgedFilter, setJudgedFilter] = useState('');
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [blind, setBlind] = useState<BlindState>(INITIAL_BLIND_STATE);
  const [revealError, setRevealError] = useState('');
  const [detail, setDetail] = useState<InteractionDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [preference, setPreference] = useState('');
  const [pairId, setPairId] = useState('');
  const [notes, setNotes] = useState('');
  const [detailRating, setDetailRating] = useState(0);
  const [saving, setSaving] = useState(false);

  const queryParams = useMemo(() => {
    const params = new URLSearchParams();
    params.set('limit', '100');
    params.set('offset', '0');
    if (callTypeFilter) params.set('callType', callTypeFilter);
    if (modelFilter) params.set('model', modelFilter);
    if (ratingFilter) params.set('rating', ratingFilter);
    if (annotatedFilter) params.set('annotated', annotatedFilter);
    if (judgedFilter) params.set('judged', judgedFilter);
    return params.toString();
  }, [callTypeFilter, modelFilter, ratingFilter, annotatedFilter, judgedFilter]);

  const {
    data: interactions,
    loading: interactionsLoading,
    error: interactionsError,
    refetch: refetchInteractions,
  } = useApi<InteractionRow[]>(`/api/interactions?${queryParams}`, [queryParams, version]);

  const {
    data: stats,
    loading: statsLoading,
    error: statsError,
    refetch: refetchStats,
  } = useApi<AnnotationStats>('/api/annotations/stats', [version]);

  const callTypes = useMemo(() => {
    if (!interactions) return [];
    const set = new Set<string>();
    for (const row of interactions) if (row.call_type) set.add(row.call_type);
    return Array.from(set).sort();
  }, [interactions]);

  const models = useMemo(() => {
    if (!interactions) return [];
    const set = new Set<string>();
    for (const row of interactions) if (row.model) set.add(row.model);
    return Array.from(set).sort();
  }, [interactions]);

  async function handleRate(id: number, rating: number) {
    try {
      await api<{ annotation: unknown }>(`/api/interactions/${id}/annotate`, {
        method: 'POST',
        body: JSON.stringify({ rating }),
      });
      refetchInteractions();
      refetchStats();
    } catch { /* silently fail */ }
  }

  function closeDetail() {
    setSelectedId(null);
    setDetail(null);
    setBlind((b) => nextBlindState(b, { type: 'close' }));
    setRevealError('');
  }

  /** Put a loaded detail on screen and into the human controls. With labels hidden it holds no human label at all. */
  function showDetail(data: InteractionDetail, hidden: boolean, keepTyped = false) {
    // Masked BEFORE it reaches state: a hidden label is not merely unrendered, it is not in the page's memory.
    const shown = hidden ? withoutHumanLabels(data) : data;
    setDetail(shown);
    // An agent-written label is not prefilled as the person's own (see `labelPrefill`).
    const form = labelPrefill(shown.annotation);
    // When labels arrive after a person already started typing, what they typed wins over what is stored.
    const fill = <T,>(set: (fn: (cur: T) => T) => void, empty: T, stored: T) => set((cur) => (keepTyped && cur !== empty ? cur : stored));
    fill(setDetailRating, 0, form.rating);
    fill(setPreference, '', form.preference);
    fill(setPairId, '', form.pairId);
    fill(setNotes, '', form.notes);
  }

  async function loadDetail(id: number, byAgent: boolean) {
    const state = nextBlindState(blind, { type: 'open', byAgent });
    setBlind(state);
    setRevealError('');
    setSelectedId(id);
    setDetail(null);
    setDetailLoading(true);
    try {
      const data = await api<InteractionDetail>(`/api/interactions/${id}`);
      showDetail(data, labelsHidden(state));
    } catch {
      // Close dialog on error
      setSelectedId(null);
      setDetail(null);
      setBlind(INITIAL_BLIND_STATE);
    } finally {
      setDetailLoading(false);
    }
  }

  /** A person interacted with an agent-opened panel: only now are the human's labels fetched into it. */
  async function revealLabels(id: number) {
    try {
      const data = await api<InteractionDetail>(`/api/interactions/${id}`);
      showDetail(data, false, true);
    } catch (err) {
      setRevealError(agentErrorMessage(err));
    }
  }

  /** Pointer and key events inside the panel. Only a trusted one (a real click or key press) counts as a person. */
  function handlePanelInteract(e: { nativeEvent: { isTrusted: boolean } }) {
    if (!labelsHidden(blind) || selectedId === null) return;
    const next = nextBlindState(blind, { type: 'interact', isTrusted: e.nativeEvent.isTrusted });
    if (next === blind) return;
    setBlind(next);
    void revealLabels(selectedId);
  }

  async function refreshDetail() {
    if (selectedId === null) return;
    try {
      showDetail(await api<InteractionDetail>(`/api/interactions/${selectedId}`), labelsHidden(blind));
    } catch {
      // The panel keeps what it has.
    }
  }

  async function handleRevoke(judgementId: number) {
    try {
      await api(`/api/judgements/${judgementId}/revoke`, { method: 'POST' });
      await refreshDetail();
      onJudgementsChanged();
    } catch (err) {
      setRevealError(agentErrorMessage(err));
    }
  }

  // The tab above lifted "which interaction to show" so a page tool can drive it; open it when asked.
  const loadDetailRef = useRef(loadDetail);
  loadDetailRef.current = loadDetail;
  useEffect(() => {
    if (openRequest === null) return;
    void loadDetailRef.current(openRequest.id, openRequest.byAgent);
    // Consumed: leaving the Training sub-tab and coming back must not reopen it.
    onRequestHandled();
  }, [openRequest, onRequestHandled]);

  // Tell the tab which interaction is open, for `get_page_context`.
  useEffect(() => {
    onOpened(selectedId);
  }, [selectedId, onOpened]);

  async function handleSaveAnnotation() {
    if (!selectedId) return;
    setSaving(true);
    try {
      const body = annotateBody({ rating: detailRating, preference, pairId, notes }, detail?.annotation);
      // A save with nothing to write would be a 400: there is nothing to do but close.
      if (Object.keys(body).length === 0) {
        closeDetail();
        return;
      }
      await api<{ annotation: unknown }>(`/api/interactions/${selectedId}/annotate`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      refetchInteractions();
      refetchStats();
      closeDetail();
    } catch { /* silently fail */ }
    finally { setSaving(false); }
  }

  const loading = interactionsLoading || statsLoading;
  const error = interactionsError || statsError;
  const progressPercent =
    stats && stats.total > 0 ? Math.round((stats.annotated / stats.total) * 100) : 0;

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Fixed header: export buttons, stat cards, progress, filters */}
      <div className="shrink-0 p-6 pb-0 space-y-4">
        <div className="flex items-start justify-between gap-4">
          <ExportOptions handoffExcluded={stats?.handoffExcluded} />
          {interactions && (
            <span className="text-xs text-text-muted font-mono shrink-0">{interactions.length} interactions loaded</span>
          )}
        </div>

        {stats && (
          <>
            <div className="grid grid-cols-5 gap-4">
              <div className="bg-surface-raised border border-border rounded-lg p-4">
                <div className="text-xs text-text-muted uppercase tracking-wide mb-1">Total Interactions</div>
                <div className="text-2xl font-mono text-text">{fmtNum(stats.total)}</div>
              </div>
              <div className="bg-surface-raised border border-border rounded-lg p-4">
                <div className="text-xs text-text-muted uppercase tracking-wide mb-1">Annotated</div>
                <div className="text-2xl font-mono text-green">{fmtNum(stats.annotated)}</div>
              </div>
              <div className="bg-surface-raised border border-border rounded-lg p-4" title="Runs the default export writes, one line each">
                <div className="text-xs text-text-muted uppercase tracking-wide mb-1">SFT-ready runs</div>
                <div className="text-2xl font-mono text-text">{fmtNum(stats.sftReady)}</div>
              </div>
              <div className="bg-surface-raised border border-border rounded-lg p-4" title="Pairs with both a chosen and a rejected side">
                <div className="text-xs text-text-muted uppercase tracking-wide mb-1">Complete DPO pairs</div>
                <div className="text-2xl font-mono text-text">{fmtNum(stats.dpoPairs)}</div>
              </div>
              <div className="bg-surface-raised border border-border rounded-lg p-4" title="Judge proposals waiting for you / accepted by you">
                <div className="text-xs text-text-muted uppercase tracking-wide mb-1">Judge: proposed / accepted</div>
                <div className="text-2xl font-mono text-text">
                  {fmtNum(stats.judge?.proposed ?? 0)} <span className="text-text-muted">/</span> {fmtNum(stats.judge?.accepted ?? 0)}
                </div>
              </div>
            </div>

            <div className="bg-surface-raised border border-border rounded-lg p-4">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs text-text-secondary">Annotation Progress</span>
                <span className="text-xs font-mono text-text-muted">
                  {fmtNum(stats.annotated)} / {fmtNum(stats.total)} ({progressPercent}%)
                </span>
              </div>
              <div className="h-2 bg-border rounded-full overflow-hidden">
                <div className="h-full bg-green rounded-full transition-all" style={{ width: `${progressPercent}%` }} />
              </div>
            </div>
          </>
        )}

        <div className="flex gap-3">
          <select value={callTypeFilter} onChange={(e) => setCallTypeFilter(e.target.value)} className="bg-surface-raised border border-border rounded-md px-3 py-2 text-sm text-text focus:outline-none focus:border-green">
            <option value="">All Types</option>
            {callTypes.map((ct) => <option key={ct} value={ct}>{ct}</option>)}
          </select>
          <select value={modelFilter} onChange={(e) => setModelFilter(e.target.value)} className="bg-surface-raised border border-border rounded-md px-3 py-2 text-sm text-text focus:outline-none focus:border-green">
            <option value="">All Models</option>
            {models.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
          <select value={ratingFilter} onChange={(e) => setRatingFilter(e.target.value)} className="bg-surface-raised border border-border rounded-md px-3 py-2 text-sm text-text focus:outline-none focus:border-green">
            <option value="">All Ratings</option>
            {[1, 2, 3, 4, 5].map((r) => <option key={r} value={String(r)}>{r} Star{r > 1 ? 's' : ''}</option>)}
          </select>
          <select value={annotatedFilter} onChange={(e) => setAnnotatedFilter(e.target.value)} className="bg-surface-raised border border-border rounded-md px-3 py-2 text-sm text-text focus:outline-none focus:border-green">
            <option value="">All</option>
            <option value="true">Annotated</option>
            <option value="false">Unannotated</option>
          </select>
          <select value={judgedFilter} onChange={(e) => setJudgedFilter(e.target.value)} aria-label="Judge status" className="bg-surface-raised border border-border rounded-md px-3 py-2 text-sm text-text focus:outline-none focus:border-green">
            <option value="">Any judge status</option>
            <option value="proposed">Judge: proposed</option>
            <option value="accepted">Judge: accepted</option>
          </select>
        </div>
      </div>

      {/* Scrollable table area */}
      <div className="flex-1 overflow-y-auto px-6 py-4 min-h-0">
        {loading && (
          <div className="bg-surface-raised border border-border rounded-lg p-4">
            <div className="h-[300px] animate-pulse bg-border-muted rounded" />
          </div>
        )}

        {error && (
          <div className="bg-surface-raised border border-border rounded-lg p-4 text-red text-sm">
            Failed to load training data: {error}
          </div>
        )}

        {!loading && !error && interactions && interactions.length === 0 && (
          <div className="bg-surface-raised border border-border rounded-lg p-8 text-center">
            <p className="text-sm text-text-muted">No interactions found. Run some LLM calls to populate training data.</p>
          </div>
        )}

        {!loading && !error && interactions && interactions.length > 0 && (
          <div className="bg-surface-raised border border-border rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-surface-raised z-10">
                <tr className="border-b border-border text-text-secondary text-xs uppercase tracking-wide">
                  <th className="text-left px-4 py-3 font-medium">ID</th>
                  <th className="text-left px-4 py-3 font-medium">Type</th>
                  <th className="text-left px-4 py-3 font-medium">Model</th>
                  <th className="text-right px-4 py-3 font-medium">Tokens</th>
                  <th className="text-right px-4 py-3 font-medium">Duration</th>
                  <th className="text-left px-4 py-3 font-medium">Status</th>
                  <th className="text-left px-4 py-3 font-medium">Rating</th>
                  <th className="text-left px-4 py-3 font-medium">Judge</th>
                </tr>
              </thead>
              <tbody>
                {interactions.map((row) => (
                  <tr
                    key={row.id}
                    onClick={() => void loadDetail(row.id, false)}
                    className={`border-b border-border last:border-b-0 hover:bg-surface transition-colors cursor-pointer ${selectedId === row.id ? 'bg-surface' : ''}`}
                  >
                    <td className="px-4 py-3 font-mono text-xs text-text-secondary">{row.id}</td>
                    <td className="px-4 py-3 text-text">{row.call_type}</td>
                    <td className="px-4 py-3 text-text-secondary text-xs font-mono">{row.model}</td>
                    <td className="px-4 py-3 text-right font-mono text-xs text-text-secondary">{fmtNum(row.total_tokens)}</td>
                    <td className="px-4 py-3 text-right font-mono text-xs text-text-secondary">{fmtDuration(row.duration_ms)}</td>
                    <td className="px-4 py-3">
                      <span className={`text-xs font-mono ${row.status === 'ok' ? 'text-green' : 'text-red'}`}>{row.status}</span>
                    </td>
                    <td className="px-4 py-3">
                      <StarRating rating={row.rating} onRate={(r) => handleRate(row.id, r)} />
                      {row.annotation_via === 'dashboard_agent_present' && (
                        <span className="ml-2 text-[10px] uppercase tracking-wide font-medium px-1.5 py-0.5 rounded bg-yellow/15 text-yellow" title="Made while an agent had access: left out of the default export">
                          Agent present
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-xs font-mono text-text-muted">{row.judge_status ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Detail dialog */}
      <Dialog
        open={selectedId !== null}
        onClose={closeDetail}
        title={detail ? `Interaction #${detail.id} — ${detail.model}` : 'Loading...'}
        className="max-w-3xl"
        footer={detail && !detailLoading ? (
          <div className="space-y-3" onPointerDownCapture={handlePanelInteract} onKeyDownCapture={handlePanelInteract}>
            <div className="flex items-center justify-between">
              <div className="flex flex-wrap items-center gap-4">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-text-secondary">Rating:</span>
                  <StarRating rating={detailRating || null} onRate={setDetailRating} />
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-text-secondary">Preference:</span>
                  <select value={preference} onChange={(e) => setPreference(e.target.value)} className="bg-surface border border-border rounded px-2 py-1 text-xs text-text focus:outline-none focus:border-green">
                    <option value="">—</option>
                    <option value="chosen">Chosen</option>
                    <option value="rejected">Rejected</option>
                  </select>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-text-secondary">Pair ID:</span>
                  <input type="text" value={pairId} onChange={(e) => setPairId(e.target.value)} placeholder="DPO pair" className="bg-surface border border-border rounded px-2 py-1 text-xs text-text w-24 focus:outline-none focus:border-green" />
                </div>
              </div>
              <button onClick={handleSaveAnnotation} disabled={saving} className="bg-green-700 hover:bg-green-600 disabled:bg-green-900/40 disabled:text-text-muted text-white text-xs font-medium px-4 py-1.5 rounded transition-colors">
                {saving ? 'Saving...' : 'Save Annotation'}
              </button>
            </div>
            {/* An agent may judge from here; a person cannot submit it. Its own tool name; the human controls above carry none. */}
            <JudgeInteractionForm interactionId={detail.id} onSettled={() => { void refreshDetail(); onJudgementsChanged(); }} />
          </div>
        ) : undefined}
      >
        {detailLoading && <div className="h-[200px] animate-pulse bg-border-muted rounded" />}
        {detail && !detailLoading && (
          <div className="space-y-4" onPointerDownCapture={handlePanelInteract} onKeyDownCapture={handlePanelInteract}>
            {labelsHidden(blind) && (
              <div role="status" className="rounded border border-yellow/40 bg-yellow/10 px-3 py-2 text-xs text-yellow" data-testid="blind-notice">
                {BLIND_NOTICE}
              </div>
            )}
            {revealError && <div role="alert" className="text-xs text-red">{revealError}</div>}
            {isAgentPresentLabel(detail.annotation) && (
              <div role="note" className="rounded border border-yellow/40 bg-yellow/10 px-3 py-2 text-xs text-yellow" data-testid="agent-label-notice">
                <span className="mr-2 text-[10px] uppercase tracking-wide font-medium px-1.5 py-0.5 rounded bg-yellow/15">Agent present</span>
                {AGENT_LABEL_NOTICE}
              </div>
            )}
            {detail.handoff && (
              <div role="note" className="rounded border border-border bg-surface-raised px-3 py-2 text-xs text-text-secondary">
                This prompt contains untrusted on-device assistant notes. The default training export leaves it out.
              </div>
            )}
            <DetailSection title="System Prompt" content={detail.system_prompt} />
            <DetailSection title="User Prompt" content={detail.user_prompt} />
            <DetailSection title="Response" content={detail.response_content} />
            {detail.tool_calls_json && (
              <DetailSection title="Tool Calls" content={(() => { try { return JSON.stringify(JSON.parse(detail.tool_calls_json), null, 2); } catch { return detail.tool_calls_json; } })()} />
            )}
            {detail.toolResults && detail.toolResults.length > 0 && (
              <div className="space-y-2">
                {detail.toolResults.map((tr, i) => (
                  <DetailSection key={i} title={`Tool: ${tr.tool_name}`} content={tr.tool_result?.slice(0, 2000) ?? null} />
                ))}
              </div>
            )}
            <div className="space-y-1">
              <span className="text-xs text-text-secondary">Notes:</span>
              <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className="mt-1 w-full bg-surface border border-border rounded px-2 py-1 text-xs text-text focus:outline-none focus:border-green resize-none" />
            </div>
            <JudgementHistory
              history={detail.history ?? []}
              judgements={detail.judgements ?? []}
              canRevoke={true}
              onRevoke={(id) => void handleRevoke(id)}
            />
          </div>
        )}
      </Dialog>
    </div>
  );
}

/* ── Combined LLM Tab ── */

const SUB_TABS: { id: SubTab; label: string }[] = [
  { id: 'traces', label: 'Traces' },
  { id: 'training', label: 'Training' },
  { id: 'judge', label: 'Judge queue' },
];

export function LlmTab() {
  const [subTab, setSubTab] = useState<SubTab>('traces');
  const [openRequest, setOpenRequest] = useState<OpenRequest | null>(null);
  const [openedId, setOpenedId] = useState<number | null>(null);
  const [version, setVersion] = useState(0);
  const clearRequest = useCallback(() => setOpenRequest(null), []);
  const bumpVersion = useCallback(() => setVersion((v) => v + 1), []);
  const { data: authStatus } = useApi<AuthStatus>('/api/auth/status');
  // Server stays the authority; the UI only hides the controls when the viewer cannot act.
  const canAct = !authStatus?.authEnabled || authStatus?.user?.role === 'admin';

  // ── Agent journey: open one interaction (`open_interaction`) ───────────────
  // The bridge registers the tool only while this tab shows, after the server read the interaction's id, model, call type
  // and status (never prompts or human ratings). The handler opens the Training detail panel and says whether it opened.
  // The panel is opened BY AN AGENT: the human's rating, preference, notes and pair id stay out of it until a person
  // interacts with it (the blind rule, `@judge-ui`).
  useWebMcpPageTools('llm', {
    open_interaction: async (args, { signal, pageData }) => {
      const id = args.id as number;
      setSubTab('training');
      setOpenRequest({ id, nonce: Date.now(), byAgent: true });
      const opened = await pollUntil(
        () => [...document.querySelectorAll('dialog[open] h2')].some((h) => h.textContent?.startsWith(`Interaction #${id} `)),
        signal,
        { timeoutMs: 3000 }
      );
      const row = (pageData ?? { id }) as Record<string, unknown>;
      return opened ? row : { ...row, ...pageError('not_opened', 'The detail panel did not open. Check that the interaction still exists.') };
    },
  });

  usePageContext('llm', { selection: { interactionId: openedId } });

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Sub-tab bar */}
      <div className="flex gap-0 bg-surface-raised border-b border-border px-6 shrink-0">
        {SUB_TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setSubTab(tab.id)}
            className={`px-4 py-2 bg-transparent border-none text-xs font-medium cursor-pointer border-b-2 transition-all duration-150 ${
              subTab === tab.id
                ? 'text-text border-b-green'
                : 'text-text-secondary border-b-transparent hover:text-text'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Content — sub-components manage their own scroll */}
      {subTab === 'traces' && <TracesContent />}
      {subTab === 'training' && (
        <TrainingContent openRequest={openRequest} onRequestHandled={clearRequest} onOpened={setOpenedId} version={version} onJudgementsChanged={bumpVersion} />
      )}
      {subTab === 'judge' && (
        <JudgeQueue
          refreshKey={version}
          canAct={canAct}
          onChanged={bumpVersion}
          // A person following a link from the queue: the panel shows everything, labels included.
          onOpenInteraction={(id) => {
            setSubTab('training');
            setOpenRequest({ id, nonce: Date.now(), byAgent: false });
          }}
        />
      )}
    </div>
  );
}
