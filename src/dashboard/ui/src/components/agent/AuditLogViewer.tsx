import { useEffect, useState } from 'react';
import { useApi } from '@/hooks/useApi';
import { agentApi, agentErrorMessage } from '@/lib/agent-api';
import { AUDIT_DECISION_OPTIONS, formatAuditRow, type AgentAuditEntry } from '@agent-access-model';
import { CHIP_CLASS } from './ToolPolicyTable';

interface AuditPage {
  entries: AgentAuditEntry[];
  nextCursor?: number;
}

const PAGE = 50;
const REFRESH_MS = 5000;

function localTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' });
}

/**
 * Every agent call, newest first. Everything in a row is agent-influenced text (tool names it invented,
 * argument previews), so it renders through React's escaping only, as plain text.
 */
export function AuditLogViewer({ toolNames }: { toolNames: string[] }) {
  const [open, setOpen] = useState(false);
  const [tool, setTool] = useState('');
  const [decision, setDecision] = useState('');
  const [tick, setTick] = useState(0);
  const [more, setMore] = useState<AgentAuditEntry[]>([]);
  const [cursor, setCursor] = useState<number | undefined>(undefined);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');

  const query = new URLSearchParams({ limit: String(PAGE) });
  if (tool) query.set('tool', tool);
  if (decision) query.set('decision', decision);
  const first = useApi<AuditPage>(`/api/mcp/audit?${query.toString()}`, [tick, open], undefined);

  // A new filter starts over.
  useEffect(() => {
    setMore([]);
    setCursor(undefined);
  }, [tool, decision]);

  // The first page follows the log while the section is open and the page is visible. Once the user has loaded
  // older rows the list stays put, so it does not jump under them.
  useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible' && more.length === 0) setTick((t) => t + 1);
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [open, more.length]);

  const entries = [...(first.data?.entries ?? []), ...more];
  const next = more.length > 0 ? cursor : first.data?.nextCursor;

  async function loadMore() {
    if (next === undefined) return;
    setLoadingMore(true);
    setError('');
    try {
      const params = new URLSearchParams(query);
      params.set('cursor', String(next));
      const page = await agentApi<AuditPage>(`/api/mcp/audit?${params.toString()}`);
      setMore((prev) => [...prev, ...page.entries]);
      setCursor(page.nextCursor);
    } catch (err) {
      setError(agentErrorMessage(err));
    }
    setLoadingMore(false);
  }

  return (
    <div className="border border-border rounded-lg overflow-hidden" data-testid="agent-activity">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="w-full flex items-center justify-between px-3 py-2.5 bg-surface-raised border-none text-left cursor-pointer text-sm font-medium text-text"
      >
        <span>Activity</span>
        <span className="text-xs text-text-muted font-normal">{open ? 'Hide' : 'Show every agent call'}</span>
      </button>

      {open && (
        <div className="border-t border-border">
          <div className="flex flex-wrap items-center gap-2 px-3 py-2 bg-surface">
            <select
              aria-label="Filter by tool"
              value={tool}
              onChange={(e) => setTool(e.target.value)}
              className="bg-surface-raised border border-border rounded px-2 py-1 text-xs text-text font-mono"
            >
              <option value="">All tools</option>
              {toolNames.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
            <select
              aria-label="Filter by decision"
              value={decision}
              onChange={(e) => setDecision(e.target.value)}
              className="bg-surface-raised border border-border rounded px-2 py-1 text-xs text-text"
            >
              <option value="">All decisions</option>
              {AUDIT_DECISION_OPTIONS.map((d) => (
                <option key={d} value={d}>
                  {d.replace(/_/g, ' ')}
                </option>
              ))}
            </select>
            <span className="text-xs text-text-muted ml-auto">Refreshes every 5 s</span>
          </div>

          {first.error && entries.length === 0 ? (
            <div className="px-3 py-4 text-xs text-red">{agentErrorMessage(new Error(first.error))}</div>
          ) : entries.length === 0 ? (
            <div className="px-3 py-6 text-xs text-text-muted">{first.data ? 'No agent activity yet.' : 'Loading…'}</div>
          ) : (
            <div className="max-h-[420px] overflow-y-auto">
              {entries.map((entry) => {
                const row = formatAuditRow(entry);
                if (row.kind === 'notice') {
                  return (
                    <div key={row.id} className="px-3 py-2 text-xs text-yellow bg-yellow/10 border-y border-yellow/30">
                      <span className="font-mono mr-2">{localTime(row.timeIso)}</span>
                      {row.notice}
                    </div>
                  );
                }
                return (
                  <div
                    key={row.id}
                    className="grid grid-cols-[auto_auto_minmax(0,1fr)_auto_auto] md:grid-cols-[150px_90px_190px_130px_minmax(0,1fr)] gap-x-3 items-center px-3 py-1.5 border-t border-border-muted text-xs"
                  >
                    <span className="font-mono text-text-muted truncate">{localTime(row.timeIso)}</span>
                    <span className="text-text-muted" title={row.transportTitle ?? undefined}>
                      {row.transport}
                      {row.transportClientReported && <span className="text-text-muted/70"> *</span>}
                    </span>
                    <span className="font-mono text-text truncate" title={row.tool}>
                      {row.tool}
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span className={`px-1.5 py-0.5 rounded font-medium ${CHIP_CLASS[row.chip]}`}>{row.decisionLabel}</span>
                      {row.count !== null && <span className="font-mono text-text-muted">×{row.count}</span>}
                    </span>
                    <span className="font-mono text-text-muted truncate col-span-5 md:col-span-1" title={row.previewTitle}>
                      {row.preview}
                    </span>
                  </div>
                );
              })}
            </div>
          )}

          {error && <div className="px-3 py-2 text-xs text-red">{error}</div>}
          <div className="flex items-center justify-between px-3 py-2 border-t border-border-muted bg-surface">
            <span className="text-[11px] text-text-muted">* Transport is reported by the calling page; Wilson does not verify it.</span>
            {next !== undefined && (
              <button
                onClick={() => void loadMore()}
                disabled={loadingMore}
                className="px-2.5 py-1 rounded text-xs font-medium cursor-pointer border border-border bg-transparent text-text hover:border-green/50 disabled:opacity-40"
              >
                {loadingMore ? 'Loading…' : 'Load more'}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
