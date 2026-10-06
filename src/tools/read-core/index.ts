// ── read-core: zero-import, injected-clock copies of the server read tools ──
//
// Shared by the offline mirror's tool executors. See specs/browser-subagent.md
// D4: new modules instead of edits to the server tool files, with parity pinned
// by src/__tests__/mirror-tool-parity.test.ts.

import { CATEGORIES } from '../categorize/categories.js';

export { getPeriodDatesAt, type PeriodDates, type ReadPeriod } from './period.js';
export { parseNaturalQueryAt, MONTH_NAMES } from './nl-query.js';
export {
  computeForecastAt,
  recurringWindow,
  type ForecastParams,
  type ForecastReaders,
  type ForecastResult,
  type ForecastWhatIf,
} from './forecast-math.js';
export { formatSearchResults, formatSpendingSummary, formatPnl, type SearchResultRow } from './format.js';

/** Category names used when the categories table is empty or missing (server parity). */
export const READ_CORE_CATEGORY_FALLBACK: string[] = CATEGORIES;
