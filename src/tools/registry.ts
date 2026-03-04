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

const FIREFLY_IMPORT_DESCRIPTION = `
**Requires Pro license.** Import transactions from a self-hosted Firefly III instance into the local database.

## When to Use

- When the user wants to import transactions from Firefly III
- When the user says "sync from Firefly", "import from Firefly III", or "pull my Firefly transactions"
- When the user wants to connect their self-hosted Firefly III instance

## When NOT to Use

- When the user wants to import from a CSV file (use csv_import instead)
- When the user is asking about already-imported transactions

## Usage Notes

- Requires FIREFLY_API_URL and FIREFLY_API_TOKEN env vars
- Fetches transactions via Firefly III REST API (v1)
- Supports date range filtering via startDate/endDate
- Transfers are skipped by default (use includeTransfers to include them)
- Deduplicates by external_id and composite key (date|description|amount)
- Skips reconciliation and opening balance entries
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

const PROFIT_LOSS_DESCRIPTION = `
Generate a profit & loss report showing income vs expenses by category.

## When to Use

- When the user asks about their P&L, profit and loss, income vs expenses
- When the user says "am I making money", "what's my net income", "show my P&L"
- When the user wants to see their financial position for a period

## When NOT to Use

- When the user only wants spending breakdown without income (use spending_summary)
- When the user wants to compare two periods (use profit_diff instead)

## Usage Notes

- Shows income by category, expenses by category, and net profit/loss
- Supports month, quarter, and year periods with offset
- Positive net = profit, negative net = loss
`.trim();

const PROFIT_DIFF_DESCRIPTION = `
Compare profit & loss between two periods to identify changes.

## When to Use

- When the user wants to compare spending/income between periods
- When the user asks "how did my finances change", "month over month comparison"
- When the user wants to see what categories grew or shrank

## When NOT to Use

- When the user just wants a single period P&L (use profit_loss)
- When the user wants a simple spending comparison (use spending_summary with compareWithPrevious)

## Usage Notes

- Shows per-category deltas and percent changes
- Highlights top 3 biggest movers
- Identifies new and dropped categories
`.trim();

const RULE_MANAGE_DESCRIPTION = `
Manage categorization rules for automatic transaction classification.

## When to Use

- When the user wants to create rules for auto-categorizing transactions
- When the user says "always categorize X as Y", "set up a rule", "manage rules"
- When the user wants to list, add, update, or delete categorization rules

## When NOT to Use

- When the user wants to manually categorize specific transactions (use categorize)
- When the user is asking about existing categories without wanting to create rules

## Usage Notes

- Rules are matched before the LLM runs during categorization
- Supports glob patterns (e.g., "*AMAZON*") and regex
- Higher priority rules match first
- Actions: add, update, delete, list
`.trim();

const TAX_FLAG_DESCRIPTION = `
**Requires Pro license.** Track tax-deductible transactions with IRS Schedule C categories.

## When to Use

- When the user wants to flag a transaction as tax-deductible
- When the user asks about tax deductions, Schedule C, or business expenses
- When the user wants a tax summary or list of flagged deductions

## When NOT to Use

- When the user is just asking about spending (use spending_summary)
- When the user wants general categorization (use categorize)

## Usage Notes

- Uses official IRS Schedule C categories (22 categories)
- Actions: flag, unflag, summary, list
- Summary shows total deductions by IRS category
`.trim();

const SAVINGS_RATE_DESCRIPTION = `
Calculate and track savings rate over time with income vs expense trend.

## When to Use

- When the user asks about their savings rate, how much they're saving
- When the user wants to see income vs expenses over time
- When the user asks about the 50/30/20 rule or savings benchmarks

## When NOT to Use

- When the user wants a P&L for a single period (use profit_loss)
- When the user wants detailed spending categories (use spending_summary)

## Usage Notes

- Shows monthly income, expenses, savings, and savings rate
- Includes 50/30/20 benchmark comparison for the latest month
- Default: last 6 months
`.trim();

const ALERT_CHECK_DESCRIPTION = `
Check for active spending alerts and warnings.

## When to Use

- When the user asks "any alerts", "anything I should know about", "check my finances"
- When the user wants to see budget warnings or unusual activity
- As part of a financial health check

## When NOT to Use

- When the user wants detailed anomaly analysis (use anomaly_detect)
- When the user is asking about a specific transaction

## Usage Notes

- Checks: budget warnings (>=80%), budget exceeded (>=100%), spending spikes (>2.5x average), new recurring charges
- All computed in real-time from existing data
- Severity levels: info, warning, critical
`.trim();

const EDIT_TRANSACTION_DESCRIPTION = `
Edit a transaction's fields (date, description, amount, category, notes).

## When to Use

- When the user wants to change a transaction's category, description, date, amount, or notes
- When the user says "change", "update", "edit", "fix", or "correct" a transaction
- When the user wants to recategorize a specific transaction manually

## When NOT to Use

- When the user wants to bulk-categorize (use categorize instead)
- When the user wants to delete a transaction (use delete_transaction)

## Usage Notes

- Requires a transaction ID — use transaction_search first to find it
- Only the specified fields are updated; others remain unchanged
`.trim();

const DELETE_TRANSACTION_DESCRIPTION = `
Delete a transaction permanently from the database.

## When to Use

- When the user wants to remove a transaction
- When the user says "delete", "remove", or "get rid of" a transaction
- When a transaction was imported in error or is a duplicate

## When NOT to Use

- When the user wants to edit a transaction (use edit_transaction)
- When the user hasn't identified which transaction to delete

## Usage Notes

- This is permanent and cannot be undone
- Requires a transaction ID — use transaction_search first to find it
- Confirm with the user before deleting
`.trim();

const GENERATE_REPORT_DESCRIPTION = `
Generate a comprehensive Markdown financial report and save to a file.

## When to Use

- When the user asks to "generate a report", "export a report", "create a financial summary"
- When the user wants a printable/shareable overview of their finances
- When the user specifies a file path for report output

## When NOT to Use

- When the user just wants to see data in the terminal (use specific query tools)
- When the user wants CSV/XLSX export (use export_transactions)

## Usage Notes

- Sections: summary, spending, budget, anomalies, savings, transactions
- Output is Markdown, suitable for viewing in any Markdown renderer
- Supports filtering by month and section selection
`.trim();

const ACCOUNT_MANAGE_DESCRIPTION = `
Add, update, remove, or list financial accounts for net worth tracking.

## When to Use

- When the user says "add my house", "track my 401k", "I have a car loan", "what accounts do I have"
- When the user wants to set up accounts for net worth tracking
- When the user mentions bank accounts, investment accounts, real estate, vehicles, or loans

## When NOT to Use

- When the user wants to import transactions (use csv_import)
- When the user is asking about transaction-level data

## Usage Notes

- Supports asset types: checking, savings, investment, real_estate, vehicle, cash, crypto
- Supports liability types: mortgage, auto_loan, student_loan, personal_loan, credit_card, heloc, medical_debt
- Remove is a soft delete (deactivate) — data is preserved
`.trim();

const BALANCE_UPDATE_DESCRIPTION = `
Update the current balance of a financial account and record a point-in-time snapshot.

## When to Use

- When the user says "my 401k is now worth $215k", "house appraised at $425k"
- When the user wants to update an account balance
- When the user provides a new balance for any tracked account

## When NOT to Use

- When the user wants to add a new account (use account_manage)
- When the user is talking about transactions, not balances

## Usage Notes

- Updates current_balance and records a snapshot for trend tracking
- Snapshots are stored per date — updating twice on the same day overwrites
`.trim();

const NET_WORTH_DESCRIPTION = `
Calculate and display net worth summary, trend over time, or full balance sheet.

## When to Use

- When the user asks "what's my net worth", "show my balance sheet", "am I building wealth"
- When the user wants to see their overall financial position
- When the user asks about assets vs liabilities

## When NOT to Use

- When the user is asking about spending or transactions (use spending_summary or transaction_search)
- When the user wants to manage individual accounts (use account_manage)

## Usage Notes

- summary: current net worth with asset/liability breakdown by subtype (Free)
- trend: monthly net worth change over N months — requires balance snapshots (Pro)
- balance_sheet: full account listing with equity calculations for financed assets (Free)
`.trim();

const MORTGAGE_MANAGE_DESCRIPTION = `
**Requires Pro license.** Manage loans and view amortization schedules, payoff simulations.

## When to Use

- When the user asks "show my mortgage schedule", "when will my loan be paid off"
- When the user says "what if I pay $200 extra per month"
- When the user wants to add or update loan details

## When NOT to Use

- When the user wants to add a liability account (use account_manage first, then mortgage_manage)
- When the user is asking about spending, not debt

## Usage Notes

- Interest rate is entered as percentage (6.5, not 0.065)
- add: creates loan record linked to a liability account, optionally links to asset
- schedule: shows full/partial amortization table
- payoff: simulates early payoff with extra monthly payments
`.trim();

const LINK_TRANSACTIONS_DESCRIPTION = `
Link unlinked transactions to an account by matching account_last4, bank, or account_name.
Can look up the target account by numeric ID or by name (use lookupName when the ID is unknown).

## When to Use

- When the user says "these Chase transactions are from my checking"
- When the user wants to associate existing transactions with a tracked account
- After importing transactions and setting up accounts
- Use lookupName (e.g., "Amex Gold") instead of accountId when the numeric ID is not known

## When NOT to Use

- When the user wants to import new transactions (use csv_import)
- When the user wants to add accounts (use account_manage)

## Usage Notes

- Only links transactions where account_id is currently NULL
- Supports dry run to preview matches before committing
- Matches on account_last4, bank name, or account_name
- If accountId is wrong or unknown, pass lookupName with the account name for automatic lookup
`.trim();

const PLAID_BALANCES_DESCRIPTION = `
**Requires Pro license.** Show current account balances for all linked bank accounts. Also updates account records and balance snapshots for net worth tracking.

## When to Use

- When the user asks "what's my balance", "how much do I have", "account balances"
- When the user wants to see their current financial position across accounts
- When checking net worth or liquidity

## When NOT to Use

- When the user wants to see transactions (use plaid_sync or transaction_search)
- When no bank accounts are linked (direct user to /connect first)

## Usage Notes

- Requires linked Plaid accounts (set up via /connect)
- Shows current and available balances for each account
- Includes account type (checking, savings, credit, etc.)
- Automatically creates/updates accounts in the net worth tracker
- Records balance snapshots for trend tracking
- Pro users without local Plaid credentials use the OA API proxy automatically
- Always call this tool when the user asks — the tool handles license and credential checks internally
`.trim();

const PLAID_RECURRING_DESCRIPTION = `
**Requires Pro license.** Show recurring transactions (subscriptions, bills, income) for linked accounts.

## When to Use

- When the user asks about subscriptions, recurring charges, or bills
- When the user says "what subscriptions do I have", "show my recurring expenses"
- When analyzing fixed vs variable spending
- When looking for subscriptions to cancel

## When NOT to Use

- When the user wants one-time transaction analysis (use spending_summary or anomaly_detect)
- When no bank accounts are linked (direct user to /connect first)

## Usage Notes

- Uses Plaid's recurring transaction detection algorithm
- Shows both inflows (recurring income) and outflows (subscriptions/bills)
- Includes frequency, amount, merchant, and active/inactive status
- Pro users without local Plaid credentials use the OA API proxy automatically
- Always call this tool when the user asks — the tool handles license and credential checks internally
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
- Pro users without local Plaid credentials use the OA API proxy automatically
- Always call this tool when the user asks to sync — the tool handles license and credential checks internally
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

  if (process.env.MONARCH_TOKEN || (process.env.MONARCH_EMAIL && process.env.MONARCH_PASSWORD)) {
    const monarchMod = safeRequire<{ monarchImportTool: ToolDef }>('./import/monarch.js');
    if (monarchMod?.monarchImportTool) {
      tools.push({
        name: 'monarch_import',
        tool: monarchMod.monarchImportTool,
        description: MONARCH_IMPORT_DESCRIPTION,
      });
    }
  }

  if (process.env.FIREFLY_API_URL && process.env.FIREFLY_API_TOKEN) {
    const fireflyMod = safeRequire<{ fireflyImportTool: ToolDef }>('./import/firefly.js');
    if (fireflyMod?.fireflyImportTool) {
      tools.push({
        name: 'firefly_import',
        tool: fireflyMod.fireflyImportTool,
        description: FIREFLY_IMPORT_DESCRIPTION,
      });
    }
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

  const editTxnMod = safeRequire<{ editTransactionTool: ToolDef }>('./query/edit-transaction.js');
  if (editTxnMod?.editTransactionTool) {
    tools.push({ name: 'edit_transaction', tool: editTxnMod.editTransactionTool, description: EDIT_TRANSACTION_DESCRIPTION });
  }

  const deleteTxnMod = safeRequire<{ deleteTransactionTool: ToolDef }>('./query/delete-transaction.js');
  if (deleteTxnMod?.deleteTransactionTool) {
    tools.push({ name: 'delete_transaction', tool: deleteTxnMod.deleteTransactionTool, description: DELETE_TRANSACTION_DESCRIPTION });
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

  const plaidBalMod = safeRequire<{ plaidBalancesTool: ToolDef }>('./import/plaid-balances.js');
  if (plaidBalMod?.plaidBalancesTool) {
    tools.push({
      name: 'plaid_balances',
      tool: plaidBalMod.plaidBalancesTool,
      description: PLAID_BALANCES_DESCRIPTION,
    });
  }

  const plaidRecMod = safeRequire<{ plaidRecurringTool: ToolDef }>('./import/plaid-recurring.js');
  if (plaidRecMod?.plaidRecurringTool) {
    tools.push({
      name: 'plaid_recurring',
      tool: plaidRecMod.plaidRecurringTool,
      description: PLAID_RECURRING_DESCRIPTION,
    });
  }

  // P&L tools
  const pnlMod = safeRequire<{ profitLossTool: ToolDef }>('./query/profit-loss.js');
  if (pnlMod?.profitLossTool) {
    tools.push({ name: 'profit_loss', tool: pnlMod.profitLossTool, description: PROFIT_LOSS_DESCRIPTION });
  }

  const diffMod = safeRequire<{ profitDiffTool: ToolDef }>('./query/profit-diff.js');
  if (diffMod?.profitDiffTool) {
    tools.push({ name: 'profit_diff', tool: diffMod.profitDiffTool, description: PROFIT_DIFF_DESCRIPTION });
  }

  // Rules engine
  const ruleMod = safeRequire<{ ruleManageTool: ToolDef }>('./rules/rule-manage.js');
  if (ruleMod?.ruleManageTool) {
    tools.push({ name: 'rule_manage', tool: ruleMod.ruleManageTool, description: RULE_MANAGE_DESCRIPTION });
  }

  // Tax tracking
  const taxMod = safeRequire<{ taxFlagTool: ToolDef }>('./tax/tax-flag.js');
  if (taxMod?.taxFlagTool) {
    tools.push({ name: 'tax_flag', tool: taxMod.taxFlagTool, description: TAX_FLAG_DESCRIPTION });
  }

  // Savings rate
  const savingsMod = safeRequire<{ savingsRateTool: ToolDef }>('./query/savings-rate.js');
  if (savingsMod?.savingsRateTool) {
    tools.push({ name: 'savings_rate', tool: savingsMod.savingsRateTool, description: SAVINGS_RATE_DESCRIPTION });
  }

  // Alerts
  const alertMod = safeRequire<{ alertCheckTool: ToolDef }>('./query/alert-check.js');
  if (alertMod?.alertCheckTool) {
    tools.push({ name: 'alert_check', tool: alertMod.alertCheckTool, description: ALERT_CHECK_DESCRIPTION });
  }

  // Report generation
  const reportMod = safeRequire<{ generateReportTool: ToolDef }>('./export/generate-report.js');
  if (reportMod?.generateReportTool) {
    tools.push({ name: 'generate_report', tool: reportMod.generateReportTool, description: GENERATE_REPORT_DESCRIPTION });
  }

  // Net worth tools
  const acctMod = safeRequire<{ accountManageTool: ToolDef }>('./net-worth/account-manage.js');
  if (acctMod?.accountManageTool) {
    tools.push({ name: 'account_manage', tool: acctMod.accountManageTool, description: ACCOUNT_MANAGE_DESCRIPTION });
  }

  const balMod = safeRequire<{ balanceUpdateTool: ToolDef }>('./net-worth/balance-update.js');
  if (balMod?.balanceUpdateTool) {
    tools.push({ name: 'balance_update', tool: balMod.balanceUpdateTool, description: BALANCE_UPDATE_DESCRIPTION });
  }

  const nwMod = safeRequire<{ netWorthTool: ToolDef }>('./net-worth/net-worth.js');
  if (nwMod?.netWorthTool) {
    tools.push({ name: 'net_worth', tool: nwMod.netWorthTool, description: NET_WORTH_DESCRIPTION });
  }

  const mortMod = safeRequire<{ mortgageManageTool: ToolDef }>('./net-worth/mortgage-manage.js');
  if (mortMod?.mortgageManageTool) {
    tools.push({ name: 'mortgage_manage', tool: mortMod.mortgageManageTool, description: MORTGAGE_MANAGE_DESCRIPTION });
  }

  const linkMod = safeRequire<{ linkTransactionsTool: ToolDef }>('./net-worth/link-transactions.js');
  if (linkMod?.linkTransactionsTool) {
    tools.push({ name: 'link_transactions', tool: linkMod.linkTransactionsTool, description: LINK_TRANSACTIONS_DESCRIPTION });
  }

  // MCP tools (loaded at startup from ~/.openaccountant/mcp.json)
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
