import { z } from 'zod';
import type { Database } from '../../db/compat-sqlite.js';
import { defineTool } from '../define-tool.js';
import { getProfitLoss, type SpendingSummaryRow } from '../../db/queries.js';
import { getPeriodDates } from './spending-summary.js';
import { formatToolResult } from '../types.js';

let db: Database | null = null;

export function initProfitDiffTool(database: Database): void {
  db = database;
}

function getDb(): Database {
  if (!db) throw new Error('profit_diff tool not initialized. Call initProfitDiffTool(database) first.');
  return db;
}

interface CategoryDelta {
  category: string;
  current: number;
  previous: number;
  delta: number;
  percentChange: number | null;
}

function computeDeltas(current: SpendingSummaryRow[], previous: SpendingSummaryRow[]): CategoryDelta[] {
  const prevMap = new Map(previous.map((r) => [r.category, r.total]));
  const allCategories = new Set([...current.map((r) => r.category), ...previous.map((r) => r.category)]);

  const deltas: CategoryDelta[] = [];
  for (const cat of allCategories) {
    const cur = current.find((r) => r.category === cat)?.total ?? 0;
    const prev = prevMap.get(cat) ?? 0;
    const delta = cur - prev;
    const percentChange = prev !== 0 ? ((cur - prev) / Math.abs(prev)) * 100 : null;
    deltas.push({ category: cat, current: cur, previous: prev, delta, percentChange });
  }
  return deltas.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
}

export const profitDiffTool = defineTool({
  name: 'profit_diff',
  description:
    'Compare profit & loss between two periods. Shows per-category deltas, percent changes, and biggest movers.',
  schema: z.object({
    period: z.enum(['month', 'quarter', 'year']).default('month')
      .describe('Time period granularity'),
    offset: z.number().default(0)
      .describe('Current period offset (0=current)'),
    compareOffset: z.number().default(-1)
      .describe('Comparison period offset (-1=previous period)'),
  }),
  func: async ({ period, offset, compareOffset }) => {
    const database = getDb();

    const cur = getPeriodDates(period, offset);
    const prev = getPeriodDates(period, offset + compareOffset);

    const curPnl = getProfitLoss(database, cur.start, cur.end);
    const prevPnl = getProfitLoss(database, prev.start, prev.end);

    const incomeDeltas = computeDeltas(curPnl.incomeByCategory, prevPnl.incomeByCategory);
    const expenseDeltas = computeDeltas(curPnl.expensesByCategory, prevPnl.expensesByCategory);

    const netDelta = curPnl.netProfitLoss - prevPnl.netProfitLoss;
    const netPctChange = prevPnl.netProfitLoss !== 0
      ? ((curPnl.netProfitLoss - prevPnl.netProfitLoss) / Math.abs(prevPnl.netProfitLoss)) * 100
      : null;

    // Top 3 biggest movers by absolute delta
    const allDeltas = [...incomeDeltas, ...expenseDeltas];
    const biggestMovers = allDeltas
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
      .slice(0, 3);

    // New and dropped categories
    const newCategories = allDeltas.filter((d) => d.previous === 0 && d.current !== 0).map((d) => d.category);
    const droppedCategories = allDeltas.filter((d) => d.current === 0 && d.previous !== 0).map((d) => d.category);

    const lines: string[] = [`P&L Comparison: ${cur.label} vs ${prev.label}`, ''];

    lines.push('NET P&L');
    const fmtDelta = (v: number) => (v >= 0 ? `+$${v.toFixed(2)}` : `-$${Math.abs(v).toFixed(2)}`);
    lines.push(`  Current:  ${fmtDelta(curPnl.netProfitLoss)}`);
    lines.push(`  Previous: ${fmtDelta(prevPnl.netProfitLoss)}`);
    lines.push(`  Change:   ${fmtDelta(netDelta)}${netPctChange !== null ? ` (${netPctChange > 0 ? '+' : ''}${netPctChange.toFixed(0)}%)` : ''}`);
    lines.push('');

    if (biggestMovers.length > 0) {
      lines.push('BIGGEST MOVERS');
      for (const m of biggestMovers) {
        const pct = m.percentChange !== null ? ` (${m.percentChange > 0 ? '+' : ''}${m.percentChange.toFixed(0)}%)` : ' (new)';
        lines.push(`  ${m.category.padEnd(20)} ${fmtDelta(m.delta)}${pct}`);
      }
      lines.push('');
    }

    if (newCategories.length > 0) lines.push(`New categories: ${newCategories.join(', ')}`);
    if (droppedCategories.length > 0) lines.push(`Dropped categories: ${droppedCategories.join(', ')}`);

    return formatToolResult({
      currentPeriod: cur.label,
      previousPeriod: prev.label,
      currentNet: curPnl.netProfitLoss,
      previousNet: prevPnl.netProfitLoss,
      netDelta,
      netPctChange,
      incomeDeltas,
      expenseDeltas,
      biggestMovers,
      newCategories,
      droppedCategories,
      formatted: lines.join('\n'),
    });
  },
});
