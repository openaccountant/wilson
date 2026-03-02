#!/usr/bin/env bun
import { config } from "dotenv";

// Load environment variables
config({ quiet: true });

const args = process.argv.slice(2);

// Enable debug logging if --debug flag is passed
if (args.includes("--debug")) {
  process.env.OA_DEBUG = "1";
}

// ── Profile selection (must happen before any DB/config access) ───────────
import {
  setActiveProfile,
  listProfiles,
  DEFAULT_PROFILE,
} from "./profile/index.js";

if (args.includes("--profiles")) {
  const profiles = listProfiles();
  if (profiles.length === 0) {
    console.log("No profiles yet. Start with: wilson --profile <name>");
  } else {
    console.log("Available profiles:");
    for (const p of profiles) {
      const suffix = p === DEFAULT_PROFILE ? " (default)" : "";
      console.log(`  ${p}${suffix}`);
    }
  }
  process.exit(0);
}

// Extract --profile <name> and remove from args so downstream doesn't see it
let profileName = DEFAULT_PROFILE;
const profileIdx = args.indexOf("--profile");
if (profileIdx !== -1) {
  const name = args[profileIdx + 1];
  if (!name || name.startsWith("--")) {
    console.error(
      "Error: --profile requires a name. Example: wilson --profile business",
    );
    process.exit(1);
  }
  profileName = name;
  args.splice(profileIdx, 2);
}

setActiveProfile(profileName);
// ──────────────────────────────────────────────────────────────────────────

const runIndex = args.indexOf("--run");

if (args.includes("--help")) {
  console.log(`Open Accountant — AI-powered personal finance CLI

Usage:
  wilson                           Start interactive mode
  wilson --run "<query>"           Run a single AI query (headless)
  wilson --profile <name>          Use a named profile (default: "default")
  wilson --profiles                List all profiles
  wilson --status                  Show database overview
  wilson --summary [period]        Spending breakdown (month|quarter|year, --offset N)
  wilson --pnl [period]            Profit & loss report (--offset N)
  wilson --savings [--months N]    Savings rate trend
  wilson --budget [--month M]      Budget vs actual
  wilson --tax-summary [year]      Tax deduction summary by IRS category
  wilson --net-worth               Net worth summary
  wilson --balance-sheet           Full balance sheet with equity
  wilson --report <path>           Generate Markdown report (--month M)
  wilson --export <path>           Export transactions (--format csv|xlsx)
  wilson --debug                   Enable debug logging to ~/.openaccountant/logs/
  wilson --help                    Show this help`);
} else if (args.includes("--status")) {
  const { printStatus } = await import("./reports.js");
  await printStatus();
} else if (args.includes("--summary")) {
  const { printSummary } = await import("./reports.js");
  await printSummary(args);
} else if (args.includes("--budget")) {
  const { printBudget } = await import("./reports.js");
  await printBudget(args);
} else if (args.includes("--pnl")) {
  const { printPnl } = await import("./reports.js");
  await printPnl(args);
} else if (args.includes("--savings")) {
  const { printSavings } = await import("./reports.js");
  await printSavings(args);
} else if (args.includes("--tax-summary")) {
  const { printTaxSummary } = await import("./reports.js");
  await printTaxSummary(args);
} else if (args.includes("--net-worth")) {
  const { printNetWorth } = await import("./reports.js");
  await printNetWorth(args);
} else if (args.includes("--balance-sheet")) {
  const { printBalanceSheet } = await import("./reports.js");
  await printBalanceSheet(args);
} else if (args.includes("--report")) {
  const { runReport } = await import("./reports.js");
  await runReport(args);
} else if (args.includes("--export")) {
  const { runExport } = await import("./reports.js");
  await runExport(args);
} else if (runIndex !== -1) {
  const query = args.slice(runIndex + 1).join(" ");
  if (!query) {
    console.error(
      'Error: --run requires a query. Example: wilson --run "How much did I spend on dining?"',
    );
    process.exit(1);
  }
  const { runHeadless } = await import("./headless.js");
  await runHeadless(query);
} else {
  const { runCli } = await import("./cli.js");
  await runCli();
}
