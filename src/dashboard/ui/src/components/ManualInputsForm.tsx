import { useEffect, useRef, useState } from 'react';
import { useDeclarativeTool } from '@/agent/useDeclarativeTool';
import { AgentOutcomeNote } from '@/components/agent/AgentFilledBanner';

function fmtNumber(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

/** Round to cents so float noise (e.g. 183475.98199999996) never shows in a field. */
function cents(n: number): number {
  return Math.round(n * 100) / 100;
}

interface NumberFieldProps {
  label: string;
  ariaLabel: string;
  /** The form control's name: it is also the tool parameter an agent fills. */
  name: string;
  /** The text in the box. Owned by the form, so an agent's entry can set it. */
  raw: string;
  onRawChange: (raw: string) => void;
  /** Extra attributes for the input (the live tool's `toolparamdescription`). */
  extraProps?: Record<string, string>;
  defaultValue: number;
  /** Silently sanitizes a parsed-but-out-of-range value (e.g. negative income clamped to 0). */
  clamp?: (v: number) => number;
  onChange: (value: number) => void;
  /**
   * An agent filled the form and the server has not authorized it yet (policy Ask): the box shows the agent's text but
   * the projection keeps running on the human's numbers. Lifting the hold applies whatever the box holds then.
   */
  held?: boolean;
  /** The hold read at effect time from the hook's live flag (`effectsHeldRef`); render state lags the `toolactivated` event. */
  isHeldNow?: () => boolean;
  /** Changes whenever the hold turns on or off, so lifting it re-runs the effect even if no render saw it set. */
  holdEpoch?: number;
}

/**
 * A single manual-input field. Never throws, never blocks: a blank or
 * unparseable entry falls back to the last good value (starting at the
 * prefilled default) and the simulation keeps running on it — matching
 * `sanitizeScale`'s no-throw posture. Only the "blank/unparseable" case gets
 * the red hint; an out-of-range-but-parseable value (e.g. negative income) is
 * clamped silently.
 */
function NumberField({ label, ariaLabel, name, raw, onRawChange, extraProps, defaultValue, clamp, onChange, held = false, isHeldNow, holdEpoch = 0 }: NumberFieldProps) {
  const lastGoodRef = useRef(cents(defaultValue));
  const parsed = Number(raw);
  const invalid = raw.trim() === '' || !Number.isFinite(parsed);
  const effective = invalid ? lastGoodRef.current : clamp ? clamp(parsed) : parsed;

  useEffect(() => {
    // Held: an agent's unauthorized text must not move the projection (L1). It is applied when the hold lifts, and never
    // when the human's own numbers are put back (then `raw` is the human's again and this runs on them).
    if (isHeldNow ? isHeldNow() : held) return;
    if (!invalid) lastGoodRef.current = effective;
    onChange(effective);
    // Intentionally re-runs only when the raw text or the hold changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [raw, held, holdEpoch]);

  return (
    <div>
      <label className="block text-xs text-text-muted mb-1">{label}</label>
      <input
        type="number"
        name={name}
        // Chrome derives `multipleOf: 1` from the default step only while the value is whole, so a fill like 4840.71 -> 2000
        // would re-derive the tool definition and cancel the running call. "any" keeps the schema value-independent.
        step="any"
        inputMode="decimal"
        value={raw}
        onChange={(e) => onRawChange(e.target.value)}
        aria-label={ariaLabel}
        {...extraProps}
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
  /**
   * An agent submitted the form (`fill_forecast_inputs`): the values are now in the boxes, so the page computes
   * the projection and this resolves with what to tell the agent. Without it the agent just gets the server's OK.
   */
  awaitProjection?: (values: ManualInputValues) => Promise<unknown>;
}

export interface ManualInputValues {
  start_net_worth: number;
  monthly_income: number;
  monthly_savings: number;
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
  awaitProjection,
}: ManualInputsFormProps) {
  const [rawStart, setRawStart] = useState(() => String(cents(defaultStartNetWorth)));
  const [rawIncome, setRawIncome] = useState(() => String(cents(defaultMonthlyIncome)));
  const [rawSavings, setRawSavings] = useState(() => String(cents(defaultMonthlyContribution)));

  // The form is also a declarative WebMCP tool (`fill_forecast_inputs`, a page tool): the server authorizes and
  // audits the call, then the page puts the numbers in the boxes, recomputes, and tells the agent the percentiles.
  // A person's submit needs nothing extra: typing already updates the projection.
  const declarative = useDeclarativeTool({
    tool: 'fill_forecast_inputs',
    // The human's three boxes, captured when an agent activates the form and put back when its values are not authorized
    // (Reject, expiry, a refusal, the agent cancelling). While the card is open (policy Ask) the projection ignores them.
    snapshot: () => ({ start: rawStart, income: rawIncome, savings: rawSavings }),
    restore: (snap) => {
      const human = snap as { start: string; income: string; savings: string };
      setRawStart(human.start);
      setRawIncome(human.income);
      setRawSavings(human.savings);
    },
    afterServer: async (args, server) => {
      const values: ManualInputValues = {
        start_net_worth: Number(args.start_net_worth),
        monthly_income: Number(args.monthly_income),
        monthly_savings: Number(args.monthly_savings),
      };
      // A person's own submit of an agent-filled form also lands here (the boxes may be partly blank): only what parses.
      if (Number.isFinite(values.start_net_worth)) setRawStart(String(values.start_net_worth));
      if (Number.isFinite(values.monthly_income)) setRawIncome(String(values.monthly_income));
      if (Number.isFinite(values.monthly_savings)) setRawSavings(String(values.monthly_savings));
      if (!Object.values(values).every(Number.isFinite)) return server;
      return awaitProjection ? awaitProjection(values) : server;
    },
  });

  return (
    <div className="bg-surface-raised border border-border rounded-lg p-4">
      <p className="text-sm text-text-muted mb-3">
        Less than six months of history — the projection is using the numbers you enter below
        instead of your transaction history.
      </p>
      <form key={declarative.formKey} aria-label="Forecast inputs" {...declarative.formProps}>
        <div className="grid grid-cols-3 gap-3">
          <NumberField
            label="Starting net worth"
            ariaLabel="Starting net worth, dollars"
            name="start_net_worth"
            raw={rawStart}
            onRawChange={setRawStart}
            extraProps={declarative.field('start_net_worth')}
            defaultValue={defaultStartNetWorth}
            onChange={onStartNetWorthChange}
            held={declarative.effectsHeld}
            isHeldNow={() => declarative.effectsHeldRef.current}
            holdEpoch={declarative.holdEpoch}
          />
          <NumberField
            label="Monthly income"
            ariaLabel="Monthly income, dollars"
            name="monthly_income"
            raw={rawIncome}
            onRawChange={setRawIncome}
            extraProps={declarative.field('monthly_income')}
            defaultValue={defaultMonthlyIncome}
            clamp={(v) => Math.max(0, v)}
            onChange={onMonthlyIncomeChange}
            held={declarative.effectsHeld}
            isHeldNow={() => declarative.effectsHeldRef.current}
            holdEpoch={declarative.holdEpoch}
          />
          <NumberField
            label="Monthly savings"
            ariaLabel="Monthly savings, income minus expenses, dollars"
            name="monthly_savings"
            raw={rawSavings}
            onRawChange={setRawSavings}
            extraProps={declarative.field('monthly_savings')}
            defaultValue={defaultMonthlyContribution}
            onChange={onMonthlyContributionChange}
            held={declarative.effectsHeld}
            isHeldNow={() => declarative.effectsHeldRef.current}
            holdEpoch={declarative.holdEpoch}
          />
        </div>
        <button
          type="submit"
          className="mt-3 bg-surface hover:bg-border-muted text-text-secondary border border-border text-xs font-medium px-3 py-1.5 rounded-md transition-colors cursor-pointer"
        >
          Update projection
        </button>
      </form>
      <AgentOutcomeNote outcome={declarative.outcome} />
    </div>
  );
}
