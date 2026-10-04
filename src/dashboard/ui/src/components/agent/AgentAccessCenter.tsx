import { useState } from 'react';
import { agentApi, agentErrorMessage, announceAgentStateChanged } from '@/lib/agent-api';
import type { PolicyValue } from '@agent-access-model';
import { useAgentState } from './useAgentState';
import { KillSwitch } from './KillSwitch';
import { ToolPolicyTable } from './ToolPolicyTable';
import { GrantTtlSelect } from './GrantTtlSelect';
import { JudgeLimitInput } from './JudgeLimitInput';
import { PendingApprovalsList } from './PendingApprovalsList';
import { AuditLogViewer } from './AuditLogViewer';
import { ClientTokensPanel } from './ClientTokensPanel';

/**
 * Settings -> Agent access: the user's control center for everything an AI agent can do in Wilson. One state
 * (`GET /api/mcp/state`) feeds it and the bridge's floating panel, so they cannot disagree.
 *
 * Top to bottom: the global kill switch, what each tool may do (Off / Ask / Allow) and what this tab has been granted,
 * how long new grants last, anything waiting on you, the activity log, and external MCP clients.
 */
export function AgentAccessCenter() {
  const { state, error, refresh } = useAgentState();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');

  /** Run a change, then tell the bridge and the other tabs and refetch. A refusal is shown as the server's own words. */
  async function change(action: () => Promise<unknown>) {
    setBusy(true);
    setProblem('');
    try {
      await action();
    } catch (err) {
      setProblem(agentErrorMessage(err));
    }
    announceAgentStateChanged('settings');
    refresh();
    setBusy(false);
  }

  const put = (path: string, body: unknown) => agentApi(path, { method: 'PUT', body: JSON.stringify(body) });

  if (!state) {
    return (
      <div>
        <h2 className="text-xs text-text-secondary uppercase tracking-wide mb-3">Agent access</h2>
        {error ? (
          <div className="border border-border rounded-lg p-4 text-xs text-red bg-surface-raised">{error}</div>
        ) : (
          <div className="h-[160px] animate-pulse bg-border-muted rounded-lg" />
        )}
      </div>
    );
  }

  const isAdmin = !state.authEnabled || state.role === 'admin';
  const granted = state.tools.filter((t) => t.grant);

  return (
    <div className="space-y-4" data-testid="agent-access-center">
      <div>
        <h2 className="text-xs text-text-secondary uppercase tracking-wide mb-1">Agent access</h2>
        <p className="text-xs text-text-muted">
          What an AI agent may do in Wilson. Nothing is exposed until you grant it, and changes to your data always wait for your approval.
        </p>
      </div>

      <KillSwitch
        state={state}
        canChange={isAdmin}
        busy={busy}
        onChange={(enabled) => void change(() => put('/api/mcp/settings', { enabled }))}
      />

      {problem && <div className="text-xs text-red border border-red/40 bg-red/10 rounded px-3 py-2">{problem}</div>}

      <ToolPolicyTable
        state={state}
        busy={busy}
        onPolicy={(tool, policy: PolicyValue) => void change(() => put(`/api/mcp/policies/${encodeURIComponent(tool)}`, { policy }))}
        onGrant={(tool) => void change(() => agentApi('/api/mcp/grants', { method: 'POST', body: JSON.stringify({ tools: [tool] }) }))}
        onRevoke={(grantId) => void change(() => agentApi(`/api/mcp/grants/${grantId}`, { method: 'DELETE' }))}
      />

      {!state.authEnabled && (
        <p className="text-xs text-yellow border border-yellow/30 bg-yellow/10 rounded px-3 py-2" data-testid="agent-ask-auth-note">
          Dashboard auth is off. Ask is not enforceable for external MCP clients: anyone on this machine, including the client itself, can answer
          its Ask prompt. Enable dashboard auth to make Ask a real approval.
        </p>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <GrantTtlSelect
          minutes={state.grantTtlMinutes}
          options={state.ttlOptions}
          canChange={isAdmin}
          busy={busy}
          onChange={(grantTtlMinutes) => void change(() => put('/api/mcp/settings', { grantTtlMinutes }))}
        />
        {state.judgeDailyLimit !== undefined && (
          <JudgeLimitInput
            limit={state.judgeDailyLimit}
            canChange={isAdmin}
            busy={busy}
            onChange={(judgeDailyLimit) => void change(() => put('/api/mcp/settings', { judgeDailyLimit }))}
          />
        )}
        <button
          disabled={busy || granted.length === 0}
          onClick={() => void change(() => agentApi('/api/mcp/grants/revoke-session', { method: 'POST', body: JSON.stringify({}) }))}
          className="px-3 py-1.5 rounded text-xs font-medium cursor-pointer border border-border bg-transparent text-red hover:bg-red/10 disabled:opacity-40 disabled:cursor-default"
        >
          Revoke all in this tab
        </button>
      </div>

      <PendingApprovalsList pending={state.pending} onChanged={() => { announceAgentStateChanged('settings'); refresh(); }} />

      <AuditLogViewer toolNames={state.tools.map((t) => t.name)} />

      <div className="bg-surface-raised border border-border rounded-lg p-4">
        <ClientTokensPanel
          authEnabled={state.authEnabled}
          isAdmin={isAdmin}
          hasLiveGrants={granted.length > 0}
          onRevokeTabGrants={async () => {
            await agentApi('/api/mcp/grants/revoke-session', { method: 'POST', body: JSON.stringify({}) });
            announceAgentStateChanged('settings');
            refresh();
          }}
        />
      </div>
    </div>
  );
}
