/**
 * Pure check behind `set_forecast_inputs`: whether a finished projection is the projection OF the numbers an agent's call
 * applied. In manual-inputs mode the simulation input is `startNetWorth` = the starting-net-worth box and a one-element
 * `contributionPool` = the monthly-savings box, so the answer to the agent is accepted only for a projection whose own
 * input carries those numbers. A standing projection of the person's numbers never satisfies it (V1), whatever the boxes
 * or the quality flag say.
 */

export interface ManualForecastValues {
  start_net_worth: number;
  monthly_income: number;
  monthly_savings: number;
}

export function forecastReflectsValues(
  values: ManualForecastValues,
  forecastInput: { startNetWorth: number; contributionPool: readonly number[] } | null,
): boolean {
  if (!forecastInput) return false;
  const pool = forecastInput.contributionPool;
  return forecastInput.startNetWorth === values.start_net_worth && pool.length === 1 && pool[0] === values.monthly_savings;
}
