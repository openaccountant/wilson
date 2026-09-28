import { useEffect, useRef, useState } from 'react';

function fmtNumber(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

interface NumberFieldProps {
  label: string;
  ariaLabel: string;
  defaultValue: number;
  /** Silently sanitizes a parsed-but-out-of-range value (e.g. negative income clamped to 0). */
  clamp?: (v: number) => number;
  onChange: (value: number) => void;
}

/**
 * A single manual-input field. Never throws, never blocks: a blank or
 * unparseable entry falls back to the last good value (starting at the
 * prefilled default) and the simulation keeps running on it — matching
 * `sanitizeScale`'s no-throw posture. Only the "blank/unparseable" case gets
 * the red hint; an out-of-range-but-parseable value (e.g. negative income) is
 * clamped silently.
 */
function NumberField({ label, ariaLabel, defaultValue, clamp, onChange }: NumberFieldProps) {
  const [raw, setRaw] = useState(() => String(defaultValue));
  const lastGoodRef = useRef(defaultValue);
  const parsed = Number(raw);
  const invalid = raw.trim() === '' || !Number.isFinite(parsed);
  const effective = invalid ? lastGoodRef.current : clamp ? clamp(parsed) : parsed;

  useEffect(() => {
    if (!invalid) lastGoodRef.current = effective;
    onChange(effective);
    // Intentionally re-runs only when the raw text changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [raw]);

  return (
    <div>
      <label className="block text-xs text-text-muted mb-1">{label}</label>
      <input
        type="number"
        inputMode="decimal"
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
        aria-label={ariaLabel}
        className={`w-full bg-surface border rounded px-2 py-1 text-sm text-text ${
          invalid ? 'border-red' : 'border-border'
        }`}
      />
      {invalid && (
        <p className="text-xs text-red mt-1">
          Enter a number — using {fmtNumber(lastGoodRef.current)} for now.
        </p>
      )}
    </div>
  );
}

interface ManualInputsFormProps {
  defaultStartNetWorth: number;
  defaultMonthlyIncome: number;
  defaultMonthlyContribution: number;
  onStartNetWorthChange: (value: number) => void;
  onMonthlyIncomeChange: (value: number) => void;
  onMonthlyContributionChange: (value: number) => void;
}

/**
 * Shown instead of the derived-from-history inputs when
 * `deriveNetWorthInputs` returns null (fewer than
 * `NET_WORTH_MIN_HISTORY_MONTHS` usable months). Values are not persisted —
 * same rule as the sliders — and prefill from whatever partial history
 * exists (1-5 months), which is strictly better than zeros.
 */
export function ManualInputsForm({
  defaultStartNetWorth,
  defaultMonthlyIncome,
  defaultMonthlyContribution,
  onStartNetWorthChange,
  onMonthlyIncomeChange,
  onMonthlyContributionChange,
}: ManualInputsFormProps) {
  return (
    <div className="bg-surface-raised border border-border rounded-lg p-4">
      <p className="text-sm text-text-muted mb-3">
        Less than six months of history — the projection is using the numbers you enter below
        instead of your transaction history.
      </p>
      <div className="grid grid-cols-3 gap-3">
        <NumberField
          label="Starting net worth"
          ariaLabel="Starting net worth, dollars"
          defaultValue={defaultStartNetWorth}
          onChange={onStartNetWorthChange}
        />
        <NumberField
          label="Monthly income"
          ariaLabel="Monthly income, dollars"
          defaultValue={defaultMonthlyIncome}
          clamp={(v) => Math.max(0, v)}
          onChange={onMonthlyIncomeChange}
        />
        <NumberField
          label="Monthly savings"
          ariaLabel="Monthly savings, income minus expenses, dollars"
          defaultValue={defaultMonthlyContribution}
          onChange={onMonthlyContributionChange}
        />
      </div>
    </div>
  );
}
