import type { Database } from '../../db/compat-sqlite.js';
import type { IrsCategory } from './irs-categories.js';
import { csvText } from '../../utils/spreadsheet-safe.js';
import { xlsxToBuffer, type XlsxSheet } from '../../utils/xlsx-writer.js';

/**
 * Schedule C (Form 1040) Part II line for each IRS category. Line 12
 * (depletion) has no category; anything unrecognized lands on 27a.
 */
export const SCHEDULE_C_LINES: Record<IrsCategory, string> = {
  'Advertising': '8',
  'Car and truck expenses': '9',
  'Commissions and fees': '10',
  'Contract labor': '11',
  'Depreciation': '13',
  'Employee benefit programs': '14',
  'Insurance (other than health)': '15',
  'Interest (mortgage)': '16a',
  'Interest (other)': '16b',
  'Legal and professional services': '17',
  'Office expense': '18',
  'Pension and profit-sharing plans': '19',
  'Rent or lease (vehicles/equipment)': '20a',
  'Rent or lease (other)': '20b',
  'Repairs and maintenance': '21',
  'Supplies': '22',
  'Taxes and licenses': '23',
  'Travel': '24a',
  'Meals (business)': '24b',
  'Utilities': '25',
  'Wages': '26',
  'Other expenses': '27a',
};

const OTHER_LINE = '27a';

export interface ScheduleCLine {
  line: string;
  category: string;
  total: number;
  count: number;
}

export interface ScheduleCDetail {
  line: string;
  category: string;
  transactionId: number;
  date: string;
  description: string;
  amount: number;
  notes: string;
}

export interface ScheduleCReport {
  taxYear: number;
  lines: ScheduleCLine[];
  details: ScheduleCDetail[];
  total: number;
}

const cents = (n: number) => Math.round(n * 100) / 100;

function lineFor(category: string): string {
  return SCHEDULE_C_LINES[category as IrsCategory] ?? OTHER_LINE;
}

/** Orders Schedule C lines numerically, then by suffix: 8, 9, …, 16a, 16b, …, 27a. */
function compareLines(a: string, b: string): number {
  const na = parseInt(a, 10);
  const nb = parseInt(b, 10);
  return na !== nb ? na - nb : a.localeCompare(b);
}

/**
 * Build a Schedule C report from the deductions flagged for `taxYear`.
 *
 * Deduction amounts are the expense flipped positive (-amount), so a refund
 * flagged to the same category reduces the line rather than adding to it.
 */
export function buildScheduleC(db: Database, taxYear: number): ScheduleCReport {
  const rows = db.prepare(`
    SELECT td.transaction_id, td.irs_category, td.notes, t.date, t.description, t.amount
    FROM tax_deductions td
    JOIN transactions t ON t.id = td.transaction_id
    WHERE td.tax_year = @taxYear
    ORDER BY t.date, t.id
  `).all({ taxYear }) as {
    transaction_id: number;
    irs_category: string;
    notes: string | null;
    date: string;
    description: string;
    amount: number;
  }[];

  const details: ScheduleCDetail[] = rows.map((r) => ({
    line: lineFor(r.irs_category),
    category: r.irs_category,
    transactionId: r.transaction_id,
    date: r.date,
    description: r.description,
    amount: cents(-r.amount),
    notes: r.notes ?? '',
  }));

  const byCategory = new Map<string, ScheduleCLine>();
  for (const d of details) {
    const entry = byCategory.get(d.category) ?? { line: d.line, category: d.category, total: 0, count: 0 };
    entry.total += d.amount;
    entry.count += 1;
    byCategory.set(d.category, entry);
  }
  const lines = [...byCategory.values()]
    .map((l) => ({ ...l, total: cents(l.total) }))
    .sort((a, b) => compareLines(a.line, b.line) || a.category.localeCompare(b.category));

  return { taxYear, lines, details, total: cents(lines.reduce((s, l) => s + l.total, 0)) };
}

/** Line-level summary — the numbers that go on the form. */
export function scheduleCToCsv(report: ScheduleCReport): string {
  const out = ['Line,Category,Amount,Transactions'];
  for (const l of report.lines) {
    out.push([l.line, csvText(l.category), l.total.toFixed(2), String(l.count)].join(','));
  }
  out.push(['28', 'Total expenses', report.total.toFixed(2), String(report.details.length)].join(','));
  return out.join('\n');
}

/**
 * Sheets for the Schedule C workbook: a summary sheet (per line) and a
 * Transactions sheet (every flagged row). String cells are formula-neutralised
 * by the xlsx writer.
 */
export function scheduleCToSheets(report: ScheduleCReport): XlsxSheet[] {
  const summaryRows: XlsxSheet['rows'] = report.lines.map((l) => [l.line, l.category, l.total, l.count]);
  summaryRows.push(['28', 'Total expenses', report.total, report.details.length]);

  const detailRows: XlsxSheet['rows'] = report.details.map((d) => [
    d.line,
    d.category,
    d.date,
    d.description,
    d.amount,
    d.notes,
    d.transactionId,
  ]);

  return [
    {
      name: `Schedule C ${report.taxYear}`,
      header: ['Line', 'Category', 'Amount', 'Transactions'],
      rows: summaryRows,
      widths: [8, 36, 14, 14],
      currencyColumns: ['Amount'],
    },
    {
      name: 'Transactions',
      header: ['Line', 'Category', 'Date', 'Description', 'Amount', 'Notes', 'Transaction ID'],
      rows: detailRows,
      widths: [8, 30, 12, 48, 14, 30, 16],
      currencyColumns: ['Amount'],
    },
  ];
}

export async function scheduleCToXlsxBuffer(report: ScheduleCReport): Promise<Buffer> {
  return xlsxToBuffer(scheduleCToSheets(report));
}
