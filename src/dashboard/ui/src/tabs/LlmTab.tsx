import { useState, useMemo } from 'react';
import { useApi } from '@/hooks/useApi';
import { api } from '@/api';
import { Dialog } from '@/components/Dialog';
import type { InteractionRow, AnnotationStats, TraceRow, TraceStats } from '@/types';

type SubTab = 'traces' | 'training';

interface InteractionDetail extends InteractionRow {
  system_prompt: string | null;
  user_prompt: string;
  response_content: string | null;
  tool_calls_json: string | null;
  toolResults: { tool_name: string; tool_result: string | null }[];
  annotations: { rating: number | null; preference: string | null; pair_id: string | null; notes: string | null }[];
}

function fmtNum(n: number): string {
  return n.toLocaleString();
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function fmtTime(timestamp: string): string {
  const d = new Date(timestamp);
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

function getBaseUrl(): string {
  if (import.meta.env.DEV) return 'http://localhost:3141';
  return window.location.origin;
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
                  {traces.map((trace) => (
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

function TrainingContent() {
  const [callTypeFilter, setCallTypeFilter] = useState('');
  const [modelFilter, setModelFilter] = useState('');
  const [ratingFilter, setRatingFilter] = useState('');
  const [annotatedFilter, setAnnotatedFilter] = useState('');
  const [selectedId, setSelectedId] = useState<number | null>(null);
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
    return params.toString();
  }, [callTypeFilter, modelFilter, ratingFilter, annotatedFilter]);

  const {
    data: interactions,
    loading: interactionsLoading,
    error: interactionsError,
    refetch: refetchInteractions,
  } = useApi<InteractionRow[]>(`/api/interactions?${queryParams}`, [queryParams]);

  const {
    data: stats,
    loading: statsLoading,
    error: statsError,
    refetch: refetchStats,
  } = useApi<AnnotationStats>('/api/annotations/stats');

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
      await api<{ success: boolean }>(`/api/interactions/${id}/annotate`, {
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
  }

  async function loadDetail(id: number) {
    setSelectedId(id);
    setDetail(null);
    setDetailLoading(true);
    try {
      const data = await api<InteractionDetail>(`/api/interactions/${id}`);
      setDetail(data);
      const ann = data.annotations?.[0];
      setDetailRating(ann?.rating ?? 0);
      setPreference(ann?.preference ?? '');
      setPairId(ann?.pair_id ?? '');
      setNotes(ann?.notes ?? '');
    } catch {
      // Close dialog on error
      setSelectedId(null);
      setDetail(null);
    } finally {
      setDetailLoading(false);
    }
  }

  async function handleSaveAnnotation() {
    if (!selectedId) return;
    setSaving(true);
    try {
      const body: Record<string, unknown> = {};
      if (detailRating > 0) body.rating = detailRating;
      if (preference) body.preference = preference;
      if (pairId) body.pairId = pairId;
      if (notes) body.notes = notes;
      await api<{ success: boolean }>(`/api/interactions/${selectedId}/annotate`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      refetchInteractions();
      refetchStats();
      closeDetail();
    } catch { /* silently fail */ }
    finally { setSaving(false); }
  }

  function handleExport(format: 'sft' | 'dpo') {
    const token = localStorage.getItem('wilson_auth_token');
    const base = getBaseUrl();
    const url = `${base}/api/export/training/${format}${token ? `?token=${token}` : ''}`;
    const a = document.createElement('a');
    a.href = url;
    a.download = `wilson-${format}.jsonl`;
    a.click();
  }

  const loading = interactionsLoading || statsLoading;
  const error = interactionsError || statsError;
  const progressPercent =
    stats && stats.total > 0 ? Math.round((stats.annotated / stats.total) * 100) : 0;

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Fixed header: export buttons, stat cards, progress, filters */}
      <div className="shrink-0 p-6 pb-0 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button onClick={() => handleExport('sft')} className="bg-surface-raised border border-border text-text-secondary text-xs font-medium px-3 py-1.5 rounded-md hover:bg-surface hover:text-text transition-colors">
              Export SFT
            </button>
            <button onClick={() => handleExport('dpo')} className="bg-surface-raised border border-border text-text-secondary text-xs font-medium px-3 py-1.5 rounded-md hover:bg-surface hover:text-text transition-colors">
              Export DPO
            </button>
          </div>
          {interactions && (
            <span className="text-xs text-text-muted font-mono">{interactions.length} interactions loaded</span>
          )}
        </div>

        {stats && (
          <>
            <div className="grid grid-cols-4 gap-4">
              <div className="bg-surface-raised border border-border rounded-lg p-4">
                <div className="text-xs text-text-muted uppercase tracking-wide mb-1">Total Interactions</div>
                <div className="text-2xl font-mono text-text">{fmtNum(stats.total)}</div>
              </div>
              <div className="bg-surface-raised border border-border rounded-lg p-4">
                <div className="text-xs text-text-muted uppercase tracking-wide mb-1">Annotated</div>
                <div className="text-2xl font-mono text-green">{fmtNum(stats.annotated)}</div>
              </div>
              <div className="bg-surface-raised border border-border rounded-lg p-4">
                <div className="text-xs text-text-muted uppercase tracking-wide mb-1">SFT Ready</div>
                <div className="text-2xl font-mono text-text">{fmtNum(stats.sftReady)}</div>
              </div>
              <div className="bg-surface-raised border border-border rounded-lg p-4">
                <div className="text-xs text-text-muted uppercase tracking-wide mb-1">DPO Pairs</div>
                <div className="text-2xl font-mono text-text">{fmtNum(stats.dpoPairs)}</div>
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
                </tr>
              </thead>
              <tbody>
                {interactions.map((row) => (
                  <tr
                    key={row.id}
                    onClick={() => loadDetail(row.id)}
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
                    </td>
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
        ) : undefined}
      >
        {detailLoading && <div className="h-[200px] animate-pulse bg-border-muted rounded" />}
        {detail && !detailLoading && (
          <div className="space-y-4">
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
];

export function LlmTab() {
  const [subTab, setSubTab] = useState<SubTab>('traces');

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
      {subTab === 'training' && <TrainingContent />}
    </div>
  );
}
