import { AGENT_BANNER_TEXT } from '@declarative-submit';
import { outcomeCopy } from '@confirmation-card';

/**
 * Shown above a declarative form while an agent has filled it and nothing has submitted it yet. Amber is the
 * dashboard's colour for "a permission or an agent is involved"; the form's outline (app.css, `:tool-form-active`)
 * is the other half of the same cue.
 */
export function AgentFilledBanner() {
  return (
    <div role="status" className="mb-3 flex items-center gap-2 rounded border border-yellow/40 bg-yellow/10 px-3 py-2 text-xs text-yellow">
      <span className="font-mono text-[10px] font-semibold uppercase tracking-wider">Agent</span>
      <span>{AGENT_BANNER_TEXT}</span>
    </div>
  );
}

/** How an agent-touched form's human submit ended, in the same words the approval card uses. */
export function AgentOutcomeNote({ outcome }: { outcome: unknown }) {
  if (outcome === null || outcome === undefined) return null;
  const o = outcome as { outcome?: string; message?: string };
  const text = o.outcome === 'error' ? (o.message ?? 'The request failed.') : outcomeCopy(o.outcome ?? 'unknown');
  return (
    <p role="status" className={`mt-2 text-xs ${o.outcome === 'committed' ? 'text-green' : 'text-text-muted'}`}>
      {text}
    </p>
  );
}
