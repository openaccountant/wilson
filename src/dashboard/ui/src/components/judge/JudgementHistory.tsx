import { replaceUrls } from '@judge-ui';
import type { AnnotationVersion, JudgementRow } from '@/types';

const STATUS_CLASS: Record<JudgementRow['status'], string> = {
  proposed: 'bg-yellow/15 text-yellow',
  accepted: 'bg-green/15 text-green',
  rejected: 'bg-border-muted/50 text-text-muted line-through',
  superseded: 'bg-border-muted/50 text-text-muted',
};

function fmt(ts: string): string {
  const d = new Date(ts.includes('T') ? ts : `${ts.replace(' ', 'T')}Z`);
  return Number.isNaN(d.getTime()) ? ts : d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/**
 * Every version of the human's label, and every judge proposal, for one interaction. Nothing is ever edited or
 * deleted: a re-rating is a new version, and an accepted judgement can be revoked (it becomes rejected).
 */
export function JudgementHistory({
  history,
  judgements,
  canRevoke,
  onRevoke,
}: {
  history: AnnotationVersion[];
  judgements: JudgementRow[];
  canRevoke: boolean;
  onRevoke: (id: number) => void;
}) {
  if (history.length === 0 && judgements.length === 0) return null;
  return (
    <div className="space-y-2" data-testid="judgement-history">
      <div className="text-xs text-text-muted uppercase tracking-wide font-medium">History</div>
      <ol className="space-y-1.5 m-0 pl-0 list-none">
        {history.map((v) => (
          <li key={`h${v.id}`} className="flex flex-wrap items-center gap-2 text-xs">
            <span className="font-mono text-text-secondary">human v{v.version}</span>
            <span className="text-text">{v.rating === null ? '–' : `${v.rating}/5`}</span>
            <span className="text-text-muted">{fmt(v.annotated_at)}</span>
            {v.created_via === 'dashboard_agent_present' && (
              <span className="text-[10px] uppercase tracking-wide font-medium px-1.5 py-0.5 rounded bg-yellow/15 text-yellow">Agent present</span>
            )}
            {v.status === 'superseded' && <span className="text-text-muted">superseded</span>}
          </li>
        ))}
        {judgements.map((j) => (
          <li key={`j${j.id}`} className="space-y-0.5">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="font-mono text-text-secondary">judge v{j.version}</span>
              <span className="text-text">{j.rating === null ? '–' : `${j.rating}/5`}</span>
              <span className="font-mono text-text-muted">{j.judge_model ?? 'unknown'}</span>
              <span className="text-[10px] uppercase tracking-wide font-medium px-1.5 py-0.5 rounded bg-yellow/15 text-yellow">Declared by agent</span>
              <span className={`text-[10px] uppercase tracking-wide font-medium px-1.5 py-0.5 rounded ${STATUS_CLASS[j.status]}`}>{j.status}</span>
              {j.review_agent_present && (
                <span className="text-[10px] uppercase tracking-wide font-medium px-1.5 py-0.5 rounded bg-yellow/15 text-yellow" title="Reviewed while an agent had access: left out of the judge export unless agent-present is also included">Agent present</span>
              )}
              <span className="text-text-muted">{fmt(j.annotated_at)}</span>
              {j.status === 'accepted' && canRevoke && (
                <button onClick={() => onRevoke(j.id)} className="px-2 py-0.5 rounded text-[11px] border border-border bg-transparent text-red cursor-pointer hover:bg-red/10">
                  Revoke
                </button>
              )}
            </div>
            {j.rationale && (
              <p className="text-xs text-text-secondary m-0 pl-2 border-l border-border whitespace-pre-wrap break-words">
                <span className="text-[10px] uppercase tracking-wide text-yellow mr-1">Agent-written</span>
                {replaceUrls(j.rationale)}
              </p>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}
