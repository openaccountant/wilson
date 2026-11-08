#!/usr/bin/env bun
import { config } from "dotenv";

// Load environment variables
config({ quiet: true });

const args = process.argv.slice(2);

// `wilson --mcp-server` speaks JSON-RPC on stdout, so nothing else may print
// there: send every console line to stderr before any profile/DB code can log.
// (Not to be confused with `--mcp`, which lists Wilson's MCP *client* connections.)
const mcpServerIdx = args.indexOf("--mcp-server");
const mcpMode = mcpServerIdx !== -1;
if (mcpMode) {
  args.splice(mcpServerIdx, 1);
  const toStderr = (...a: unknown[]) => console.error(...a);
  console.log = toStderr;
  console.info = toStderr;
  console.debug = toStderr;
  console.warn = toStderr;
}

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
// WILSON_PROFILE picks the profile when --profile is absent (the Claude Desktop
// extension passes its "profile" setting this way). An unexpanded host
// placeholder or a blank value means the default.
const envProfile = process.env.WILSON_PROFILE?.trim();
let profileName =
  envProfile && !envProfile.startsWith("${") ? envProfile : DEFAULT_PROFILE;
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

// The extension's profile setting is free text typed into a settings form: keep
// it a plain folder name (no "..", no separators).
if (mcpMode && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(profileName)) {
  console.error(
    `Error: profile name "${profileName}" must be letters, digits, - or _ (up to 64).`,
  );
  process.exit(1);
}

setActiveProfile(profileName);
// ──────────────────────────────────────────────────────────────────────────

const runIndex = args.indexOf("--run");

if (mcpMode) {
  const { runStdioServer } = await import("./mcp/stdio-server.js");
  await runStdioServer();
} else if (args.includes("--help")) {
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
  wilson --dashboard [--port N]     Run standalone dashboard server
  wilson --sync                    Sync all linked accounts (Plaid, Monarch, Firefly III)
  wilson --index                   Build the local semantic index for existing transactions (on-device)
  wilson --mcp                     Show MCP server connections and available tools
  wilson --mcp-server              Run as an MCP server on stdio (Claude Desktop extension)
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
} else if (args.includes("--dashboard")) {
  const portIdx = args.indexOf("--port");
  const port = portIdx !== -1 ? parseInt(args[portIdx + 1], 10) : undefined;
  const { runStandalone } = await import("./dashboard/standalone.js");
  await runStandalone(port);
} else if (args.includes("--mcp")) {
  const { initMcpClients, getConnectedServers, getMcpClient, closeMcpClients } = await import("./mcp/client.js");
  const connected = await initMcpClients();
  if (connected.length === 0) {
    console.log("No MCP servers configured. Add servers to ~/.openaccountant/mcp.json");
  } else {
    console.log(`Connected to ${connected.length} MCP server(s):\n`);
    for (const name of connected) {
      const client = getMcpClient(name)!;
      const { tools } = await client.listTools();
      console.log(`  ${name} (${tools.length} tool${tools.length === 1 ? '' : 's'})`);
      for (const tool of tools) {
        console.log(`    - ${tool.name}: ${tool.description?.slice(0, 80) ?? '(no description)'}`);
      }
    }
    await closeMcpClients();
  }
} else if (args.includes("--sync")) {
  const { runSync } = await import("./sync.js");
  await runSync();
} else if (args.includes("--index")) {
  const { runEmbeddingIndex } = await import("./embedding-backfill.js");
  const { initDatabase } = await import("./db/database.js");
  const { DEFAULT_EMBEDDING_MODEL, EMBEDDING_DIM } = await import("./utils/embeddings.js");
  const db = initDatabase();
  try {
    const result = await runEmbeddingIndex({
      db,
      onModelDownload: (pct) => {
        if (pct >= 100) {
          process.stdout.write("\rEmbedding model ready.            \n");
        } else {
          process.stdout.write(`\rDownloading embedding model… ${pct}%  `);
        }
      },
      onProgress: (indexed, total) => {
        const pct = total > 0 ? Math.round((indexed / total) * 100) : 100;
        process.stdout.write(`\rIndexing ${indexed}/${total} (${pct}%)  `);
      },
    });
    if (result.total === 0) {
      console.log(
        result.alreadyIndexed > 0
          ? `All ${result.alreadyIndexed} transactions already indexed — nothing to do.`
          : "No transactions to index."
      );
    } else {
      console.log(
        `\nIndexed ${result.indexed} transactions · model ${DEFAULT_EMBEDDING_MODEL} · dim ${EMBEDDING_DIM}`
      );
    }
  } finally {
    db.close();
  }
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
