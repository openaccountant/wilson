#!/usr/bin/env bun
import { config } from 'dotenv';

// Load environment variables
config({ quiet: true });

const args = process.argv.slice(2);
const runIndex = args.indexOf('--run');

if (args.includes('--help')) {
  console.log(`Open Accountant — AI-powered personal finance CLI

Usage:
  oa                           Start interactive mode
  oa --run "<query>"           Run a single AI query (headless)
  oa --status                  Show database overview
  oa --summary [period]        Spending breakdown (month|quarter|year, --offset N)
  oa --pnl [period]            Profit & loss report (--offset N)
  oa --savings [--months N]    Savings rate trend
  oa --budget [--month M]      Budget vs actual
  oa --tax-summary [year]      Tax deduction summary by IRS category
  oa --report <path>           Generate Markdown report (--month M)
  oa --export <path>           Export transactions (--format csv|xlsx)
  oa --help                    Show this help`);
} else if (args.includes('--status')) {
  const { printStatus } = await import('./reports.js');
  await printStatus();
} else if (args.includes('--summary')) {
  const { printSummary } = await import('./reports.js');
  await printSummary(args);
} else if (args.includes('--budget')) {
  const { printBudget } = await import('./reports.js');
  await printBudget(args);
} else if (args.includes('--pnl')) {
  const { printPnl } = await import('./reports.js');
  await printPnl(args);
} else if (args.includes('--savings')) {
  const { printSavings } = await import('./reports.js');
  await printSavings(args);
} else if (args.includes('--tax-summary')) {
  const { printTaxSummary } = await import('./reports.js');
  await printTaxSummary(args);
} else if (args.includes('--report')) {
  const { runReport } = await import('./reports.js');
  await runReport(args);
} else if (args.includes('--export')) {
  const { runExport } = await import('./reports.js');
  await runExport(args);
} else if (runIndex !== -1) {
  const query = args.slice(runIndex + 1).join(' ');
  if (!query) {
    console.error('Error: --run requires a query. Example: oa --run "How much did I spend on dining?"');
    process.exit(1);
  }
  const { runHeadless } = await import('./headless.js');
  await runHeadless(query);
} else {
  const { runCli } = await import('./cli.js');
  await runCli();
}
