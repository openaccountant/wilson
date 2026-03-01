import { createRequire } from 'module';
import type { ToolDef } from '../model/types.js';
import { discoverSkills } from '../skills/index.js';
import { skillTool, SKILL_TOOL_DESCRIPTION } from './skill.js';
import { getOrchestrationTools } from '../orchestration/registry.js';
import { getCachedMcpTools } from '../mcp/adapter.js';

const require = createRequire(import.meta.url);

/**
 * A registered tool with its rich description for system prompt injection.
 */
export interface RegisteredTool {
  /** Tool name (must match the tool's name property) */
  name: string;
  /** The actual tool instance */
  tool: ToolDef;
  /** Rich description for system prompt (includes when to use, when not to use, etc.) */
  description: string;
}

// ============================================================================
// Tool Descriptions
// ============================================================================

const MONARCH_IMPORT_DESCRIPTION = `
**Requires Pro license.** Import transactions from Monarch Money into the local database.

## When to Use

- When the user wants to import transactions from Monarch Money
- When the user says "sync from Monarch", "import from Monarch", or "pull my Monarch transactions"
- When the user wants to connect their Monarch Money account

## When NOT to Use

- When the user wants to import from a CSV file (use csv_import instead)
- When the user is asking about already-imported transactions

## Usage Notes

- Requires MONARCH_TOKEN env var (or MONARCH_EMAIL + MONARCH_PASSWORD)
- Fetches transactions via Monarch's GraphQL API
- Supports date range filtering via startDate/endDate
- Skips pending transactions
- Deduplicates against previously imported Monarch transactions
`.trim();

const CSV_IMPORT_DESCRIPTION = `
Import transactions from a CSV file into the local database.

## When to Use

- When the user wants to import bank or credit card statements
- When the user provides a CSV file path for transaction data
- When the user says "import", "load", or "add" transactions from a file

## When NOT to Use

- When the user is asking about already-imported transactions
- When the user wants to export or download data

## Usage Notes

- Accepts standard bank/credit card CSV formats (date, description, amount)
- Automatically detects column mapping for common bank formats
- Deduplicates against existing transactions in the database
- Returns count of imported vs skipped transactions
`.trim();

const CATEGORIZE_DESCRIPTION = `
Categorize transactions using AI-powered classification.

## When to Use

- When the user wants to categorize uncategorized transactions
- When the user asks to "organize", "label", or "sort" their spending
- After importing new transactions that need categorization
- When the user wants to recategorize transactions

## When NOT to Use

- When transactions are already categorized and user hasn't asked to recategorize
- When the user is just querying existing data

## Usage Notes

- Call ONCE with the full batch — it handles multiple transactions internally
- Uses local LLM (Ollama) for privacy-first categorization
- Categories include: Groceries, Dining, Transport, Housing, Utilities, Entertainment, Shopping, Health, Travel, Income, Transfer, and more
- This is a bulk operation that requires user approval before execution
`.trim();

const TRANSACTION_SEARCH_DESCRIPTION = `
Search and filter transactions in the local database.

## When to Use

- When the user asks about specific transactions ("show me all Amazon charges")
- When the user wants to find transactions by merchant, category, date range, or amount
- When the user asks "what did I spend on..." or "how many times did I..."
- When looking up individual charges or patterns

## When NOT to Use

- When the user wants aggregate summaries (use spending_summary instead)
- When the user wants to detect anomalies (use anomaly_detect instead)

## Usage Notes

- Supports filtering by: merchant name, category, date range, amount range, description keywords
- Returns individual transaction records with full details
- Results are sorted by date (most recent first) by default
- Use natural language queries — the tool parses intent from the query
`.trim();

const SPENDING_SUMMARY_DESCRIPTION = `
Generate spending summaries and reports with breakdowns.

## When to Use

- When the user asks "how much did I spend" on something
- When the user wants a breakdown by category, merchant, or time period
- When the user asks for monthly/weekly/yearly spending reports
- When the user wants to compare spending across periods
- When the user asks "where does my money go"

## When NOT to Use

- When the user wants to find specific individual transactions (use transaction_search)
- When the user wants to detect unusual charges (use anomaly_detect)

## Usage Notes

- Supports breakdowns by: category, merchant, month, week
- Can filter by date range, category, or merchant
- Returns totals, averages, and percentage breakdowns
- Handles multiple time period comparisons (e.g., "this month vs last month")
`.trim();

const ANOMALY_DETECT_DESCRIPTION = `
Detect unusual transactions, duplicate charges, and subscription issues.

## When to Use

- When the user asks about unusual or suspicious charges
- When the user wants to find duplicate transactions
- When the user asks about subscription costs or unused subscriptions
- When the user says "anything weird" or "check for problems"
- When the user wants to audit their spending for issues

## When NOT to Use

- When the user wants normal spending summaries (use spending_summary)
- When the user is looking for specific known transactions (use transaction_search)

## Usage Notes

- Detects: unusually large charges, duplicate charges, subscription changes, unused subscriptions
- Configurable detection types via the types parameter
- Returns flagged transactions with explanations of why they were flagged
- For subscription analysis, identifies recurring charges and estimates monthly/annual cost
`.trim();

const BUDGET_SET_DESCRIPTION = `
Set or update a monthly spending budget for a category.

## When to Use

- When the user wants to set a spending limit for a category
- When the user says "set budget", "limit my spending", or "I want to spend no more than..."
- When updating an existing budget amount

## When NOT to Use

- When the user wants to check budget status (use budget_check instead)
- When the user is asking about spending without setting limits

## Usage Notes

- One budget per category — setting a new amount overwrites the old one
- Category names should match the categorization system (e.g., Dining, Groceries, Shopping)
`.trim();

const BUDGET_CHECK_DESCRIPTION = `
Compare actual spending vs budget limits for a month.

## When to Use

- When the user asks "am I over budget", "how's my budget", or "budget status"
- When the user wants to see remaining spending capacity
- When the user asks about spending relative to limits

## When NOT to Use

- When the user wants to set or change budget limits (use budget_set instead)
- When the user wants spending summaries without budget context (use spending_summary)

## Usage Notes

- Shows per-category breakdown: budget, actual, remaining, % used, over/under status
- Defaults to current month if no month specified
- Can filter to a single category
`.trim();

const EXPORT_TRANSACTIONS_DESCRIPTION = `
Export transactions to CSV or XLSX files.

## When to Use

- When the user wants to export, download, or save their transactions to a file
- When the user says "export to CSV", "save as spreadsheet", "download my transactions"
- When the user wants to share their financial data or open it in Excel/Google Sheets

## When NOT to Use

- When the user is asking about or querying transactions (use transaction_search)
- When the user wants to import data (use csv_import or monarch_import)

## Usage Notes

- Supports CSV and XLSX (Excel) formats
- Can filter by date range, category, and merchant/description
- Resolves ~ in file paths to home directory
- Exported columns: date, description, amount, category
`.trim();

const PLAID_SYNC_DESCRIPTION = `
**Requires Pro license.** Sync transactions from linked bank accounts via Plaid.

## When to Use

- When the user says "sync", "pull transactions", or "update from bank"
- When the user wants to import latest transactions from linked accounts
- After the user has connected a bank account with /connect

## When NOT to Use

- When the user wants to import from a CSV file (use csv_import instead)
- When no bank accounts are linked (direct user to /connect first)

## Usage Notes

- Requires linked Plaid accounts (set up via /connect)
- Uses incremental sync — only fetches new transactions since last sync
- Deduplicates against previously synced transactions via plaid_transaction_id
- Requires PLAID_CLIENT_ID and PLAID_SECRET environment variables
`.trim();

const WEB_SEARCH_DESCRIPTION = `
Search the web for current information on any topic.

## When to Use

- When the user asks about current financial news or events
- When looking up information about a merchant or service
- When the user needs general knowledge to supplement their financial data
- When verifying claims about companies, services, or financial topics

## When NOT to Use

- When the user's question can be answered from their transaction data alone
- For pure conceptual/definitional questions ("What is a budget?")

## Usage Notes

- Provide specific, well-formed search queries for best results
- Returns up to 5 results with URLs and content snippets
- Use for supplementary research when local data doesn't cover the topic
`.trim();

// ============================================================================
// Safe import helper
// ============================================================================

/**
 * Safely require a module, returning null if it doesn't exist yet.
 * Uses createRequire for ESM compatibility.
 */
function safeRequire<T>(modulePath: string): T | null {
  try {
    return require(modulePath) as T;
  } catch {
    return null;
  }
}

// ============================================================================
// Registry
// ============================================================================

/**
 * Get all registered tools with their descriptions.
 * Conditionally includes tools based on environment configuration.
 *
 * @param model - The model name (needed for tools that require model-specific configuration)
 * @returns Array of registered tools
 */
export async function getToolRegistry(model: string): Promise<RegisteredTool[]> {
  const tools: RegisteredTool[] = [];

  // Always-available tools (gracefully skip if not yet implemented)

  const csvMod = safeRequire<{ csvImportTool: ToolDef }>('./import/csv-import.js');
  if (csvMod?.csvImportTool) {
    tools.push({
      name: 'csv_import',
      tool: csvMod.csvImportTool,
      description: CSV_IMPORT_DESCRIPTION,
    });
  }

  const monarchMod = safeRequire<{ monarchImportTool: ToolDef }>('./import/monarch.js');
  if (monarchMod?.monarchImportTool) {
    tools.push({
      name: 'monarch_import',
      tool: monarchMod.monarchImportTool,
      description: MONARCH_IMPORT_DESCRIPTION,
    });
  }

  const catMod = safeRequire<{ categorizeTool: ToolDef }>('./categorize/categorize.js');
  if (catMod?.categorizeTool) {
    tools.push({
      name: 'categorize',
      tool: catMod.categorizeTool,
      description: CATEGORIZE_DESCRIPTION,
    });
  }

  const txnMod = safeRequire<{ transactionSearchTool: ToolDef }>('./query/transaction-search.js');
  if (txnMod?.transactionSearchTool) {
    tools.push({
      name: 'transaction_search',
      tool: txnMod.transactionSearchTool,
      description: TRANSACTION_SEARCH_DESCRIPTION,
    });
  }

  const sumMod = safeRequire<{ spendingSummaryTool: ToolDef }>('./query/spending-summary.js');
  if (sumMod?.spendingSummaryTool) {
    tools.push({
      name: 'spending_summary',
      tool: sumMod.spendingSummaryTool,
      description: SPENDING_SUMMARY_DESCRIPTION,
    });
  }

  const anomMod = safeRequire<{ anomalyDetectTool: ToolDef }>('./query/anomaly-detect.js');
  if (anomMod?.anomalyDetectTool) {
    tools.push({
      name: 'anomaly_detect',
      tool: anomMod.anomalyDetectTool,
      description: ANOMALY_DETECT_DESCRIPTION,
    });
  }

  const exportMod = safeRequire<{ exportTransactionsTool: ToolDef }>('./export/export-transactions.js');
  if (exportMod?.exportTransactionsTool) {
    tools.push({
      name: 'export_transactions',
      tool: exportMod.exportTransactionsTool,
      description: EXPORT_TRANSACTIONS_DESCRIPTION,
    });
  }

  // Budget tools (always available)
  const budgetSetMod = safeRequire<{ budgetSetTool: ToolDef }>('./budget/budget-set.js');
  if (budgetSetMod?.budgetSetTool) {
    tools.push({
      name: 'budget_set',
      tool: budgetSetMod.budgetSetTool,
      description: BUDGET_SET_DESCRIPTION,
    });
  }

  const budgetCheckMod = safeRequire<{ budgetCheckTool: ToolDef }>('./budget/budget-check.js');
  if (budgetCheckMod?.budgetCheckTool) {
    tools.push({
      name: 'budget_check',
      tool: budgetCheckMod.budgetCheckTool,
      description: BUDGET_CHECK_DESCRIPTION,
    });
  }

  const plaidMod = safeRequire<{ plaidSyncTool: ToolDef }>('./import/plaid-sync.js');
  if (plaidMod?.plaidSyncTool) {
    tools.push({
      name: 'plaid_sync',
      tool: plaidMod.plaidSyncTool,
      description: PLAID_SYNC_DESCRIPTION,
    });
  }

  // MCP tools (loaded at startup from ~/.openspend/mcp.json)
  for (const mcpTool of getCachedMcpTools()) {
    tools.push({
      name: mcpTool.name,
      tool: mcpTool,
      description: mcpTool.description,
    });
  }

  // Conditional: web_search (if any search API key is configured)
  if (process.env.EXASEARCH_API_KEY) {
    const mod = safeRequire<{ exaSearch: ToolDef }>('./search/exa.js');
    if (mod?.exaSearch) {
      tools.push({
        name: 'web_search',
        tool: mod.exaSearch,
        description: WEB_SEARCH_DESCRIPTION,
      });
    }
  } else if (process.env.PERPLEXITY_API_KEY) {
    const mod = safeRequire<{ perplexitySearch: ToolDef }>('./search/perplexity.js');
    if (mod?.perplexitySearch) {
      tools.push({
        name: 'web_search',
        tool: mod.perplexitySearch,
        description: WEB_SEARCH_DESCRIPTION,
      });
    }
  } else if (process.env.TAVILY_API_KEY) {
    const mod = safeRequire<{ tavilySearch: ToolDef }>('./search/tavily.js');
    if (mod?.tavilySearch) {
      tools.push({
        name: 'web_search',
        tool: mod.tavilySearch,
        description: WEB_SEARCH_DESCRIPTION,
      });
    }
  } else if (process.env.BRAVE_API_KEY) {
    const mod = safeRequire<{ braveSearch: ToolDef }>('./search/brave.js');
    if (mod?.braveSearch) {
      tools.push({
        name: 'web_search',
        tool: mod.braveSearch,
        description: WEB_SEARCH_DESCRIPTION,
      });
    }
  }

  // Conditional: skill tool (if any skills are discovered)
  const availableSkills = discoverSkills();
  if (availableSkills.length > 0) {
    tools.push({
      name: 'skill',
      tool: skillTool,
      description: SKILL_TOOL_DESCRIPTION,
    });
  }

  // Orchestration: chains + teams registered as tools
  for (const orchTool of await getOrchestrationTools()) {
    tools.push({
      name: orchTool.name,
      tool: orchTool,
      description: orchTool.description,
    });
  }

  return tools;
}

/**
 * Get just the tool instances for binding to the LLM.
 *
 * @param model - The model name
 * @returns Array of tool instances
 */
export async function getTools(model: string): Promise<ToolDef[]> {
  return (await getToolRegistry(model)).map((t) => t.tool);
}

/**
 * Get tools by their names (for chain/team orchestration).
 *
 * @param names - Array of tool names to resolve
 * @returns Array of matching tool instances
 */
export async function getToolsByNames(names: string[]): Promise<ToolDef[]> {
  // Use a default model since tool availability is mostly API-key based
  const registry = await getToolRegistry('gpt-5.2');
  const nameSet = new Set(names);
  return registry.filter((t) => nameSet.has(t.name)).map((t) => t.tool);
}

/**
 * Build the tool descriptions section for the system prompt.
 * Formats each tool's rich description with a header.
 *
 * @param model - The model name
 * @returns Formatted string with all tool descriptions
 */
export async function buildToolDescriptions(model: string): Promise<string> {
  return (await getToolRegistry(model))
    .map((t) => `### ${t.name}\n\n${t.description}`)
    .join('\n\n');
}
