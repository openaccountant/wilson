import { useEffect, useMemo, useState } from 'react';
import { useApi } from '@/hooks/useApi';
import { useNetWorthForecast } from '@/hooks/useNetWorthForecast';
import { OfflineUnavailable } from '@/components/OfflineUnavailable';
import { ForecastFanChart } from '@/components/ForecastFanChart';
import { ForecastControls } from '@/components/ForecastControls';
import { ManualInputsForm } from '@/components/ManualInputsForm';
import { ForecastAssumptions } from '@/components/ForecastAssumptions';
import {
  deriveNetWorthInputs,
  savingsDeltaToDollars,
  FIXED_ANNUAL_VOLATILITY,
  BUCKET_MONTHS,
  DRAG_PATHS,
  RETURN_DEFAULT,
  HORIZON_DEFAULT_YEARS,
  SHOCK_DEFAULT_YEAR,
} from '@/lib/netWorthForecast';
import { DEFAULT_SEED } from '@/lib/forecastCore';
import type { NetWorthResponse, MonthlyCashflowRow } from '@/types';
import { moneyWhole } from '@/format';

// Sliders with no dedicated "default" export in lib/netWorthForecast (only
// bounds) default to the neutral no-op value.
const DEFAULT_SAVINGS_DELTA_PP = 0;
const DEFAULT_SHOCK_AMOUNT = 0;

function currentMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Medians over whatever partial history exists (1-5 usable months) — used
 * only to prefill the manual-inputs form, which is strictly better than
 * zeros. `deriveNetWorthInputs` itself returns null below the 6-month gate,
 * so this is a separate, permissive pass over the same rows.
 */
function partialHistoryMedians(history: MonthlyCashflowRow[] | null): {
  medianIncome: number;
  medianContribution: number;
} {
  const usable = (history ?? []).filter(
    (r) => Number.isFinite(r.income) && Number.isFinite(r.expenses),
  );
  if (usable.length === 0) return { medianIncome: 0, medianContribution: 0 };
  return {
    medianIncome: median(usable.map((r) => r.income)),
    medianContribution: median(usable.map((r) => r.income - r.expenses)),
  };
}

export function ForecastTab() {
  // Neither call uses useFilterParams() — the projection starts from now,
  // same posture as CashflowForecast.tsx.
  const {
    data: nw,
    loading: nwLoading,
    offline: nwOffline,
    error: nwError,
  } = useApi<NetWorthResponse>('/api/net-worth');
  const {
    data: history,
    loading: hLoading,
    error: hError,
  } = useApi<MonthlyCashflowRow[]>('/api/cashflow/monthly?months=24');

  const startMonth = useMemo(() => currentMonth(), []);
  const derived = useMemo(() => (history ? deriveNetWorthInputs(history) : null), [history]);
  const manual = !hLoading && history !== null && derived === null;
  const partialDefaults = useMemo(() => partialHistoryMedians(history), [history]);

  // Slider state — plain useState, not persisted (no localStorage, no URL
  // hash beyond the existing tab hash). A remount is a fresh baseline.
  const [savingsDeltaPp, setSavingsDeltaPp] = useState(DEFAULT_SAVINGS_DELTA_PP);
  const [realAnnualReturn, setRealAnnualReturn] = useState(RETURN_DEFAULT);
  const [horizonYears, setHorizonYears] = useState(HORIZON_DEFAULT_YEARS);
  const [shockAmount, setShockAmount] = useState(DEFAULT_SHOCK_AMOUNT);
  const [shockYear, setShockYear] = useState(SHOCK_DEFAULT_YEAR);

  // Manual-inputs mode state — also not persisted.
  const [manualStartNetWorth, setManualStartNetWorth] = useState(0);
  const [manualMonthlyIncome, setManualMonthlyIncome] = useState(0);
  const [manualMonthlyContribution, setManualMonthlyContribution] = useState(0);

  // Clamp the shock year whenever the horizon slider shrinks below it.
  useEffect(() => {
    setShockYear((y) => Math.min(y, horizonYears));
  }, [horizonYears]);

  const medianMonthlyIncomeForControls = manual
    ? manualMonthlyIncome
    : (derived?.medianMonthlyIncome ?? 0);

  const simInput = useMemo(() => {
    const effectiveShockYear = Math.min(shockYear, horizonYears);
    return {
      startNetWorth: manual ? manualStartNetWorth : (nw?.netWorth ?? 0),
      contributionPool: manual
        ? [manualMonthlyContribution]
        : (derived?.contributionPool ?? []),
      contributionDelta: savingsDeltaToDollars(savingsDeltaPp, medianMonthlyIncomeForControls),
      realAnnualReturn,
      annualVolatility: FIXED_ANNUAL_VOLATILITY,
      horizonMonths: horizonYears * 12,
      shock: shockAmount === 0 ? null : { month: (effectiveShockYear - 1) * 12 + 1, amount: shockAmount },
      paths: DRAG_PATHS, // overwritten by pathsFor(quality) in the worker
      seed: DEFAULT_SEED,
      bucketMonths: BUCKET_MONTHS,
      startMonth,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    manual,
    manualStartNetWorth,
    manualMonthlyContribution,
    nw,
    derived,
    savingsDeltaPp,
    medianMonthlyIncomeForControls,
    realAnnualReturn,
    horizonYears,
    shockAmount,
    shockYear,
    startMonth,
  ]);

  const { forecast, refining, error: simError, onInputChange, onInputSettled } =
    useNetWorthForecast();

  // Every slider (or manual-input) change re-posts a draft run; the hook
  // coalesces these to one per animation frame and arms its own settle timer.
  useEffect(() => {
    onInputChange(simInput);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [simInput]);

  const handleSettled = () => onInputSettled(simInput);

  const handleReset = () => {
    setSavingsDeltaPp(DEFAULT_SAVINGS_DELTA_PP);
    setRealAnnualReturn(RETURN_DEFAULT);
    setHorizonYears(HORIZON_DEFAULT_YEARS);
    setShockAmount(DEFAULT_SHOCK_AMOUNT);
    setShockYear(SHOCK_DEFAULT_YEAR);
  };

  if (nwLoading || hLoading) {
    return (
      <div className="flex-1 overflow-y-auto p-6 space-y-4">
        <div className="h-[320px] animate-pulse bg-border-muted rounded" />
      </div>
    );
  }

  if (nwOffline && !nw) {
    return (
      <div className="flex-1 overflow-y-auto p-6 space-y-4">
        <OfflineUnavailable title="Forecast" />
      </div>
    );
  }

  // A non-offline net-worth failure (500, 401, malformed response, …) must
  // never fall through to the chart below: `nw?.netWorth ?? 0` would silently
  // forecast from a $0 starting balance — a confident, wrong chart is worse
  // than an honest error. Checked before the cashflow error below because a
  // missing starting balance is the worse of the two failures.
  if (nwError && !nw) {
    return (
      <div className="flex-1 overflow-y-auto p-6 space-y-4">
        <div className="bg-surface-raised border border-border rounded-lg p-4">
          <h3 className="text-xs text-text-secondary uppercase tracking-wide mb-2">Forecast</h3>
          <p className="text-sm text-red">
            Couldn&apos;t load net worth: {nwError}. The forecast needs a starting balance and
            can&apos;t run without one.
          </p>
        </div>
      </div>
    );
  }

  // A non-offline cashflow-history failure otherwise leaves `history` (and
  // therefore `derived`) null forever, with nothing to prefill manual inputs
  // from and no forecast in sight — a permanent pulsing skeleton instead of
  // an error.
  if (hError && !history) {
    return (
      <div className="flex-1 overflow-y-auto p-6 space-y-4">
        <div className="bg-surface-raised border border-border rounded-lg p-4">
          <h3 className="text-xs text-text-secondary uppercase tracking-wide mb-2">Forecast</h3>
          <p className="text-sm text-red">Couldn&apos;t load cashflow history: {hError}</p>
        </div>
      </div>
    );
  }

  if (simError) {
    return (
      <div className="flex-1 overflow-y-auto p-6 space-y-4">
        <div className="bg-surface-raised border border-border rounded-lg p-4">
          <h3 className="text-xs text-text-secondary uppercase tracking-wide mb-2">Forecast</h3>
          <p className="text-sm text-text-muted">
            This projection needs a Web Worker, which this browser blocked.
          </p>
        </div>
        <ForecastAssumptions />
      </div>
    );
  }

  const last = forecast?.points[forecast.points.length - 1] ?? null;

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-4">
      {manual && (
        <ManualInputsForm
          defaultStartNetWorth={nw?.netWorth ?? 0}
          defaultMonthlyIncome={partialDefaults.medianIncome}
          defaultMonthlyContribution={partialDefaults.medianContribution}
          onStartNetWorthChange={setManualStartNetWorth}
          onMonthlyIncomeChange={setManualMonthlyIncome}
          onMonthlyContributionChange={setManualMonthlyContribution}
        />
      )}

      <div className="bg-surface-raised border border-border rounded-lg p-4">
        <h3 className="text-xs text-text-secondary uppercase tracking-wide mb-2">Forecast</h3>
        {forecast ? (
          <ForecastFanChart forecast={forecast} />
        ) : (
          <div className="h-[360px] animate-pulse bg-border-muted rounded" />
        )}
        {last && (
          <p className="text-sm text-text mt-2">
            Median net worth in {last.label}: <strong>{moneyWhole(last.p50)}</strong> · 10th–90th
            percentile {moneyWhole(last.p10)} – {moneyWhole(last.p90)} ·{' '}
            {(forecast?.pathCount ?? 0).toLocaleString()} simulated paths
            {refining ? ' · refining…' : ''}
          </p>
        )}
      </div>

      <ForecastControls
        savingsDeltaPp={savingsDeltaPp}
        onSavingsDeltaPpChange={setSavingsDeltaPp}
        realAnnualReturn={realAnnualReturn}
        onRealAnnualReturnChange={setRealAnnualReturn}
        horizonYears={horizonYears}
        onHorizonYearsChange={setHorizonYears}
        shockAmount={shockAmount}
        onShockAmountChange={setShockAmount}
        shockYear={shockYear}
        onShockYearChange={setShockYear}
        medianMonthlyIncome={medianMonthlyIncomeForControls}
        manual={manual}
        onSettled={handleSettled}
        onReset={handleReset}
      />

      <ForecastAssumptions />
    </div>
  );
}
