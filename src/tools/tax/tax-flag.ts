import { z } from 'zod';
import type { Database } from '../../db/compat-sqlite.js';
import { defineTool } from '../define-tool.js';
import { mutatesUnlessAction } from '../mutation.js';
import { flagTaxDeduction, unflagTaxDeduction, getTaxDeductions, getTaxSummary } from '../../db/queries.js';
import { formatToolResult } from '../types.js';
import { IRS_CATEGORIES } from './irs-categories.js';
import { hasLicense } from '../../licensing/license.js';
import { toolUpsell } from '../../licensing/upsell.js';
import { buildScheduleC, scheduleCToCsv, scheduleCToWorkbook } from './schedule-c.js';
import { writeFileSync } from 'fs';
import * as XLSX from 'xlsx';

let db: Database | null = null;

export function initTaxFlagTool(database: Database): void {
  db = database;
}

function getDb(): Database {
  if (!db) throw new Error('tax_flag tool not initialized. Call initTaxFlagTool(database) first.');
  return db;
}

export const taxFlagTool = defineTool({
  name: 'tax_flag',
  mutates: mutatesUnlessAction('summary', 'list'),
  description:
    'Flag transactions as tax-deductible with IRS Schedule C categories. ' +
    'Supports flag, unflag, summary, list, and export (Schedule C CSV/XLSX file) actions. Requires Pro license.',
  schema: z.object({
    action: z.enum(['flag', 'unflag', 'summary', 'list', 'export']).describe('Action to perform'),
    transactionId: z.number().optional().describe('Transaction ID (for flag/unflag)'),
    irsCategory: z.string().optional().describe('IRS Schedule C category'),
    taxYear: z.number().optional().describe('Tax year (default: current year)'),
    notes: z.string().optional().describe('Optional notes for the deduction'),
    format: z.enum(['csv', 'xlsx']).optional().describe('Export file format (for export; default xlsx)'),
    filePath: z.string().optional().describe('Output file path (for export)'),
  }),
  func: async ({ action, transactionId, irsCategory, taxYear, notes, format, filePath }) => {
    if (!hasLicense('pro')) return toolUpsell('Tax tracking');

    const database = getDb();
    const year = taxYear ?? new Date().getFullYear();

    switch (action) {
      case 'flag': {
        if (!transactionId || !irsCategory) {
          return formatToolResult({ error: 'transactionId and irsCategory are required for flag' });
        }
        if (!IRS_CATEGORIES.includes(irsCategory as any)) {
          return formatToolResult({
            error: `Invalid IRS category. Valid categories: ${IRS_CATEGORIES.join(', ')}`,
          });
        }
        const id = flagTaxDeduction(database, transactionId, irsCategory, year, notes);
        return formatToolResult({
          message: `Transaction #${transactionId} flagged as "${irsCategory}" for tax year ${year}.`,
          deductionId: id,
        });
      }
      case 'unflag': {
        if (!transactionId) return formatToolResult({ error: 'transactionId is required for unflag' });
        const removed = unflagTaxDeduction(database, transactionId);
        return formatToolResult({
          message: removed ? `Transaction #${transactionId} unflagged.` : `No tax deduction found for transaction #${transactionId}.`,
          success: removed,
        });
      }
      case 'summary': {
        const summary = getTaxSummary(database, year);
        if (summary.length === 0) {
          return formatToolResult({ message: `No tax deductions flagged for ${year}.`, summary: [] });
        }
        const grandTotal = summary.reduce((sum, r) => sum + r.total, 0);
        const formatted = summary.map((r) =>
          `${r.irs_category.padEnd(35)} $${r.total.toFixed(2).padStart(10)}  (${r.count} items)`
        ).join('\n');
        return formatToolResult({
          taxYear: year,
          summary,
          grandTotal,
          formatted: `Tax Deductions Summary — ${year}\n\n${formatted}\n\nTotal Deductions: $${grandTotal.toFixed(2)}`,
        });
      }
      case 'list': {
        const deductions = getTaxDeductions(database, year, irsCategory);
        if (deductions.length === 0) {
          return formatToolResult({ message: `No deductions found for ${year}${irsCategory ? ` in "${irsCategory}"` : ''}.`, deductions: [] });
        }
        return formatToolResult({
          taxYear: year,
          deductions: deductions.map((d) => ({
            transactionId: d.transaction_id,
            date: d.date,
            description: d.description,
            amount: d.amount,
            irsCategory: d.irs_category,
            notes: d.notes,
          })),
        });
      }
      case 'export': {
        if (!filePath) return formatToolResult({ error: 'filePath is required for export' });
        const fmt = format ?? 'xlsx';
        // Only ever write a spreadsheet: the path comes from the model, and a
        // prompt-injected one must not be able to clobber e.g. ~/.zshrc.
        if (!filePath.toLowerCase().endsWith(`.${fmt}`)) {
          return formatToolResult({ error: `filePath must end in .${fmt} for a ${fmt} export` });
        }
        const report = buildScheduleC(database, year);
        if (report.details.length === 0) {
          return formatToolResult({ success: false, message: `No tax deductions flagged for ${year}; nothing to export.` });
        }
        const resolvedPath = filePath.startsWith('~') ? filePath.replace('~', process.env.HOME ?? '') : filePath;
        try {
          if (fmt === 'csv') writeFileSync(resolvedPath, scheduleCToCsv(report));
          else XLSX.writeFile(scheduleCToWorkbook(report), resolvedPath, { bookType: 'xlsx' });
        } catch (err) {
          return formatToolResult({ error: `Failed to write file: ${err instanceof Error ? err.message : String(err)}` });
        }
        return formatToolResult({
          success: true,
          taxYear: year,
          format: fmt,
          filePath: resolvedPath,
          deductionsExported: report.details.length,
          total: report.total,
          message: `Exported ${report.details.length} deductions ($${report.total.toFixed(2)}) for ${year} to ${resolvedPath} (Schedule C ${fmt.toUpperCase()}).`,
        });
      }
    }
  },
});
