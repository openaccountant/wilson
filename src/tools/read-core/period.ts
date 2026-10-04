// ── read-core: period math with an injected clock ────────────────────────────
//
// Pure copy of getPeriodDates (src/tools/query/spending-summary.ts), with `now`
// injected instead of read from the system clock so the mirror (and tests) can
// pin it. Parity with the server is pinned by mirror-tool-parity.test.ts, which
// runs the real server tool against the mirror at the same pinned instant.
//
// Zero-import: safe for both the server bundle and the dashboard UI bundle.

export type ReadPeriod = 'month' | 'quarter' | 'year';

export interface PeriodDates {
  start: string;
  end: string;
  label: string;
}

/**
 * Compute the start/end dates (and display label) for a period relative to
 * `now`. `offset` counts whole periods (0 = current, -1 = previous, ...).
 * Uses the local-time calendar, exactly like the server tool.
 */
export function getPeriodDatesAt(period: ReadPeriod, offset: number, now: Date): PeriodDates {
  let start: Date;
  let end: Date;
  let label: string;

  switch (period) {
    case 'month': {
      const targetMonth = now.getMonth() + offset;
      start = new Date(now.getFullYear(), targetMonth, 1);
      end = new Date(now.getFullYear(), targetMonth + 1, 0); // last day of month
      label = start.toLocaleString('en-US', { month: 'long', year: 'numeric' });
      break;
    }
    case 'quarter': {
      const currentQuarter = Math.floor(now.getMonth() / 3);
      const targetQuarter = currentQuarter + offset;
      const qYear = now.getFullYear() + Math.floor(targetQuarter / 4);
      const qNum = ((targetQuarter % 4) + 4) % 4;
      start = new Date(qYear, qNum * 3, 1);
      end = new Date(qYear, qNum * 3 + 3, 0);
      label = `Q${qNum + 1} ${qYear}`;
      break;
    }
    case 'year': {
      const targetYear = now.getFullYear() + offset;
      start = new Date(targetYear, 0, 1);
      end = new Date(targetYear, 11, 31);
      label = String(targetYear);
      break;
    }
  }

  const fmt = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  return { start: fmt(start), end: fmt(end), label };
}
