import { useCallback, useMemo } from 'react';
import type { DateRange } from '@/types';
import { useUrlState } from '@/hooks/useUrlState';
import {
  customRangePatch,
  presetPatch,
  rangeLabel,
  resolveDateRange,
  stepPatch,
  ymd,
  type RangePreset,
} from '@/lib/dateRange';

export type { RangePreset };

/**
 * The header date range, derived from the URL hash (preset/start/end).
 * Every change is a `replace` navigation — tweaking a filter shouldn't stack
 * Back-button entries; switching tabs is what pushes.
 */
export function useDateRange() {
  const { state, navigate } = useUrlState();
  const { preset, start, end } = state;
  // Re-derive when the calendar day changes so a live "this month" rolls over.
  const today = ymd(new Date());

  const dateRange = useMemo<DateRange>(
    () => resolveDateRange({ preset, start, end }, new Date(`${today}T00:00:00`)),
    [preset, start, end, today],
  );

  const goToPrevMonth = useCallback(() => {
    navigate((s) => ({ ...s, ...stepPatch(s, -1, new Date()) }), { mode: 'replace' });
  }, [navigate]);

  const goToNextMonth = useCallback(() => {
    navigate((s) => ({ ...s, ...stepPatch(s, 1, new Date()) }), { mode: 'replace' });
  }, [navigate]);

  const goToCurrentMonth = useCallback(() => {
    navigate((s) => ({ ...s, ...presetPatch('month') }), { mode: 'replace' });
  }, [navigate]);

  const selectPreset = useCallback(
    (p: RangePreset) => navigate((s) => ({ ...s, ...presetPatch(p) }), { mode: 'replace' }),
    [navigate],
  );

  /** Any explicit range is a custom range — the preset pill follows. */
  const setDateRange = useCallback(
    (range: DateRange) => navigate((s) => ({ ...s, ...customRangePatch(range) }), { mode: 'replace' }),
    [navigate],
  );

  const monthLabel = useMemo(() => rangeLabel(preset, dateRange), [preset, dateRange]);

  return {
    dateRange,
    setDateRange,
    goToPrevMonth,
    goToNextMonth,
    goToCurrentMonth,
    selectPreset,
    preset,
    monthLabel,
  };
}
