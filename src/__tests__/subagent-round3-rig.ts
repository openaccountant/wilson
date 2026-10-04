import { describe, expect, test } from 'bun:test';
import { CATEGORIES } from '../tools/categorize/categories.js';
import { runSubagent, type GenerateRequest, type SubagentDeps } from '../dashboard/ui/src/hybrid/subagent-core.js';
import { DEFAULT_SUBAGENT_LIMITS, type StepEvent, type SubagentLimits, type SubagentOutcome } from '../dashboard/ui/src/hybrid/worker-protocol.js';
import type { ReadToolName, ToolReadResult } from '../dashboard/ui/src/store/mirror-tools.js';

/** Shared harness for the Round-3 loop tests (not a test file). */

export const ok = (data: unknown, summary = 'summary'): ToolReadResult => ({ servable: true, profile: 'default', data, summary });

export const PNL = ok({
  period: 'June 2026',
  dateRange: { start: '2026-06-01', end: '2026-06-30' },
  totalIncome: 7900,
  totalExpenses: -4878.29,
  netProfitLoss: 3021.71,
  incomeByCategory: [{ category: 'Client Income', total: 7900, count: 3 }],
  expensesByCategory: [{ category: 'Rent', total: -1800, count: 1 }, { category: 'Groceries', total: -3078.29, count: 9 }],
  formatted: 'P&L',
});

export const EMPTY: Record<ReadToolName, { q: string; res: ToolReadResult }> = {
  transaction_search: { q: 'Show me every Zzyzx Labs charge', res: ok({ query: 'x', count: 0, transactions: [], formatted: 'No transactions found matching your query.' }) },
  spending_summary: {
    q: 'spending by category this month',
    res: ok({ period: 'October 2026', totalSpending: 0, transactionCount: 0, categories: [], previousPeriod: { label: 'September 2026', categories: [], totalSpending: 0 }, formatted: 'x' }),
  },
  profit_loss: { q: 'P&L june', res: ok({ period: 'June 2026', totalIncome: 0, totalExpenses: 0, netProfitLoss: 0, incomeByCategory: [], expensesByCategory: [], formatted: 'x' }) },
  net_worth: { q: 'what is my net worth', res: ok({ message: 'No accounts configured. Add accounts to track net worth.' }) },
  forecast: {
    q: 'forecast',
    res: ok({
      trailingMonths: 3, horizonMonths: 3, startingCash: 0, trailingMonthlyIncome: 0, trailingMonthlyExpense: 0, trailingMonthlyNet: 0, adjustedMonthlyNet: 0,
      appliedAdjustments: [], projection: [{ month: '2026-08', projectedCash: 0 }, { month: '2026-09', projectedCash: 0 }, { month: '2026-10', projectedCash: 0 }], horizonEndCash: 0,
    }),
  },
};

export function rig(tool: ToolReadResult, opts: { llm?: (req: GenerateRequest) => string; unseeded?: boolean } = {}) {
  const gens: GenerateRequest[] = [];
  const reads: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const events: StepEvent[] = [];
  const deps: SubagentDeps = {
    generate: async (req) => {
      gens.push(req);
      return opts.llm ? opts.llm(req) : 'Your net profit for June 2026 was $3,021.71.';
    },
    toolRead: async (req) => {
      reads.push({ tool: req.tool, args: req.args });
      return tool;
    },
    status: async () => ({ profile: 'default', seeded: !opts.unseeded, lastSyncedAt: '2026-07-15T11:59:00.000Z', schemaVersion: 4, servable: ['profit_loss'], categories: CATEGORIES }),
    now: () => Date.now(),
    emit: (e) => events.push(e),
  };
  const run = (query: string, limits: Partial<SubagentLimits> = {}): Promise<SubagentOutcome> =>
    runSubagent(deps, { query, nowIso: '2026-07-15T12:00:00.000Z', expectedProfile: 'default', priorLocalTurns: [], limits: { ...DEFAULT_SUBAGENT_LIMITS, ...limits } });
  return { run, gens, reads, events };
}

