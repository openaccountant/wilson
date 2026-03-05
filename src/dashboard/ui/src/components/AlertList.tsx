import { useApi } from '@/hooks/useApi';
import type { AlertItem } from '@/types';

const SEVERITY_STYLES: Record<string, { bg: string; border: string }> = {
  critical: { bg: 'rgba(248,81,73,0.15)', border: '#f85149' },
  warning: { bg: 'rgba(210,153,34,0.15)', border: '#d29922' },
  info: { bg: 'rgba(88,166,255,0.15)', border: '#58a6ff' },
};

export function AlertList() {
  const { data, loading } = useApi<AlertItem[]>('/api/alerts');

  if (loading) {
    return (
      <div className="bg-surface-raised border border-border rounded-lg p-4">
        <div className="h-[80px] animate-pulse bg-border-muted rounded" />
      </div>
    );
  }

  if (!data || data.length === 0) {
    return (
      <div className="bg-surface-raised border border-border rounded-lg p-4">
        <h3 className="text-xs text-text-secondary uppercase tracking-wide mb-2">Alerts</h3>
        <p className="text-sm text-text-muted">No alerts. All clear.</p>
      </div>
    );
  }

  return (
    <div className="bg-surface-raised border border-border rounded-lg p-4">
      <h3 className="text-xs text-text-secondary uppercase tracking-wide mb-3">Alerts</h3>
      <div className="space-y-2">
        {data.map((alert, i) => {
          const style = SEVERITY_STYLES[alert.severity] ?? SEVERITY_STYLES.info;
          return (
            <div
              key={i}
              className="px-3 py-2 rounded-md text-xs text-text"
              style={{ background: style.bg, borderLeft: `3px solid ${style.border}` }}
            >
              {alert.message}
            </div>
          );
        })}
      </div>
    </div>
  );
}
