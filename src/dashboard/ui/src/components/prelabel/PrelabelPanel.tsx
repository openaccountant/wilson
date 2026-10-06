import { useEffect } from 'react';
import type { PrelabelResult } from '@/prelabel/protocol';
import type { PanelState } from '@/prelabel/session';
import { usePrelabel } from '@/prelabel/usePrelabel';
import { MeasurePanel } from './MeasurePanel';
import type { ReviewQueueItem } from '@/types';

const MB = (bytes: number) => `${Math.round(bytes / 1_000_000)} MB`;

const UNAVAILABLE_COPY: Record<string, string> = {
  dev_cross_origin: 'The second opinion needs the built dashboard (wilson --dashboard), not the vite dev server.',
  worker_unavailable: 'The second-opinion engine is not built into this dashboard. Your review queue works as before.',
};

function Shell({ children, tone = 'muted' }: { children: React.ReactNode; tone?: 'muted' | 'warn' }) {
  return (
    <div
      data-testid="prelabel-panel"
      className={`flex flex-wrap items-center gap-x-3 gap-y-1 border rounded-md px-3 py-2 text-xs ${
        tone === 'warn' ? 'border-red/40 bg-red/10 text-text' : 'border-border bg-surface-raised text-text-muted'
      }`}
    >
      {children}
    </div>
  );
}

const btn =
  'bg-surface-raised hover:bg-border-muted text-text-secondary border border-border text-xs font-medium px-2.5 py-1 rounded-md transition-colors cursor-pointer whitespace-nowrap';
const btnPrimary =
  'bg-green-700 hover:bg-green-600 text-white text-xs font-medium px-2.5 py-1 rounded-md transition-colors cursor-pointer border-none whitespace-nowrap';

/**
 * Second opinion from open-jev, run on this computer's GPU. Owns the worker via
 * usePrelabel and reports scores up to ReviewTab, which orders and annotates the
 * queue. When the feature is off (the default) and the viewer cannot act it
 * renders nothing; otherwise a single muted line offers to turn it on.
 */
export function PrelabelPanel({
  reviews,
  canAct,
  onResults,
}: {
  reviews: readonly ReviewQueueItem[];
  canAct: boolean;
  onResults: (results: Map<number, PrelabelResult>, marginCut: number, active: boolean) => void;
}) {
  const p = usePrelabel(reviews);
  const { state, config } = p;

  const active = state.kind !== 'init' && state.kind !== 'off' && state.kind !== 'unavailable' && state.kind !== 'locked';
  useEffect(() => {
    onResults(p.results, p.marginCut, active);
  }, [p.results, p.marginCut, active, onResults]);

  // Measurement is a separate admin tool, behind ?prelabelMeasure=1.
  const showMeasure = canAct && state.kind !== 'off' && new URLSearchParams(window.location.search).get('prelabelMeasure') === '1';

  return (
    <div className="space-y-3">
      <PanelBody p={p} state={state} canAct={canAct} bytes={config?.approxDownloadBytes ?? 350_631_305} />
      {showMeasure && <MeasurePanel ready={state.kind === 'ready'} config={config} measure={p.measure} />}
    </div>
  );
}

function PanelBody({
  p,
  state,
  canAct,
  bytes,
}: {
  p: ReturnType<typeof usePrelabel>;
  state: PanelState;
  canAct: boolean;
  bytes: number;
}) {
  switch (state.kind) {
    case 'init':
    case 'probing':
      return null;
    case 'off':
      if (!canAct) return null;
      return (
        <Shell tone={p.turnOnError ? 'warn' : 'muted'}>
          <span>Second opinion (open-jev): off</span>
          <button
            className="underline text-text-secondary hover:text-text bg-transparent border-none cursor-pointer p-0 text-xs disabled:opacity-50 disabled:cursor-default"
            onClick={() => void p.turnOn()}
            disabled={p.turnOnBusy}
          >
            {p.turnOnBusy ? 'Turning on…' : 'Turn on'}
          </button>
          {p.turnOnError && (
            <span role="alert" data-testid="prelabel-turn-on-error" className="max-w-[640px]">
              {p.turnOnError}
            </span>
          )}
        </Shell>
      );
    case 'unavailable':
      return (
        <Shell>
          <span>
            {UNAVAILABLE_COPY[state.reason] ?? 'open-jev needs WebGPU with shader-f16. Your review queue works as before.'}
          </span>
          <span className="font-mono text-[10px] uppercase">{state.reason}</span>
        </Shell>
      );
    case 'locked':
      return <Shell>Second opinion is running in another tab.</Shell>;
    case 'consent':
      return (
        <Shell>
          <span className="max-w-[640px]">
            Second opinion from open-jev runs on this computer&rsquo;s GPU. One-time download: about {MB(bytes)} from huggingface.co (a pinned
            model version). Transaction text never leaves this machine; later visits make about 1 KB of version checks to huggingface.co.
          </span>
          <button className={btnPrimary} onClick={p.consent} data-testid="prelabel-download">
            Download once
          </button>
        </Shell>
      );
    case 'loading': {
      const pct = state.total > 0 ? Math.min(100, Math.round((state.loaded / state.total) * 100)) : 0;
      return (
        <Shell>
          <span>
            {state.phase === 'download'
              ? `Downloading open-jev ${state.total > 0 ? `${MB(state.loaded)} / ${MB(state.total)}` : '…'}`
              : state.phase === 'session'
                ? 'Starting the model on the GPU…'
                : 'Warming up…'}
          </span>
          <span className="inline-block h-1.5 w-40 bg-border-muted rounded overflow-hidden" aria-hidden>
            <span className="block h-full bg-green" style={{ width: `${state.phase === 'download' ? pct : 100}%` }} />
          </span>
        </Shell>
      );
    }
    case 'running':
      return (
        <Shell>
          <span className="font-mono" data-testid="prelabel-progress">
            Scoring {state.done} / {state.total}
            {state.p50Ms ? ` · p50 ${Math.round(state.p50Ms)} ms` : ''}
          </span>
          <button className={btn} onClick={p.cancel}>
            Cancel
          </button>
        </Shell>
      );
    case 'ready': {
      const c = p.config;
      return (
        <Shell>
          <span className="font-mono text-[10px] uppercase">
            open-jev {c?.pins.dtype ?? ''} · T {c?.pins.temperature ?? ''} · {c ? c.labelSetVersion.slice(0, 11) + '…' : ''}
            {p.p50Ms ? ` · p50 ${Math.round(p.p50Ms)} ms` : ''}
          </span>
          {p.unscoredCount > 0 ? (
            <button className={btn} onClick={p.scoreUnscored}>
              Score {p.unscoredCount} unscored
            </button>
          ) : (
            <span>All pending rows scored. Nothing is applied until you click.</span>
          )}
        </Shell>
      );
    }
    case 'failed':
      return (
        <Shell tone="warn">
          <span>
            Second opinion failed ({state.reason}){state.detail ? `: ${state.detail}` : ''}. Your review queue works as before.
          </span>
          {state.reason === 'load' || state.reason === 'decide' ? (
            <button className={btn} onClick={p.retry}>
              Retry
            </button>
          ) : null}
        </Shell>
      );
    case 'profile_changed':
      return <Shell tone="warn">Profile changed; reload to score this profile.</Shell>;
  }
}
