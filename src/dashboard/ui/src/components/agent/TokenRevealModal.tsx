import type { TokenRevealModel } from '@webmcp-token-reveal';

/**
 * The one place a client token's plaintext is shown. It is not rendered while this tab holds a live agent grant
 * (an agent that can read the page would read the token too), and the panel wipes its copy after 30 s.
 */
export function TokenRevealModal({
  model,
  onClose,
  onRevokeGrants,
  onCopy,
  copied,
  revoking,
}: {
  model: TokenRevealModel;
  onClose: () => void;
  onRevokeGrants: () => void;
  onCopy: (text: string) => void;
  copied: boolean;
  revoking: boolean;
}) {
  // `closed` and `expired` render nothing: the plaintext is already wiped from state by the panel.
  if (model.kind === 'closed' || model.kind === 'expired') return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true" aria-label="New client token">
      <div className="bg-surface-raised border border-border rounded-lg p-5 w-full max-w-lg space-y-3">
        <div className="text-sm text-text font-medium">New client token</div>
        {model.kind === 'blocked' ? (
          <>
            <p className="text-xs text-text-muted">
              An agent that can read this page could read the token too, so it stays hidden while this tab has live agent grants.
            </p>
            <div className="text-xs text-yellow">{model.message}</div>
            <div className="flex gap-2">
              <button
                onClick={onRevokeGrants}
                disabled={revoking}
                className="px-3 py-1.5 rounded text-xs font-medium cursor-pointer border-none bg-red/20 text-red hover:bg-red/30 disabled:opacity-40 disabled:cursor-default"
              >
                {revoking ? 'Revoking…' : "Revoke this tab's agent grants"}
              </button>
            </div>
          </>
        ) : (
          <>
            <code className="block font-mono text-xs text-text break-all bg-surface border border-border rounded p-2 select-all" data-testid="client-token-plaintext">
              {model.token}
            </code>
            <p className="text-xs text-yellow">Shown once. Store it in your MCP client config now.</p>
            <div className="flex items-center gap-2">
              <button
                onClick={() => onCopy(model.token)}
                className="px-3 py-1.5 rounded text-xs font-medium cursor-pointer border-none bg-green/15 text-green hover:bg-green/25"
              >
                {copied ? 'Copied' : 'Copy'}
              </button>
              <button
                onClick={onClose}
                className="px-3 py-1.5 rounded text-xs font-medium cursor-pointer border border-border bg-transparent text-text-muted hover:text-text"
              >
                I saved it
              </button>
              <span className="text-xs text-text-muted ml-auto">Hides in {model.secondsLeft}s</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
