import { useEffect, useState } from 'react';

/**
 * How many judge proposals may be added per day in this profile. Admin only, and it can be changed only here:
 * no agent tool takes it, so a prompt-injected judge cannot raise its own quota.
 */
export function JudgeLimitInput({ limit, canChange, busy, onChange }: { limit: number; canChange: boolean; busy: boolean; onChange: (limit: number) => void }) {
  const [draft, setDraft] = useState(String(limit));
  useEffect(() => setDraft(String(limit)), [limit]);
  const parsed = Number(draft);
  const valid = Number.isInteger(parsed) && parsed >= 1 && parsed <= 2000;

  return (
    <div className="flex items-center gap-2 text-xs text-text-muted">
      <label htmlFor="judge-daily-limit">Agent judge proposals per day</label>
      {canChange ? (
        <>
          <input
            id="judge-daily-limit"
            type="number"
            min={1}
            max={2000}
            value={draft}
            disabled={busy}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => valid && parsed !== limit && onChange(parsed)}
            onKeyDown={(e) => e.key === 'Enter' && valid && parsed !== limit && onChange(parsed)}
            className="w-20 bg-surface border border-border rounded px-2 py-1 text-xs text-text font-mono disabled:opacity-40"
          />
          {!valid && <span className="text-yellow">1 to 2,000</span>}
        </>
      ) : (
        <span className="text-text font-medium font-mono">{limit}</span>
      )}
      <span>· proposals stay inert until you accept them</span>
    </div>
  );
}
