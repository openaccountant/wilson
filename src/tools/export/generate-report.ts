import { z } from 'zod';
import { writeFileSync } from 'fs';
import type { Database } from '../../db/compat-sqlite.js';
import { defineTool } from '../define-tool.js';
import { generateReport } from '../../report/generator.js';
import { formatToolResult } from '../types.js';
import type { ReportSection } from '../../report/templates.js';

let db: Database | null = null;

export function initGenerateReportTool(database: Database): void {
  db = database;
}

function getDb(): Database {
  if (!db) throw new Error('generate_report tool not initialized. Call initGenerateReportTool(database) first.');
  return db;
}

export const generateReportTool = defineTool({
  name: 'generate_report',
  description:
    'Generate a Markdown financial report and save it to a file. ' +
    'Includes summary, spending, budget, anomalies, savings, and transaction sections.',
  schema: z.object({
    filePath: z.string().describe('Output file path for the report'),
    month: z.string().optional().describe('Month to report on (YYYY-MM, default: current)'),
    sections: z.array(z.enum([
      'summary', 'spending', 'budget', 'anomalies', 'savings', 'transactions', 'all',
    ])).default(['all']).describe('Report sections to include'),
  }),
  func: async ({ filePath, month, sections }) => {
    const database = getDb();

    const resolvedPath = filePath.startsWith('~')
      ? filePath.replace('~', process.env.HOME ?? '')
      : filePath;

    const markdown = generateReport(database, month, sections as ReportSection[]);

    try {
      writeFileSync(resolvedPath, markdown);
      return formatToolResult({
        message: `Report saved to ${resolvedPath}`,
        filePath: resolvedPath,
        sections,
      });
    } catch (err) {
      return formatToolResult({
        error: `Failed to write report: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  },
});
