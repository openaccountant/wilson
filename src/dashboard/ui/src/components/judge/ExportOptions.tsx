import { useState } from 'react';
import { authedFetch } from '@/api';
import { HoldToApprove } from '@/components/agent/HoldToApprove';
import { agentErrorMessage } from '@/lib/agent-api';
import {
  DEFAULT_EXPORT_CHOICES,
  JUDGE_ENABLE_AFTER_MS,
  JUDGE_HOLD_MS,
  exportFileName,
  exportNeedsHold,
  exportPath,
  type ExportChoices,
} from '@judge-ui';

const BUTTON =
  'bg-surface-raised border border-border text-text-secondary text-xs font-medium px-3 py-1.5 rounded-md hover:bg-surface hover:text-text transition-colors cursor-pointer';

/**
 * The training export. The default is human labels only. Each opt-in is its own checkbox, starts off, and goes
 * back to off after every export; with any of them checked the download is a press-and-hold. The file arrives
 * through `fetch` with the Authorization header and a Blob: the token never goes into a URL.
 */
export function ExportOptions({ handoffExcluded }: { handoffExcluded?: { sft: number; dpo: number } }) {
  const [choices, setChoices] = useState<ExportChoices>(DEFAULT_EXPORT_CHOICES);
  const [message, setMessage] = useState('');
  const hold = exportNeedsHold(choices);
  const choiceKey = `${choices.includeJudge}${choices.includeAgentPresent}${choices.includeHandoff}`;

  async function download(format: 'sft' | 'dpo') {
    const used = choices;
    setMessage('');
    try {
      const res = await authedFetch(exportPath(format, used));
      if (!res.ok) throw new Error(`API ${res.status}: ${await res.text().catch(() => '')}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = exportFileName(format, used);
      a.click();
      URL.revokeObjectURL(url);
      setMessage(`Exported ${exportFileName(format, used)} (${res.headers.get('X-Wilson-Export-Provenance') ?? 'human'}).`);
    } catch (err) {
      setMessage(agentErrorMessage(err));
    }
    // Reset after every export, even a failed one: an opt-in is for one download.
    setChoices(DEFAULT_EXPORT_CHOICES);
  }

  const box = (key: keyof ExportChoices, label: string) => (
    <label className="flex items-center gap-2 text-xs text-text-secondary cursor-pointer">
      <input type="checkbox" checked={choices[key]} onChange={(e) => setChoices({ ...choices, [key]: e.target.checked })} className="cursor-pointer" />
      {label}
    </label>
  );

  return (
    <div className="flex flex-wrap items-start gap-x-6 gap-y-2" data-testid="export-options">
      <div className="flex items-center gap-3">
        {hold ? (
          <>
            <div key={`sft${choiceKey}`} className="w-40">
              <HoldToApprove label="Hold to export SFT" holdMs={JUDGE_HOLD_MS} enableAfterMs={JUDGE_ENABLE_AFTER_MS} tone="amber" onConfirmed={() => void download('sft')} />
            </div>
            <div key={`dpo${choiceKey}`} className="w-40">
              <HoldToApprove label="Hold to export DPO" holdMs={JUDGE_HOLD_MS} enableAfterMs={JUDGE_ENABLE_AFTER_MS} tone="amber" onConfirmed={() => void download('dpo')} />
            </div>
          </>
        ) : (
          <>
            <button onClick={() => void download('sft')} className={BUTTON}>Export SFT</button>
            <button onClick={() => void download('dpo')} className={BUTTON}>Export DPO</button>
          </>
        )}
      </div>
      <div className="space-y-1">
        {box('includeJudge', 'Include accepted agent judgements')}
        {box('includeAgentPresent', 'Include ratings made while an agent had access')}
        {box('includeHandoff', 'Include prompts with on-device assistant notes')}
        {handoffExcluded && handoffExcluded.sft + handoffExcluded.dpo > 0 && (
          <div className="text-[11px] text-text-muted">
            {handoffExcluded.sft} run{handoffExcluded.sft === 1 ? '' : 's'} and {handoffExcluded.dpo} pair{handoffExcluded.dpo === 1 ? '' : 's'} with on-device notes are left out.
          </div>
        )}
        {message && <div role="status" className="text-[11px] text-text-muted">{message}</div>}
      </div>
    </div>
  );
}
