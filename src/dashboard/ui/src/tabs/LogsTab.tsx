import { useState, useEffect, useRef } from 'react';
import { useApi } from '@/hooks/useApi';
import type { LogRow } from '@/types';

const LEVELS = ['all', 'debug', 'info', 'warn', 'error'] as const;
type Level = (typeof LEVELS)[number];

const LEVEL_COLORS: Record<string, { text: string; bg: string }> = {
  debug: { text: '#9ca3af', bg: 'rgba(156,163,175,0.15)' },
  info: { text: '#3b82f6', bg: 'rgba(59,130,246,0.15)' },
  warn: { text: '#eab308', bg: 'rgba(234,179,8,0.15)' },
  error: { text: '#ef4444', bg: 'rgba(239,68,68,0.15)' },
};

function formatTimestamp(ts: string): string {
  try {
    const d = new Date(ts);
    return d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return ts;
  }
}

export function LogsTab() {
  const [level, setLevel] = useState<Level>('all');
  const [expandedRows, setExpandedRows] = useState<Set<number>>(new Set());
  const listRef = useRef<HTMLDivElement>(null);

  const path = level === 'all' ? '/api/logs?limit=200' : `/api/logs?limit=200&level=${level}`;
  const { data, loading, error } = useApi<LogRow[]>(path, [level]);

  // Auto-scroll to bottom when new data arrives
  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [data]);

  const toggleExpand = (index: number) => {
    setExpandedRows((prev) => {
      const next = new Set(prev);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Filter bar */}
      <div className="shrink-0 flex items-center gap-2 px-4 py-3 border-b border-border bg-surface-raised">
        {LEVELS.map((l) => (
          <button
            key={l}
            onClick={() => { setLevel(l); setExpandedRows(new Set()); }}
            className={`px-3 py-1 rounded text-xs font-medium capitalize transition-colors ${
              level === l
                ? 'bg-green-500/20 text-green-400 border border-green-500/40'
                : 'text-text-secondary hover:text-text hover:bg-white/5 border border-transparent'
            }`}
          >
            {l}
          </button>
        ))}
      </div>

      {/* Log list */}
      <div ref={listRef} className="flex-1 overflow-y-auto font-mono text-xs">
        {loading && (
          <div className="flex items-center justify-center h-32 text-text-muted">
            Loading logs...
          </div>
        )}

        {error && (
          <div className="flex items-center justify-center h-32 text-red-400">
            {error}
          </div>
        )}

        {!loading && !error && (!data || data.length === 0) && (
          <div className="flex items-center justify-center h-32 text-text-muted">
            No log entries found.
          </div>
        )}

        {!loading && !error && data && data.length > 0 && (
          <div className="divide-y divide-border">
            {data.map((row, i) => {
              const colors = LEVEL_COLORS[row.level] ?? LEVEL_COLORS.info;
              const isExpanded = expandedRows.has(i);

              return (
                <div key={i} className="px-4 py-1.5 hover:bg-white/[0.02]">
                  <div className="flex items-start gap-3">
                    {/* Timestamp */}
                    <span className="text-text-muted shrink-0 w-[70px]">
                      {formatTimestamp(row.ts)}
                    </span>

                    {/* Level badge */}
                    <span
                      className="shrink-0 inline-flex items-center justify-center w-[50px] px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase"
                      style={{ color: colors.text, background: colors.bg }}
                    >
                      {row.level}
                    </span>

                    {/* Message */}
                    <span className="text-text flex-1 break-all">
                      {row.msg}
                      {row.data != null && (
                        <button
                          onClick={() => toggleExpand(i)}
                          className="ml-2 text-text-muted hover:text-text-secondary text-[10px]"
                        >
                          {isExpanded ? '[-]' : '[+]'}
                        </button>
                      )}
                    </span>
                  </div>

                  {/* Expanded JSON data */}
                  {row.data != null && isExpanded && (
                    <pre className="mt-1 ml-[126px] p-2 rounded bg-black/30 text-text-muted text-[11px] overflow-x-auto whitespace-pre-wrap break-all">
                      {JSON.stringify(row.data, null, 2)}
                    </pre>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
