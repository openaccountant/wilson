import { summarizeArgs, type ChatOperationLike } from '@/lib/chatApproval';
import type { ChatApprovalDecision } from '@/hooks/usePendingChatApproval';

/** Inline confirmation card for a tool call the server chat agent is waiting on. */
export function ChatApprovalCard({
  operation,
  responding,
  error,
  onRespond,
}: {
  operation: ChatOperationLike;
  responding: boolean;
  error: string | null;
  onRespond: (decision: ChatApprovalDecision) => void;
}) {
  const args = summarizeArgs(operation.args_json);
  return (
    <div className="flex justify-start">
      <div
        role="alertdialog"
        aria-label={`Approve ${operation.tool_name}?`}
        className="max-w-[75%] rounded-lg px-4 py-2.5 text-sm bg-surface border border-green-700/60 text-text"
      >
        <div className="font-medium">
          Wilson wants to run <span className="font-mono text-green">{operation.tool_name}</span>
        </div>
        {operation.summary && <div className="mt-1 text-text-secondary">{operation.summary}</div>}
        <div className="mt-1 text-xs font-mono text-text-muted break-words">{args || 'no arguments'}</div>
        <div className="mt-2.5 flex gap-2">
          <button
            type="button"
            onClick={() => onRespond('approve')}
            disabled={responding}
            className="bg-green-700 hover:bg-green-600 disabled:bg-green-900/40 disabled:text-text-muted text-white text-xs font-medium px-3 py-1.5 rounded-lg transition-colors"
          >
            Approve
          </button>
          <button
            type="button"
            onClick={() => onRespond('reject')}
            disabled={responding}
            className="border border-border hover:border-text-muted disabled:text-text-muted text-text text-xs font-medium px-3 py-1.5 rounded-lg transition-colors"
          >
            Deny
          </button>
        </div>
        {error && <div className="mt-1.5 text-xs text-red break-words">{error}</div>}
      </div>
    </div>
  );
}
