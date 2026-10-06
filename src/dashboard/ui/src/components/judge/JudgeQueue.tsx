import { useCallback, useEffect, useState } from 'react';
import { useApi } from '@/hooks/useApi';
import { api } from '@/api';
import { Dialog } from '@/components/Dialog';
import { HoldToApprove } from '@/components/agent/HoldToApprove';
import { agentErrorMessage } from '@/lib/agent-api';
import {
  BULK_ACCEPT_MAX,
  JUDGE_ENABLE_AFTER_MS,
  JUDGE_HOLD_MS,
  acceptedHeader,
  bulkConfirmText,
  bulkEligible,
  gapIsLarge,
  queueHeader,
  queueUrl,
  replaceUrls,
  type QueueView,
} from '@judge-ui';
import type { JudgementList, JudgementRow } from '@/types';

/**
 * The human's queue of judge proposals. Everything an agent wrote (the model name, the rationale) is labelled as
 * agent-written, shown as plain text, and has its links replaced. Accept needs a real click after the row has
 * been on screen for 800 ms; bulk Accept takes only rows you expanded (at most 10) behind a confirm and a
 * press-and-hold; the server also refuses a proposal younger than one second.
 */

function Stars({ rating }: { rating: number | null }) {
  if (rating === null) return <span className="text-text-muted text-xs">–</span>;
  return (
    <span className="text-sm text-text-secondary" aria-label={`${rating} of 5`}>
      {'★'.repeat(rating)}
      {'☆'.repeat(5 - rating)}
    </span>
  );
}

function RowActions({ onAccept, onReject, busy, note }: { onAccept: () => void; onReject: () => void; busy: boolean; note: string }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setArmed(true), JUDGE_ENABLE_AFTER_MS);
    return () => clearTimeout(t);
  }, []);
  const [refused, setRefused] = useState('');
  return (
    <div className="flex flex-col items-end gap-1 shrink-0">
      <div className="flex gap-2">
        <button
          disabled={!armed || busy}
          onClick={(e) => {
            // A synthetic click (script-made) does not count: a person's real click does.
            if (!e.nativeEvent.isTrusted) return setRefused('Accept needs a real click.');
            setRefused('');
            onAccept();
          }}
          className="px-3 py-1 rounded text-xs font-semibold border-none cursor-pointer bg-green/20 text-green hover:bg-green/30 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Accept
        </button>
        <button
          disabled={busy}
          onClick={onReject}
          className="px-3 py-1 rounded text-xs font-semibold border-none cursor-pointer bg-red/20 text-red hover:bg-red/30 disabled:opacity-40"
        >
          Reject
        </button>
      </div>
      {(refused || note) && <span className="text-[10px] text-yellow">{refused || note}</span>}
    </div>
  );
}

function JudgementItem({
  row,
  selected,
  expanded,
  busy,
  note,
  onToggleSelect,
  onToggleExpand,
  onOpen,
  onAct,
  view,
  canAct,
  onRevoke,
}: {
  row: JudgementRow;
  selected: boolean;
  expanded: boolean;
  busy: boolean;
  note: string;
  onToggleSelect: () => void;
  onToggleExpand: () => void;
  onOpen: () => void;
  onAct: (action: 'accept' | 'reject') => void;
  view: QueueView;
  canAct: boolean;
  onRevoke: () => void;
}) {
  const gap = gapIsLarge(row.rating, row.human_rating);
  return (
    <div className={`flex gap-3 items-start p-3 border-b border-border last:border-b-0 ${gap ? 'border-l-2 border-l-red' : ''}`} data-testid="judgement-row">
      {view === 'proposed' && (
        <input type="checkbox" checked={selected} onChange={onToggleSelect} aria-label={`Select judgement ${row.id}`} className="mt-1 cursor-pointer" />
      )}
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <button onClick={onOpen} className="font-mono text-xs text-text bg-transparent border-none p-0 cursor-pointer hover:text-green">
            #{row.interaction_id}
          </button>
          <span className="font-mono text-xs text-text-secondary">{row.judge_model ?? 'unknown model'}</span>
          <span className="text-[10px] uppercase tracking-wide font-medium px-1.5 py-0.5 rounded bg-yellow/15 text-yellow">Declared by agent</span>
          <Stars rating={row.rating} />
          {row.human_rating !== undefined && row.human_rating !== null && (
            <span className={`text-xs px-1.5 py-0.5 rounded border ${gap ? 'border-red text-red' : 'border-border text-text-muted'}`} title="Your rating for the same interaction">
              you: {row.human_rating}
            </span>
          )}
          <span className="text-[10px] text-text-muted font-mono">{row.created_via}</span>
          {view === 'accepted' && row.review_agent_present && (
            <span className="text-[10px] uppercase tracking-wide font-medium px-1.5 py-0.5 rounded bg-yellow/15 text-yellow" title="Reviewed while an agent had access: left out of the judge export unless agent-present is also included">
              Agent present
            </span>
          )}
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wide text-yellow mb-0.5">Agent-written</div>
          <p className={`text-sm text-text m-0 whitespace-pre-wrap break-words ${expanded ? '' : 'line-clamp-3'}`}>{replaceUrls(row.rationale ?? '')}</p>
          <button onClick={onToggleExpand} className="text-[11px] text-text-muted bg-transparent border-none p-0 cursor-pointer hover:text-text mt-0.5">
            {expanded ? 'Collapse' : 'Expand'}
          </button>
        </div>
        {(row.criteria || row.tags.length > 0) && (
          <div className="flex flex-wrap gap-1.5">
            {Object.entries(row.criteria ?? {}).map(([id, value]) => (
              <span key={id} className="text-[11px] font-mono px-1.5 py-0.5 rounded bg-border-muted/50 text-text-secondary">
                {id} {value}
              </span>
            ))}
            {row.tags.map((tag) => (
              <span key={tag} className="text-[11px] font-mono px-1.5 py-0.5 rounded bg-blue/15 text-blue">
                {tag}
              </span>
            ))}
          </div>
        )}
      </div>
      {view === 'proposed' ? (
        <RowActions busy={busy} note={note} onAccept={() => onAct('accept')} onReject={() => onAct('reject')} />
      ) : (
        canAct && (
          <div className="flex flex-col items-end gap-1 shrink-0">
            <button
              disabled={busy}
              onClick={onRevoke}
              className="px-3 py-1 rounded text-xs font-semibold border-none cursor-pointer bg-red/20 text-red hover:bg-red/30 disabled:opacity-40"
            >
              Revoke
            </button>
            {note && <span className="text-[10px] text-yellow">{note}</span>}
          </div>
        )
      )}
    </div>
  );
}

export function JudgeQueue({ refreshKey, canAct, onOpenInteraction, onChanged }: { refreshKey: number; canAct: boolean; onOpenInteraction: (id: number) => void; onChanged: () => void }) {
  const [view, setView] = useState<QueueView>('proposed');
  const { data, loading, error, refetch } = useApi<JudgementList>(queueUrl(view), [refreshKey, view]);
  const [more, setMore] = useState<JudgementRow[]>([]);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [busyId, setBusyId] = useState<number | null>(null);
  const [notes, setNotes] = useState<Record<number, string>>({});
  const [message, setMessage] = useState('');
  const [confirmBulk, setConfirmBulk] = useState(false);

  useEffect(() => {
    setMore([]);
    setCursor(data?.nextCursor);
  }, [data]);

  function switchView(next: QueueView) {
    if (next === view) return;
    setView(next);
    setSelected(new Set());
    setNotes({});
    setMessage('');
  }

  const rows = [...(data?.judgements ?? []), ...more];

  const toggle = (set: Set<number>, id: number): Set<number> => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  };

  const done = useCallback(() => {
    refetch();
    onChanged();
  }, [refetch, onChanged]);

  async function act(row: JudgementRow, action: 'accept' | 'reject') {
    setBusyId(row.id);
    setMessage('');
    try {
      await api(`/api/judgements/${row.id}/${action}`, { method: 'POST' });
      setSelected((s) => {
        const next = new Set(s);
        next.delete(row.id);
        return next;
      });
      done();
    } catch (err) {
      const text = agentErrorMessage(err);
      setNotes((n) => ({ ...n, [row.id]: text.toLowerCase().includes('wait a moment') ? 'Too quick: read it, then accept again.' : text }));
    }
    setBusyId(null);
  }

  async function revoke(row: JudgementRow) {
    setBusyId(row.id);
    setMessage('');
    try {
      await api(`/api/judgements/${row.id}/revoke`, { method: 'POST' });
      done();
    } catch (err) {
      setNotes((n) => ({ ...n, [row.id]: agentErrorMessage(err) }));
    }
    setBusyId(null);
  }

  const eligible = bulkEligible([...selected], expanded);

  async function bulkAccept() {
    setConfirmBulk(false);
    setMessage('');
    try {
      const res = await api<{ results: Array<{ id: number; ok: boolean; reason?: string }> }>('/api/judgements/bulk', {
        method: 'POST',
        body: JSON.stringify({ ids: eligible, action: 'accept' }),
      });
      const failed = res.results.filter((r) => !r.ok).length;
      setMessage(failed ? `${res.results.length - failed} accepted, ${failed} could not be.` : `${res.results.length} accepted.`);
      setSelected(new Set());
      done();
    } catch (err) {
      setMessage(agentErrorMessage(err));
    }
  }

  async function loadMore() {
    if (!cursor) return;
    try {
      const next = await api<JudgementList>(queueUrl(view, cursor));
      setMore((m) => [...m, ...next.judgements]);
      setCursor(next.nextCursor);
    } catch (err) {
      setMessage(agentErrorMessage(err));
    }
  }

  if (loading && !data) {
    return (
      <div className="flex-1 overflow-y-auto p-6">
        <div className="h-[200px] animate-pulse bg-border-muted rounded" />
      </div>
    );
  }
  if (error) {
    return <div className="p-6 text-sm text-red">Failed to load judgements: {error}</div>;
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="shrink-0 px-6 pt-6 pb-3 space-y-2">
        <div className="flex gap-1" role="tablist" aria-label="Judgement view">
          {(['proposed', 'accepted'] as const).map((v) => (
            <button
              key={v}
              role="tab"
              aria-selected={view === v}
              onClick={() => switchView(v)}
              className={`px-3 py-1 rounded text-xs font-semibold border cursor-pointer ${view === v ? 'border-green text-green bg-green/10' : 'border-border text-text-secondary bg-transparent hover:text-text'}`}
            >
              {v === 'proposed' ? 'Proposed' : 'Accepted'}
            </button>
          ))}
        </div>
        <div className="text-sm text-text-secondary" data-testid="judge-queue-header">
          {view === 'proposed' ? queueHeader(data?.total ?? 0, data?.agreement) : acceptedHeader(data?.total ?? 0)}
        </div>
        <p className="text-xs text-text-muted m-0">
          {view === 'proposed'
            ? 'Proposals are inert until you accept them, and the default training export never includes them.'
            : 'Accepted judgements, including ones a newer proposal now sits on top of. Revoking turns one into rejected so no export includes it.'}
        </p>
        {view === 'proposed' && canAct && selected.size > 0 && (
          <div className="flex flex-wrap items-center gap-3 bg-surface-raised border border-border rounded-md px-3 py-2">
            <span className="text-xs text-text-secondary">{selected.size} selected</span>
            <button
              disabled={eligible.length === 0}
              onClick={() => setConfirmBulk(true)}
              title={eligible.length === 0 ? `Expand a row to read it first. Bulk accept takes up to ${BULK_ACCEPT_MAX} rows you expanded.` : undefined}
              className="px-3 py-1 rounded text-xs font-semibold border-none cursor-pointer bg-green/20 text-green hover:bg-green/30 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Accept {eligible.length} expanded
            </button>
            {eligible.length < selected.size && <span className="text-[11px] text-text-muted">Rows you have not expanded are skipped.</span>}
          </div>
        )}
        {message && <div role="status" className="text-xs text-text-secondary">{message}</div>}
      </div>

      <div className="flex-1 overflow-y-auto px-6 pb-6 min-h-0">
        {rows.length === 0 ? (
          <div className="bg-surface-raised border border-border rounded-lg p-8 text-center">
            <p className="text-sm text-text-muted m-0">
              {view === 'proposed' ? 'No proposals. Grant the judge tools to an agent from Settings → Agent access.' : 'Nothing accepted.'}
            </p>
          </div>
        ) : (
          <div className="bg-surface-raised border border-border rounded-lg overflow-hidden">
            {rows.map((row) => (
              <JudgementItem
                key={row.id}
                row={row}
                selected={selected.has(row.id)}
                expanded={expanded.has(row.id)}
                busy={busyId === row.id || !canAct}
                note={notes[row.id] ?? ''}
                onToggleSelect={() => setSelected((s) => toggle(s, row.id))}
                onToggleExpand={() => setExpanded((s) => toggle(s, row.id))}
                onOpen={() => onOpenInteraction(row.interaction_id)}
                onAct={(action) => void act(row, action)}
                view={view}
                canAct={canAct}
                onRevoke={() => void revoke(row)}
              />
            ))}
          </div>
        )}
        {cursor && (
          <button onClick={() => void loadMore()} className="mt-3 px-3 py-1.5 rounded text-xs border border-border bg-transparent text-text-secondary cursor-pointer hover:text-text">
            Load more
          </button>
        )}
      </div>

      <Dialog open={confirmBulk} onClose={() => setConfirmBulk(false)} title="Accept judgements" className="max-w-md">
        <div className="space-y-4">
          <p className="text-sm text-text m-0">{bulkConfirmText(eligible.length)}</p>
          <div className="flex gap-2">
            <HoldToApprove label={`Hold to accept ${eligible.length}`} holdMs={JUDGE_HOLD_MS} enableAfterMs={JUDGE_ENABLE_AFTER_MS} tone="green" onConfirmed={() => void bulkAccept()} />
            <button
              onClick={() => setConfirmBulk(false)}
              className="flex-1 px-3 py-2 rounded border border-border bg-transparent text-text-secondary text-xs font-semibold cursor-pointer hover:text-text"
            >
              Cancel
            </button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
