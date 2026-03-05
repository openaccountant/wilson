import { useState, useCallback } from 'react';
import type { DateRange } from '@/types';

export type RangePreset = 'month' | 'quarter' | 'ytd' | 'year' | 'prev-year' | 'custom';

function startOfMonth(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}

function endOfMonth(d: Date): string {
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0);
  return `${last.getFullYear()}-${String(last.getMonth() + 1).padStart(2, '0')}-${String(last.getDate()).padStart(2, '0')}`;
}

function startOfQuarter(d: Date): string {
  const qMonth = Math.floor(d.getMonth() / 3) * 3;
  return `${d.getFullYear()}-${String(qMonth + 1).padStart(2, '0')}-01`;
}

function endOfQuarter(d: Date): string {
  const qMonth = Math.floor(d.getMonth() / 3) * 3 + 2;
  return endOfMonth(new Date(d.getFullYear(), qMonth, 1));
}

function getQuarterLabel(d: Date): string {
  const q = Math.floor(d.getMonth() / 3) + 1;
  return `Q${q} ${d.getFullYear()}`;
}

function getMonthRange(d: Date): DateRange {
  return { startDate: startOfMonth(d), endDate: endOfMonth(d) };
}

function getQuarterRange(d: Date): DateRange {
  return { startDate: startOfQuarter(d), endDate: endOfQuarter(d) };
}

function getYtdRange(): DateRange {
  const now = new Date();
  const fmt = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return { startDate: `${now.getFullYear()}-01-01`, endDate: fmt(now) };
}

function getYearRange(year: number): DateRange {
  return { startDate: `${year}-01-01`, endDate: `${year}-12-31` };
}

export function useDateRange() {
  const now = new Date();
  const [preset, setPreset] = useState<RangePreset>('month');
  const [dateRange, setDateRange] = useState<DateRange>(getMonthRange(now));

  // Navigate back/forward based on current preset
  const goToPrevMonth = useCallback(() => {
    setDateRange((prev) => {
      const d = new Date(prev.startDate + 'T00:00:00');
      if (preset === 'quarter') {
        d.setMonth(d.getMonth() - 3);
        return getQuarterRange(d);
      }
      if (preset === 'year' || preset === 'ytd' || preset === 'prev-year') {
        d.setFullYear(d.getFullYear() - 1);
        return getYearRange(d.getFullYear());
      }
      // month or custom — step by month
      d.setMonth(d.getMonth() - 1);
      return getMonthRange(d);
    });
    // When stepping through years, update preset to 'year'
    if (preset === 'ytd' || preset === 'prev-year') setPreset('year');
  }, [preset]);

  const goToNextMonth = useCallback(() => {
    setDateRange((prev) => {
      const d = new Date(prev.startDate + 'T00:00:00');
      if (preset === 'quarter') {
        d.setMonth(d.getMonth() + 3);
        return getQuarterRange(d);
      }
      if (preset === 'year' || preset === 'ytd' || preset === 'prev-year') {
        d.setFullYear(d.getFullYear() + 1);
        return getYearRange(d.getFullYear());
      }
      // month or custom — step by month
      d.setMonth(d.getMonth() + 1);
      return getMonthRange(d);
    });
    if (preset === 'ytd' || preset === 'prev-year') setPreset('year');
  }, [preset]);

  const goToCurrentMonth = useCallback(() => {
    const d = new Date();
    setPreset('month');
    setDateRange(getMonthRange(d));
  }, []);

  const selectPreset = useCallback((p: RangePreset) => {
    setPreset(p);
    const d = new Date();
    switch (p) {
      case 'month':
        setDateRange(getMonthRange(d));
        break;
      case 'quarter':
        setDateRange(getQuarterRange(d));
        break;
      case 'ytd':
        setDateRange(getYtdRange());
        break;
      case 'year':
        setDateRange(getYearRange(d.getFullYear()));
        break;
      case 'prev-year':
        setDateRange(getYearRange(d.getFullYear() - 1));
        break;
    }
  }, []);

  // Build display label based on range
  const rangeLabel = (() => {
    const start = new Date(dateRange.startDate + 'T00:00:00');
    const end = new Date(dateRange.endDate + 'T00:00:00');

    // Single month
    if (start.getMonth() === end.getMonth() && start.getFullYear() === end.getFullYear()) {
      return start.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    }

    // Quarter
    if (preset === 'quarter') {
      return getQuarterLabel(start);
    }

    // Full year
    if (dateRange.startDate.endsWith('-01-01') && (dateRange.endDate.endsWith('-12-31') || preset === 'ytd')) {
      if (preset === 'ytd') return `YTD ${start.getFullYear()}`;
      return String(start.getFullYear());
    }

    // Custom range
    const fmtShort = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
    return `${fmtShort(start)} – ${fmtShort(end)}`;
  })();

  return {
    dateRange,
    setDateRange,
    goToPrevMonth,
    goToNextMonth,
    goToCurrentMonth,
    selectPreset,
    preset,
    monthLabel: rangeLabel,
  };
}
