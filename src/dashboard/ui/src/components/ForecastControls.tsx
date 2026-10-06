import {
  SAVINGS_DELTA_MIN_PP,
  SAVINGS_DELTA_MAX_PP,
  SAVINGS_DELTA_STEP_PP,
  RETURN_MIN,
  RETURN_MAX,
  RETURN_STEP,
  RETURN_DEFAULT,
  HORIZON_MIN_YEARS,
  HORIZON_MAX_YEARS,
  HORIZON_DEFAULT_YEARS,
  SHOCK_MIN,
  SHOCK_MAX,
  SHOCK_STEP,
  SHOCK_DEFAULT_YEAR,
  savingsDeltaToDollars,
} from '@/lib/netWorthForecast';
import { moneyWhole } from '@/format';

export const DEFAULT_SAVINGS_DELTA_PP = 0;
export const DEFAULT_SHOCK_AMOUNT = 0;

/** '+$1,234' / '-$1,234' / '$0' — explicit sign for a delta. */
function fmtUsdSigned(n: number): string {
  return `${Math.round(n) > 0 ? '+' : ''}${moneyWhole(n)}`;
}

interface ForecastControlsProps {
  savingsDeltaPp: number;
  onSavingsDeltaPpChange: (v: number) => void;
  realAnnualReturn: number;
  onRealAnnualReturnChange: (v: number) => void;
  horizonYears: number;
  onHorizonYearsChange: (v: number) => void;
  shockAmount: number;
  onShockAmountChange: (v: number) => void;
  shockYear: number;
  onShockYearChange: (v: number) => void;
  medianMonthlyIncome: number;
  /** True when income comes from the manual-inputs form (too little history). */
  manual: boolean;
  /** Fired on pointerup / keyup / blur of any slider — escalates to the release-quality run. */
  onSettled: () => void;
  onReset: () => void;
}

export function ForecastControls({
  savingsDeltaPp,
  onSavingsDeltaPpChange,
  realAnnualReturn,
  onRealAnnualReturnChange,
  horizonYears,
  onHorizonYearsChange,
  shockAmount,
  onShockAmountChange,
  shockYear,
  onShockYearChange,
  medianMonthlyIncome,
  manual,
  onSettled,
  onReset,
}: ForecastControlsProps) {
  // The percentage-point delta has no dollar meaning without an income to
  // apply it to.
  const savingsDisabled = !(medianMonthlyIncome > 0);
  const atDefault =
    savingsDeltaPp === DEFAULT_SAVINGS_DELTA_PP &&
    realAnnualReturn === RETURN_DEFAULT &&
    horizonYears === HORIZON_DEFAULT_YEARS &&
    shockAmount === DEFAULT_SHOCK_AMOUNT &&
    shockYear === SHOCK_DEFAULT_YEAR;

  const savingsDollars = savingsDeltaToDollars(savingsDeltaPp, medianMonthlyIncome);
  const savingsLabel = `${savingsDeltaPp > 0 ? '+' : ''}${savingsDeltaPp} pp (≈ ${fmtUsdSigned(savingsDollars)}/mo)`;

  return (
    <div className="bg-surface-raised border border-border rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-xs text-text-secondary uppercase tracking-wide">What-if controls</h3>
        <button
          type="button"
          onClick={onReset}
          disabled={atDefault}
          className="bg-transparent text-text-muted border border-border px-2 py-1 text-xs rounded cursor-pointer hover:text-text disabled:cursor-not-allowed disabled:opacity-50"
        >
          Reset
        </button>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <div className="flex items-center justify-between text-xs">
            <span className="text-text-muted">Savings rate</span>
            <span className={savingsDeltaPp !== DEFAULT_SAVINGS_DELTA_PP ? 'text-green' : 'text-text-muted'}>
              {savingsLabel}
            </span>
          </div>
          <input
            type="range"
            min={SAVINGS_DELTA_MIN_PP}
            max={SAVINGS_DELTA_MAX_PP}
            step={SAVINGS_DELTA_STEP_PP}
            value={savingsDeltaPp}
            disabled={savingsDisabled}
            onChange={(e) => onSavingsDeltaPpChange(Number(e.target.value))}
            onPointerUp={onSettled}
            onKeyUp={onSettled}
            onBlur={onSettled}
            className="w-full accent-green cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
            aria-label="Savings rate change, percentage points of monthly income"
          />
          {savingsDisabled && (
            <p className="text-xs text-red mt-1">
              {manual
                ? 'Enter monthly income to use the savings-rate slider.'
                : 'Median monthly income in your history is $0 or less, so the savings-rate slider is unavailable.'}
            </p>
          )}
        </div>
        <div>
          <div className="flex items-center justify-between text-xs">
            <span className="text-text-muted">Real annual return</span>
            <span className={realAnnualReturn !== RETURN_DEFAULT ? 'text-green' : 'text-text-muted'}>
              {(realAnnualReturn * 100).toFixed(2)}% real
            </span>
          </div>
          <input
            type="range"
            min={RETURN_MIN}
            max={RETURN_MAX}
            step={RETURN_STEP}
            value={realAnnualReturn}
            onChange={(e) => onRealAnnualReturnChange(Number(e.target.value))}
            onPointerUp={onSettled}
            onKeyUp={onSettled}
            onBlur={onSettled}
            className="w-full accent-green cursor-pointer"
            aria-label="Assumed real annual return, percent"
          />
        </div>
        <div>
          <div className="flex items-center justify-between text-xs">
            <span className="text-text-muted">Horizon</span>
            <span className={horizonYears !== HORIZON_DEFAULT_YEARS ? 'text-green' : 'text-text-muted'}>
              {horizonYears} years
            </span>
          </div>
          <input
            type="range"
            min={HORIZON_MIN_YEARS}
            max={HORIZON_MAX_YEARS}
            step={1}
            value={horizonYears}
            onChange={(e) => onHorizonYearsChange(Number(e.target.value))}
            onPointerUp={onSettled}
            onKeyUp={onSettled}
            onBlur={onSettled}
            className="w-full accent-green cursor-pointer"
            aria-label="Projection horizon, years"
          />
        </div>
        <div>
          <div className="flex items-center justify-between text-xs">
            <span className="text-text-muted">One-off shock</span>
            <span className={shockAmount !== DEFAULT_SHOCK_AMOUNT ? 'text-green' : 'text-text-muted'}>
              {shockAmount === 0 ? '$0' : `${moneyWhole(shockAmount)} in year ${shockYear}`}
            </span>
          </div>
          <input
            type="range"
            min={SHOCK_MIN}
            max={SHOCK_MAX}
            step={SHOCK_STEP}
            value={shockAmount}
            onChange={(e) => onShockAmountChange(Number(e.target.value))}
            onPointerUp={onSettled}
            onKeyUp={onSettled}
            onBlur={onSettled}
            className="w-full accent-green cursor-pointer"
            aria-label="One-off net worth shock, dollars"
          />
          <input
            type="range"
            min={1}
            max={horizonYears}
            step={1}
            value={Math.min(shockYear, horizonYears)}
            disabled={shockAmount === 0}
            onChange={(e) => onShockYearChange(Number(e.target.value))}
            onPointerUp={onSettled}
            onKeyUp={onSettled}
            onBlur={onSettled}
            className="w-full accent-green cursor-pointer mt-1 disabled:cursor-not-allowed disabled:opacity-50"
            aria-label="Year of the one-off shock"
          />
        </div>
      </div>
    </div>
  );
}
