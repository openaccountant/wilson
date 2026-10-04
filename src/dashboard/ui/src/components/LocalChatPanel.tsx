import { describeDownloadSize } from '@/hybrid/consent';
import type { UseLocalChatConsentResult } from '@/hooks/useLocalChatConsent';

const link =
  'underline text-text-secondary hover:text-text bg-transparent border-none cursor-pointer p-0 text-xs disabled:opacity-50 disabled:cursor-default whitespace-nowrap';
const btnPrimary =
  'bg-green-700 hover:bg-green-600 text-white text-xs font-medium px-2.5 py-1 rounded-md transition-colors cursor-pointer border-none whitespace-nowrap';

function Shell({ children, tone = 'muted' }: { children: React.ReactNode; tone?: 'muted' | 'warn' }) {
  return (
    <div
      data-testid="local-chat-panel"
      className={`flex flex-wrap items-center gap-x-3 gap-y-1 border rounded-md px-3 py-2 mb-2 text-xs ${
        tone === 'warn' ? 'border-red/40 bg-red/10 text-text' : 'border-border bg-surface text-text-muted'
      }`}
    >
      {children}
    </div>
  );
}

/**
 * The on/off line for on-device chat, above the composer. Same shape as the
 * pre-labeler's panel in the Review tab: "off · Turn on" for an admin, then a
 * consent line naming the model, size and source before anything downloads.
 * Hidden when there is no model, or when it is off and the viewer cannot act.
 */
export function LocalChatPanel({ c, canAct }: { c: UseLocalChatConsentResult; canAct: boolean }) {
  const cfg = c.config;
  const error = c.error ? (
    <span role="alert" data-testid="local-chat-error" className="max-w-[640px]">
      {c.error}
    </span>
  ) : null;
  const offLabel = canAct ? 'Turn off' : 'Stop on this browser';
  const off = (
    <button className={link} onClick={() => void c.turnOff()} disabled={c.busy} data-testid="local-chat-off">
      {c.busy ? 'Turning off…' : offLabel}
    </button>
  );

  switch (c.kind) {
    case 'hidden':
      return null;
    case 'off':
      return (
        <Shell tone={c.error ? 'warn' : 'muted'}>
          <span>On-device chat: off</span>
          <button className={link} onClick={() => void c.turnOn()} disabled={c.busy} data-testid="local-chat-on">
            {c.busy ? 'Turning on…' : 'Turn on'}
          </button>
          {error}
        </Shell>
      );
    case 'consent': {
      const size = describeDownloadSize(cfg?.downloadSize);
      return (
        <Shell tone={c.error ? 'warn' : 'muted'}>
          <span className="max-w-[720px]" data-testid="local-chat-consent">
            On-device chat answers simple questions about your recent transactions with {cfg?.displayName} ({cfg?.repo}). Inference runs on
            this device&rsquo;s GPU. One-time download: {size ?? 'size unknown'} from {cfg?.sourceHost ?? 'huggingface.co'}, cached in this
            browser. A local answer never sends your question or transactions anywhere; anything it cannot answer goes to the server as
            before.
          </span>
          <button className={btnPrimary} onClick={c.consent} data-testid="local-chat-download">
            Download once
          </button>
          {canAct && off}
          {error}
        </Shell>
      );
    }
    case 'no_webgpu':
      return (
        <Shell tone={c.error ? 'warn' : 'muted'}>
          <span>On-device chat is on, but this browser has no WebGPU. Chat uses the server as before.</span>
          {canAct && off}
          {error}
        </Shell>
      );
    case 'on':
      return (
        <Shell tone={c.error ? 'warn' : 'muted'}>
          <span>
            On-device chat: on · {cfg?.displayName} on this device&rsquo;s GPU
          </span>
          {off}
          {error}
        </Shell>
      );
  }
}
