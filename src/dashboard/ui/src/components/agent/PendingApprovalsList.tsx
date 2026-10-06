import { useEffect, useRef, useState } from 'react';
import { HoldToApprove } from './HoldToApprove';
import { confirmationCardModel, outcomeCopy, reconcileStack, releasePlaceholders, type StackEntry } from '@confirmation-card';
import type { AgentPendingOperation } from '@agent-access-model';
import { agentApi, agentErrorMessage } from '@/lib/agent-api';

function ApprovalCard({ op, onDone }: { op: AgentPendingOperation; onDone: () => void }) {
  const model = confirmationCardModel(op);
  const readCard = model.variant === 'read';
  const [message, setMessage] = useState('');
  const [working, setWorking] = useState(false);
  const [ended, setEnded] = useState<string | null>(null);
  const [armKey, setArmKey] = useState(0);

  async function answer(action: 'approve' | 'reject') {
    setWorking(true);
    setMessage('');
    try {
      const res = await agentApi<{ outcome?: string }>(`/api/mcp/operations/${op.id}/${action}`, { method: 'POST' });
      setEnded(res.outcome ?? 'unknown');
      setTimeout(onDone, 1800);
    } catch (err) {
      const text = agentErrorMessage(err);
      if (text.toLowerCase().includes('wait a moment')) {
        // Too quick: the operation is still pending. Re-arm the button.
        setMessage(outcomeCopy('approval_too_fast'));
        setArmKey((k) => k + 1);
      } else if (text.toLowerCase().includes('expired')) {
        setEnded('expired');
        setTimeout(onDone, 1800);
      } else {
        setMessage(text);
      }
    }
    setWorking(false);
  }

  if (ended) {
    return <div className="border border-border rounded-lg p-4 text-sm text-text bg-surface-raised">{outcomeCopy(ended)}</div>;
  }

  return (
    <div className={`border rounded-lg p-4 space-y-3 bg-surface-raised ${readCard ? 'border-yellow/60' : 'border-border'}`} data-testid="agent-approval-card">
      <div>
        <div className={`text-sm font-semibold ${readCard ? 'text-yellow' : 'text-text'}`}>{model.heading}</div>
        <div className="text-xs text-text-muted">{model.requestedByLine}</div>
      </div>

      {model.summary && <div className="text-sm font-medium text-text">{model.summary}</div>}
      {model.bankDataRow && (
        <div className="font-mono text-xs text-text bg-surface border border-border rounded px-2 py-1.5 break-words">{model.bankDataRow}</div>
      )}

      {readCard ? (
        <div className="space-y-2">
          <div className="text-xs text-text-muted">This agent wants to read data from Wilson. It runs only if you allow it.</div>
          {model.filterRows && model.filterRows.length > 0 && (
            <div className="text-xs">
              <div className="text-text-muted mb-1">Wilson understood the query as</div>
              {model.filterRows.map((r) => (
                <div key={r.label} className="flex gap-3 py-0.5">
                  <span className="text-text-muted w-28 shrink-0">{r.label}</span>
                  <span className="font-mono text-text break-words">{r.value}</span>
                </div>
              ))}
            </div>
          )}
          {model.argsBlock !== null && (
            <div>
              <div className="text-xs text-text-muted mb-1">Full request</div>
              <pre className="font-mono text-[11px] text-text bg-surface border border-border rounded p-2 max-h-32 overflow-auto whitespace-pre-wrap break-words m-0">
                {model.argsBlock}
              </pre>
            </div>
          )}
        </div>
      ) : model.deltaRows === null ? (
        <div className="text-xs text-text-muted">No structured delta available for this action.</div>
      ) : model.deltaRows.rows.length === 0 ? (
        <div className="text-xs text-text-muted">No fields changed.</div>
      ) : (
        <table className="w-full text-xs border-collapse">
          <tbody>
            {model.deltaRows.rows.map((r) => (
              <tr key={r.field}>
                <td className="py-1 pr-3 text-text-muted whitespace-nowrap align-top">{r.field}</td>
                <td className="py-1 pr-3 font-mono text-red line-through break-words">{r.from}</td>
                <td className="py-1 font-mono text-green font-semibold break-words">{r.to}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {message && <div className="text-xs text-yellow">{message}</div>}

      <div className="flex gap-2">
        <HoldToApprove
          key={armKey}
          label={readCard ? 'Hold to allow' : 'Hold to approve'}
          holdMs={model.holdMs}
          enableAfterMs={model.enableAfterMs}
          tone={readCard ? 'amber' : 'green'}
          onConfirmed={() => !working && void answer('approve')}
        />
        <button
          disabled={working}
          onClick={() => void answer('reject')}
          className="flex-1 px-3 py-2 rounded border border-red/50 bg-red/15 text-red text-xs font-semibold cursor-pointer hover:bg-red/25 disabled:opacity-40"
        >
          {readCard ? "Don't allow" : 'Reject'}
        </button>
      </div>
    </div>
  );
}

/**
 * Everything waiting on this user, from the same list the floating panel's cards come from.
 *
 * While the pointer is over the list, a card that goes away (answered here, in another tab, or by expiry) leaves a
 * fixed-height placeholder instead of closing up, so the card under the pointer does not slide away mid-click. The
 * placeholders collapse when the pointer leaves.
 */
export function PendingApprovalsList({ pending, onChanged }: { pending: AgentPendingOperation[]; onChanged: () => void }) {
  const [entries, setEntries] = useState<StackEntry[]>(() => pending.map((op) => ({ id: op.id, placeholderPx: null })));
  const hovered = useRef(false);
  const slots = useRef(new Map<string, HTMLDivElement>());
  // Last known operation per id, so a card that just left `pending` can still render until its slot is released.
  const known = useRef(new Map<string, AgentPendingOperation>());
  for (const op of pending) known.current.set(op.id, op);

  const pendingKey = pending.map((op) => op.id).join('|');
  useEffect(() => {
    const ids = pendingKey === '' ? [] : pendingKey.split('|');
    setEntries((prev) => reconcileStack(prev, ids, hovered.current, (id) => slots.current.get(id)?.offsetHeight ?? 0));
  }, [pendingKey]);

  if (entries.length === 0 && pending.length === 0) return null;
  return (
    <div
      className="space-y-2"
      onPointerEnter={() => { hovered.current = true; }}
      onPointerLeave={() => {
        hovered.current = false;
        setEntries((prev) => releasePlaceholders(prev));
      }}
    >
      <div className="text-xs text-text-secondary uppercase tracking-wide">{pending.length} waiting for you</div>
      {entries.map((e) =>
        e.placeholderPx !== null ? (
          <div key={e.id} style={{ height: e.placeholderPx }} aria-hidden data-testid="agent-approval-placeholder" />
        ) : (
          <div
            key={e.id}
            ref={(node) => {
              if (node) slots.current.set(e.id, node);
              else slots.current.delete(e.id);
            }}
          >
            {known.current.get(e.id) && <ApprovalCard op={known.current.get(e.id)!} onDone={onChanged} />}
          </div>
        ),
      )}
    </div>
  );
}
