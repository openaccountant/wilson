import { useState } from 'react';
import { Dialog } from '@/components/Dialog';
import type { AgentState } from '@agent-access-model';

/**
 * The global switch. On: agent access works as configured below. Off: no tool is exposed to any agent or MCP
 * client, in any profile, grants are revoked and pending approvals are rejected. Turning it off asks first.
 */
export function KillSwitch({
  state,
  canChange,
  busy,
  onChange,
}: {
  state: AgentState;
  canChange: boolean;
  busy: boolean;
  onChange: (enabled: boolean) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const live = state.tools.filter((t) => t.grant).length;

  return (
    <div
      className={`rounded-lg border p-4 ${state.enabled ? 'bg-surface-raised border-border' : 'border-red/50 bg-red/10'}`}
      data-testid="agent-kill-switch"
    >
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="text-sm font-medium text-text">Agent access (all profiles)</div>
          {state.enabled ? (
            <div className={`text-xs mt-0.5 ${live > 0 ? 'text-green' : 'text-text-muted'}`}>
              {live} tool{live === 1 ? '' : 's'} live in this tab · {state.pending.length} pending
            </div>
          ) : (
            <div className="text-xs mt-0.5 text-red">Agent access is off. No tools are exposed to any agent or MCP client.</div>
          )}
        </div>
        <button
          role="switch"
          aria-checked={state.enabled}
          aria-label="Agent access"
          disabled={busy || !canChange}
          title={canChange ? undefined : 'Only an admin can change this'}
          onClick={() => (state.enabled ? setConfirming(true) : onChange(true))}
          className={`shrink-0 px-3 py-1.5 rounded border text-xs font-mono font-semibold cursor-pointer disabled:opacity-40 disabled:cursor-default ${
            state.enabled ? 'border-green/50 bg-green/15 text-green hover:bg-green/25' : 'border-red/50 bg-red/15 text-red hover:bg-red/25'
          }`}
        >
          {state.enabled ? 'ON' : 'OFF'}
        </button>
      </div>

      <Dialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title="Turn off agent access?"
        footer={
          <div className="flex justify-end gap-2">
            <button
              onClick={() => setConfirming(false)}
              className="px-3 py-1.5 rounded text-xs font-medium cursor-pointer border border-border bg-transparent text-text-muted hover:text-text"
            >
              Cancel
            </button>
            <button
              onClick={() => {
                setConfirming(false);
                onChange(false);
              }}
              className="px-3 py-1.5 rounded text-xs font-medium cursor-pointer border-none bg-red/20 text-red hover:bg-red/30"
            >
              Turn off
            </button>
          </div>
        }
      >
        <p className="text-sm text-text-secondary">
          Every grant is revoked, pending approvals are rejected, and no tool is exposed to any agent or MCP client in any profile.
          Turning it back on does not bring grants back: grant again from this page.
        </p>
      </Dialog>
    </div>
  );
}
