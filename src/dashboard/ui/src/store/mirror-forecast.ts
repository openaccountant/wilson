// ── Offline mirror: forecast driver ──────────────────────────────────────────
//
// Mirror counterpart of the `forecast` READ tool (src/tools/query/forecast.ts):
// the arithmetic is read-core/forecast-math.ts (a zero-import port with an
// injected clock); the three reads below are the same SQL the server function
// runs, against the mirror's transactions and accounts tables.
// Parity: src/__tests__/mirror-tool-parity.test.ts.
//
// Pure module: no browser glue, no bun:sqlite.

import { computeForecastAt, type ForecastParams, type ForecastReaders, type ForecastResult } from '../../../../tools/read-core/forecast-math.js';
import { mirrorGetMonthlySavingsData } from './mirror-overview.js';
import { mirrorStartingCash } from './mirror-networth.js';
import type { SqliteBinding } from './types.js';

function readers(db: SqliteBinding, now: Date): ForecastReaders {
  return {
    startingCash: () => mirrorStartingCash(db),
    monthly: (months) => mirrorGetMonthlySavingsData(db, undefined, months, undefined, undefined, undefined, now),
    recurringTotal: async (match, startStr, endStr) => {
      const row = (await db
        .prepare(`
    SELECT SUM(ABS(amount)) AS total
    FROM transactions
    WHERE is_recurring = 1 AND date >= @startStr AND date <= @endStr
      AND LOWER(description) LIKE '%' || LOWER(@match) || '%'
  `)
        .get({ startStr, endStr, match })) as { total: number | null } | undefined;
      return row?.total ?? null;
    },
  };
}

export function mirrorForecast(db: SqliteBinding, params: ForecastParams, now: Date): Promise<ForecastResult> {
  return computeForecastAt(readers(db, now), params, now);
}
