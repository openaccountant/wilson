import { ttlLabel } from '@agent-access-model';

/** How long a NEW grant lasts for this profile. Existing grants keep the expiry they were made with. Admin-only. */
export function GrantTtlSelect({
  minutes,
  options,
  canChange,
  busy,
  onChange,
}: {
  minutes: number;
  options: number[];
  canChange: boolean;
  busy: boolean;
  onChange: (minutes: number) => void;
}) {
  return (
    <div className="flex items-center gap-2 text-xs text-text-muted">
      <label htmlFor="grant-ttl">New grants for this profile expire after</label>
      {canChange ? (
        <select
          id="grant-ttl"
          value={minutes}
          disabled={busy}
          onChange={(e) => onChange(Number(e.target.value))}
          className="bg-surface border border-border rounded px-2 py-1 text-xs text-text disabled:opacity-40"
        >
          {options.map((m) => (
            <option key={m} value={m}>
              {ttlLabel(m)}
            </option>
          ))}
        </select>
      ) : (
        <span className="text-text font-medium">{ttlLabel(minutes)}</span>
      )}
      <span>· existing grants keep their own expiry</span>
    </div>
  );
}
