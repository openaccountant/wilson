export type TaxExportFormat = 'csv' | 'xlsx';

export type TaxExportArgs =
  | { ok: true; year: number; format: TaxExportFormat }
  | { ok: false; error: string };

export const TAX_EXPORT_USAGE = 'Usage: `/export tax [year] [csv|xlsx]` — e.g. `/export tax 2025` (defaults: this year, xlsx).';

/**
 * Parse the words after `/export tax`: an optional 4-digit year and an
 * optional format, in either order.
 */
export function parseTaxExportArgs(words: string[], currentYear: number): TaxExportArgs {
  let year = currentYear;
  let format: TaxExportFormat = 'xlsx';
  for (const w of words) {
    if (/^\d{4}$/.test(w)) year = Number(w);
    else if (w === 'csv' || w === 'xlsx') format = w;
    else return { ok: false, error: TAX_EXPORT_USAGE };
  }
  return { ok: true, year, format };
}
