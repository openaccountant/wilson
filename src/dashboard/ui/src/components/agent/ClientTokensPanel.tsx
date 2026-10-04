import { useEffect, useState } from 'react';
import { useApi } from '@/hooks/useApi';
import { agentApi, agentErrorMessage } from '@/lib/agent-api';
import { tokenRevealModel } from '@webmcp-token-reveal';
import { TokenRevealModal } from './TokenRevealModal';

// External MCP clients (Claude Code, Hronaut, any MCP client) do not use this tab's session. Each gets its own
// token: minted here, shown once, stored server-side only as a hash, revocable, rotatable, and with a tool list
// you can change later. While dashboard auth is off a token can carry read tools only: without a login to approve
// a card, the client could approve its own changes.

interface CatalogTool {
  name: string;
  description: string;
  classification: string;
  /** Where the server offers the tool: `webmcp` (a tab) and/or `http-mcp` (external clients). */
  transports: string[];
}

interface ClientToken {
  id: string;
  name: string;
  token_prefix: string;
  tools: string[];
  created_at: string;
  expires_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

const TOKEN_EXPIRY_OPTIONS = [1, 7, 30, 90] as const;

function formatTokenTime(value: string | null): string {
  if (!value) return 'never';
  const date = new Date(value.includes('T') ? value : value.replace(' ', 'T') + 'Z');
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function ToolPicker({
  tools,
  selected,
  canWrite,
  authEnabled,
  disabled,
  onToggle,
}: {
  tools: CatalogTool[];
  selected: Set<string>;
  canWrite: boolean;
  authEnabled: boolean;
  disabled: boolean;
  onToggle: (tool: CatalogTool) => void;
}) {
  return (
    <div className="space-y-1">
      {tools.map((tool) => {
        const locked = tool.classification !== 'read' && !canWrite;
        return (
          <label
            key={tool.name}
            className={`flex items-start gap-2 px-1 py-0.5 rounded ${locked ? 'opacity-50' : 'cursor-pointer hover:bg-border-muted/30'}`}
            title={
              locked
                ? authEnabled
                  ? 'Viewer accounts can use read-only tools only'
                  : 'Enable dashboard auth to give external clients write tools.'
                : undefined
            }
          >
            <input type="checkbox" className="mt-0.5" checked={selected.has(tool.name)} disabled={locked || disabled} onChange={() => onToggle(tool)} />
            <span className="text-xs text-text font-mono">
              {tool.name}
              {tool.classification !== 'read' && (
                <span className="ml-2 text-[10px] uppercase tracking-wide font-sans font-medium px-1.5 py-0.5 rounded bg-yellow/15 text-yellow">WRITE</span>
              )}
            </span>
          </label>
        );
      })}
      {!canWrite && !authEnabled && (
        <div className="text-xs text-text-muted pt-1">Enable dashboard auth to give external clients write tools.</div>
      )}
    </div>
  );
}

export function ClientTokensPanel({
  authEnabled,
  isAdmin,
  hasLiveGrants,
  onRevokeTabGrants,
}: {
  authEnabled: boolean;
  isAdmin: boolean;
  hasLiveGrants: boolean;
  onRevokeTabGrants: () => Promise<void>;
}) {
  const catalog = useApi<{ tools: CatalogTool[] }>('/api/mcp/catalog');
  const tokensApi = useApi<{ tokens: ClientToken[] }>('/api/mcp/client-tokens');
  const tokens = tokensApi.data?.tokens ?? [];
  const externalTools = (catalog.data?.tools ?? []).filter((t) => t.transports.includes('http-mcp'));

  const [name, setName] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [days, setDays] = useState<number>(30);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState('');
  // Editing the tools of an existing token.
  const [editing, setEditing] = useState<{ id: string; selected: Set<string> } | null>(null);
  // The plaintext lives only here, in memory, from the mint response until "I saved it" or 30 s after it is shown.
  const [plaintext, setPlaintext] = useState<string | null>(null);
  const [revealedAt, setRevealedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const canMintWriters = authEnabled && isAdmin;
  const reveal = tokenRevealModel({ token: plaintext, hasLiveGrants, revealedAt, now });
  const endpoint = `${window.location.origin}/mcp`;

  // The 30 s clock starts when the plaintext is first actually shown, and the plaintext is wiped once it ends.
  useEffect(() => {
    if (reveal.kind === 'shown' && revealedAt === null) setRevealedAt(Date.now());
    if (reveal.kind === 'expired') {
      setPlaintext(null);
      setRevealedAt(null);
    }
  }, [reveal.kind, revealedAt]);

  useEffect(() => {
    if (plaintext === null) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [plaintext]);

  function closeReveal() {
    setPlaintext(null);
    setRevealedAt(null);
  }

  function toggleIn(set: Set<string>, tool: CatalogTool): Set<string> {
    const next = new Set(set);
    if (next.has(tool.name)) {
      next.delete(tool.name);
    } else {
      next.add(tool.name);
      // A write call can outlive the connection's wait; the client reconciles with get_operation_result.
      if (tool.classification !== 'read') next.add('get_operation_result');
    }
    return next;
  }

  async function run(action: () => Promise<{ token: string } | void>) {
    setBusy(true);
    setError('');
    try {
      const result = await action();
      if (result) {
        setPlaintext(result.token);
        setRevealedAt(null);
        setNow(Date.now());
      }
    } catch (err) {
      setError(agentErrorMessage(err));
    } finally {
      tokensApi.refetch();
      setBusy(false);
    }
  }

  const handleMint = () =>
    run(async () => {
      const res = await agentApi<{ token: string }>('/api/mcp/client-tokens', {
        method: 'POST',
        body: JSON.stringify({ name: name.trim(), tools: [...selected], expiresInDays: days }),
      });
      setName('');
      setSelected(new Set());
      return res;
    });

  const handleRevoke = (id: string) => run(async () => void (await agentApi(`/api/mcp/client-tokens/${id}`, { method: 'DELETE' })));
  const handleRotate = (id: string) => run(() => agentApi<{ token: string }>(`/api/mcp/client-tokens/${id}/rotate`, { method: 'POST' }));
  const handleSaveTools = (id: string, tools: Set<string>) =>
    run(async () => {
      await agentApi(`/api/mcp/client-tokens/${id}/tools`, { method: 'PUT', body: JSON.stringify({ tools: [...tools] }) });
      setEditing(null);
    });

  async function copy(label: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
      setTimeout(() => setCopied(''), 1500);
    } catch {
      // Clipboard blocked (insecure context / permissions): the value is still visible to select.
    }
  }

  const canMint = name.trim().length > 0 && selected.size > 0 && !busy;

  return (
    <div className="space-y-3" data-testid="agent-client-tokens">
      <div className="text-sm text-text font-medium">External MCP clients</div>
      <p className="text-xs text-text-muted">
        Give Claude Code, Hronaut or any MCP client its own token. Each token carries only the tools you pick, expires, and can be revoked at any
        time. {canMintWriters ? 'Changes to your data still wait for your approval here.' : 'Until dashboard auth is enabled, external clients can read but never propose changes, and an Ask on a read is not a real approval (anyone on this machine can answer it).'}
      </p>

      <div className="grid grid-cols-[auto_1fr_auto] items-center gap-x-3 gap-y-1.5 text-xs">
        <span className="text-text-muted">Endpoint</span>
        <code className="font-mono text-text truncate">{endpoint}</code>
        <button
          onClick={() => void copy('endpoint', endpoint)}
          className="text-xs text-text-muted hover:text-text bg-transparent border border-border rounded px-2 py-0.5 cursor-pointer"
        >
          {copied === 'endpoint' ? 'Copied' : 'Copy'}
        </button>
      </div>

      <div className="space-y-2 border border-border rounded p-3">
        <div className="text-xs text-text-secondary uppercase tracking-wide">New token</div>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={40}
          placeholder="Name, e.g. Hronaut laptop"
          className="w-full bg-surface border border-border rounded px-2 py-1 text-xs text-text"
          aria-label="Token name"
        />
        <ToolPicker
          tools={externalTools}
          selected={selected}
          canWrite={canMintWriters}
          authEnabled={authEnabled}
          disabled={busy}
          onToggle={(tool) => setSelected((prev) => toggleIn(prev, tool))}
        />
        <div className="flex items-center gap-2">
          <label className="text-xs text-text-muted" htmlFor="token-expiry">Expires in</label>
          <select
            id="token-expiry"
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            className="bg-surface border border-border rounded px-2 py-1 text-xs text-text"
          >
            {TOKEN_EXPIRY_OPTIONS.map((d) => (
              <option key={d} value={d}>{d === 1 ? '1 day' : `${d} days`}</option>
            ))}
          </select>
          <button
            onClick={() => void handleMint()}
            disabled={!canMint}
            className="ml-auto px-3 py-1.5 rounded text-xs font-medium cursor-pointer border-none bg-green/15 text-green hover:bg-green/25 disabled:opacity-40 disabled:cursor-default"
          >
            Mint token
          </button>
        </div>
      </div>

      {error && <div className="text-xs text-red">{error}</div>}

      {tokens.length > 0 && (
        <div className="space-y-1">
          {tokens.map((t) => {
            const inactive = t.revoked_at !== null || new Date(t.expires_at).getTime() <= now;
            const isEditing = editing?.id === t.id;
            return (
              <div key={t.id} className="border border-border rounded px-2 py-1.5 text-xs space-y-2">
                <div className="flex items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="text-text truncate">
                      {t.name} <code className="font-mono text-text-muted">{t.token_prefix}…</code>
                      {t.revoked_at && <span className="ml-2 text-red">revoked</span>}
                    </div>
                    <div className="text-text-muted truncate">
                      {t.tools.length > 0 ? t.tools.join(', ') : 'no tools'} · expires {formatTokenTime(t.expires_at)} · last used {formatTokenTime(t.last_used_at)}
                    </div>
                  </div>
                  {!inactive && (
                    <>
                      <button
                        onClick={() => setEditing(isEditing ? null : { id: t.id, selected: new Set(t.tools) })}
                        disabled={busy}
                        className="text-xs text-text-muted hover:text-text bg-transparent border border-border rounded px-2 py-0.5 cursor-pointer disabled:opacity-40"
                      >
                        {isEditing ? 'Cancel' : 'Tools'}
                      </button>
                      <button
                        onClick={() => void handleRotate(t.id)}
                        disabled={busy}
                        className="text-xs text-text-muted hover:text-text bg-transparent border border-border rounded px-2 py-0.5 cursor-pointer disabled:opacity-40"
                      >
                        Rotate
                      </button>
                      <button
                        onClick={() => void handleRevoke(t.id)}
                        disabled={busy}
                        className="text-xs text-red bg-transparent border border-border rounded px-2 py-0.5 cursor-pointer disabled:opacity-40"
                      >
                        Revoke
                      </button>
                    </>
                  )}
                </div>
                {isEditing && editing && (
                  <div className="border-t border-border-muted pt-2 space-y-2">
                    <ToolPicker
                      tools={externalTools}
                      selected={editing.selected}
                      canWrite={canMintWriters}
                      authEnabled={authEnabled}
                      disabled={busy}
                      onToggle={(tool) => setEditing({ id: t.id, selected: toggleIn(editing.selected, tool) })}
                    />
                    <button
                      onClick={() => void handleSaveTools(t.id, editing.selected)}
                      disabled={busy || editing.selected.size === 0}
                      className="px-3 py-1.5 rounded text-xs font-medium cursor-pointer border-none bg-green/15 text-green hover:bg-green/25 disabled:opacity-40 disabled:cursor-default"
                    >
                      Save tools
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <p className="text-xs text-text-muted">Browser extensions with access to localhost can act as you. Grant only what you need.</p>

      <TokenRevealModal
        model={reveal}
        onClose={closeReveal}
        onRevokeGrants={() => void run(onRevokeTabGrants)}
        onCopy={(text) => void copy('token', text)}
        copied={copied === 'token'}
        revoking={busy}
      />
    </div>
  );
}
