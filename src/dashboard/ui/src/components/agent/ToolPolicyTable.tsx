import { buildToolRows, type AgentState, type ChipTone, type PolicyValue, type ToolRow } from '@agent-access-model';

const BADGE: Record<ToolRow['classBadge']['tone'], string> = {
  muted: 'bg-border-muted/50 text-text-muted',
  amber: 'bg-yellow/15 text-yellow',
  blue: 'bg-blue/15 text-blue',
};

const POLICY_ACTIVE: Record<PolicyValue, string> = {
  off: 'bg-border-muted/60 text-text',
  ask: 'bg-yellow/15 text-yellow',
  allow: 'bg-green/15 text-green',
};

/** Chip colours shared with the Activity log: green allowed/committed, red refused, amber waiting on you, quiet otherwise. */
export const CHIP_CLASS: Record<ChipTone, string> = {
  green: 'bg-green/15 text-green',
  red: 'bg-red/15 text-red',
  amber: 'bg-yellow/15 text-yellow',
  muted: 'bg-border-muted/50 text-text-muted',
};

function formatExpiry(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/**
 * One row per tool: its class, the policy (Off / Ask / Allow), and this tab's grant. A change tool can never be
 * Allow ("Changes always wait for your approval"); a viewer cannot touch change tools at all.
 */
export function ToolPolicyTable({
  state,
  busy,
  onPolicy,
  onGrant,
  onRevoke,
}: {
  state: AgentState;
  busy: boolean;
  onPolicy: (tool: string, policy: PolicyValue) => void;
  onGrant: (tool: string) => void;
  onRevoke: (grantId: string) => void;
}) {
  const rows = buildToolRows(state, state.role);

  return (
    <div className="border border-border rounded-lg overflow-hidden" data-testid="agent-tool-policies">
      <div className="hidden md:grid grid-cols-[minmax(0,1.6fr)_72px_168px_minmax(0,1fr)_72px] gap-x-4 px-3 py-2 border-b border-border bg-surface text-[10px] uppercase tracking-wide text-text-muted">
        <span>Tool</span>
        <span>Class</span>
        <span>Policy</span>
        <span>This tab</span>
        <span className="text-right">Revoke</span>
      </div>
      {rows.map((row) => (
        <div
          key={row.name}
          title={row.locked ? (row.lockReason ?? undefined) : undefined}
          className={`grid grid-cols-1 md:grid-cols-[minmax(0,1.6fr)_72px_168px_minmax(0,1fr)_72px] gap-x-4 gap-y-2 items-center px-3 py-2.5 border-b border-border-muted last:border-b-0 ${
            row.locked ? 'opacity-50' : ''
          }`}
        >
          <div className="min-w-0">
            <div className="text-sm text-text font-mono truncate">{row.name}</div>
            <div className="text-xs text-text-muted">{row.description}</div>
            {row.dataWarning && <div className="text-xs text-yellow mt-0.5">{row.dataWarning}</div>}
            {row.locked && row.lockReason && <div className="text-xs text-yellow mt-0.5">{row.lockReason}</div>}
          </div>

          <span className={`justify-self-start text-[10px] uppercase tracking-wide font-medium px-1.5 py-0.5 rounded ${BADGE[row.classBadge.tone]}`}>
            {row.classBadge.label}
          </span>

          <div role="radiogroup" aria-label={`Policy for ${row.name}`} className="inline-flex border border-border rounded overflow-hidden justify-self-start">
            {row.policyOptions.map((option) => {
              const active = row.policy === option.value;
              return (
                <button
                  key={option.value}
                  role="radio"
                  aria-checked={active}
                  disabled={busy || option.disabled}
                  title={option.title}
                  onClick={() => !active && onPolicy(row.name, option.value)}
                  className={`px-2.5 py-1 text-xs font-medium border-none cursor-pointer disabled:cursor-not-allowed ${
                    active ? POLICY_ACTIVE[option.value] : 'bg-transparent text-text-muted hover:text-text'
                  } ${option.disabled && !active ? 'opacity-40' : ''}`}
                >
                  {option.label}
                </button>
              );
            })}
          </div>

          <div className="min-w-0 text-xs">
            {row.grantState.kind === 'granted' ? (
              <div className="flex items-center gap-2">
                <span className="text-green font-medium">Granted</span>
                <span className="text-text-muted">until {formatExpiry(row.grantState.expiresAt)}</span>
              </div>
            ) : (
              <button
                disabled={busy || !row.grantable}
                title={row.grantBlockedReason ?? undefined}
                onClick={() => onGrant(row.name)}
                className="px-2.5 py-1 rounded text-xs font-medium cursor-pointer border border-border bg-transparent text-text hover:border-green/50 hover:text-green disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:border-border disabled:hover:text-text"
              >
                Grant to this tab
              </button>
            )}
          </div>

          <div className="md:text-right">
            {row.grantState.kind === 'granted' && (
              <button
                disabled={busy}
                onClick={() => row.grantState.kind === 'granted' && onRevoke(row.grantState.grantId)}
                className="px-2.5 py-1 rounded text-xs font-medium cursor-pointer border border-border bg-transparent text-red hover:bg-red/10 disabled:opacity-40"
              >
                Revoke
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
