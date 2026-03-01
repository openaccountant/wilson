import { buildToolDescriptions } from '../tools/registry.js';
import { buildSkillMetadataSection, discoverSkills } from '../skills/index.js';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Database } from '../db/compat-sqlite.js';
import { getBudgetVsActual } from '../db/queries.js';
import { checkAlerts } from '../alerts/engine.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Returns the current date formatted for prompts.
 */
export function getCurrentDate(): string {
  const options: Intl.DateTimeFormatOptions = {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  };
  return new Date().toLocaleDateString('en-US', options);
}

/**
 * Load SOUL.md content from user override or bundled file.
 */
export async function loadSoulDocument(): Promise<string | null> {
  const userSoulPath = join(homedir(), '.openaccountant', 'SOUL.md');
  try {
    return await readFile(userSoulPath, 'utf-8');
  } catch {
    // Continue to bundled fallback when user override is missing/unreadable.
  }

  const bundledSoulPath = join(__dirname, '../../SOUL.md');
  try {
    return await readFile(bundledSoulPath, 'utf-8');
  } catch {
    // SOUL.md is optional; keep prompt behavior unchanged when absent.
  }

  return null;
}

/**
 * Build the skills section for the system prompt.
 * Only includes skill metadata if skills are available.
 */
function buildSkillsSection(): string {
  const skills = discoverSkills();

  if (skills.length === 0) {
    return '';
  }

  const skillList = buildSkillMetadataSection();

  return `## Available Skills

${skillList}

## Skill Usage Policy

- Check if available skills can help complete the task more effectively
- When a skill is relevant, invoke it IMMEDIATELY as your first action
- Skills provide specialized workflows for complex tasks (e.g., subscription audit, tax prep)
- Do not invoke a skill that has already been invoked for the current query`;
}

// ============================================================================
// Default System Prompt (for backward compatibility)
// ============================================================================

/**
 * Default system prompt used when no specific prompt is provided.
 */
export const DEFAULT_SYSTEM_PROMPT = `You are Open Accountant, a privacy-first AI bookkeeper.

Current date: ${getCurrentDate()}

Your output is displayed on a command line interface. Keep responses short and concise.

## Behavior

- Prioritize accuracy over validation
- Use professional, objective tone
- Be thorough but efficient

## Response Format

- Keep responses brief and direct
- For non-comparative information, prefer plain text or simple lists over tables
- Do not use markdown headers or *italics* - use **bold** sparingly for emphasis

## Tables (for comparative/tabular data)

Use markdown tables. They will be rendered as formatted box tables.

STRICT FORMAT - each row must:
- Start with | and end with |
- Have no trailing spaces after the final |
- Use |---| separator (with optional : for alignment)

| Category   | Amount  | % Total |
|------------|---------|---------|
| Groceries  | $842.50 | 22%     |

Keep tables compact:
- Max 2-3 columns; prefer multiple small tables over one wide table
- Headers: 1-3 words max. "Mo. Spend" not "Total monthly spending amount"
- Abbreviate: Mo., Yr., Avg., Tot., Cat.
- Numbers compact: $1.2K not $1,200.00
- Omit units in cells if header has them`;

// ============================================================================
// System Prompt
// ============================================================================

/**
 * Build the system prompt for the agent.
 * @param model - The model name (used to get appropriate tool descriptions)
 */
export async function buildSystemPrompt(model: string, soulContent?: string | null): Promise<string> {
  const toolDescriptions = await buildToolDescriptions(model);

  return `You are Open Accountant, a CLI assistant for personal finance bookkeeping.

Current date: ${getCurrentDate()}

Your output is displayed on a command line interface. Keep responses short and concise.

## Available Tools

${toolDescriptions}

## Tool Usage Policy

- Only use tools when the query actually requires data retrieval or computation
- Use csv_import to import transaction data from CSV files
- Use categorize to categorize transactions — call ONCE with the full set, it handles batch categorization internally
- Do NOT break up categorization into multiple tool calls when one call can handle the request
- Use transaction_search to find specific transactions matching user queries
- Use spending_summary to generate spending reports, breakdowns by category/merchant/time period
- Use anomaly_detect to find unusual charges, duplicate transactions, or subscription issues
- For general web queries or non-financial topics, use web_search
- Only respond directly for: conceptual definitions, general financial advice, or conversational queries

${buildSkillsSection()}

## Behavior

- Prioritize accuracy over validation - don't cheerfully agree with flawed assumptions
- Use professional, objective tone without excessive praise or emotional validation
- For analysis tasks, be thorough but efficient
- Avoid over-engineering responses - match the scope of your answer to the question
- Never ask users to provide raw data, paste values, or reference JSON/API internals - users ask questions, they don't have access to financial APIs
- If data is incomplete, answer with what you have without exposing implementation details

${soulContent ? `## Identity

${soulContent}

Embody the identity and financial philosophy described above. Let it shape your tone, your values, and how you engage with personal finance questions.
` : ''}

## Response Format

- Keep casual responses brief and direct
- For analysis: lead with the key finding and include specific data points
- For non-comparative information, prefer plain text or simple lists over tables
- Don't narrate your actions or ask leading questions about what the user wants
- Do not use markdown headers or *italics* - use **bold** sparingly for emphasis

## Tables (for comparative/tabular data)

Use markdown tables. They will be rendered as formatted box tables.

STRICT FORMAT - each row must:
- Start with | and end with |
- Have no trailing spaces after the final |
- Use |---| separator (with optional : for alignment)

| Category   | Amount  | % Total |
|------------|---------|---------|
| Groceries  | $842.50 | 22%     |

Keep tables compact:
- Max 2-3 columns; prefer multiple small tables over one wide table
- Headers: 1-3 words max. "Mo. Spend" not "Total monthly spending amount"
- Abbreviate: Mo., Yr., Avg., Tot., Cat.
- Numbers compact: $1.2K not $1,200.00
- Omit units in cells if header has them`;
}

// ============================================================================
// User Prompts
// ============================================================================

/**
 * Build user prompt for agent iteration with full tool results.
 * Anthropic-style: full results in context for accurate decision-making.
 * Context clearing happens at threshold, not inline summarization.
 *
 * @param originalQuery - The user's original query
 * @param fullToolResults - Formatted full tool results (or placeholder for cleared)
 * @param toolUsageStatus - Optional tool usage status for graceful exit mechanism
 */
export function buildIterationPrompt(
  originalQuery: string,
  fullToolResults: string,
  toolUsageStatus?: string | null
): string {
  let prompt = `Query: ${originalQuery}`;

  if (fullToolResults.trim()) {
    prompt += `

Data retrieved from tool calls:
${fullToolResults}`;
  }

  // Add tool usage status if available (graceful exit mechanism)
  if (toolUsageStatus) {
    prompt += `\n\n${toolUsageStatus}`;
  }

  prompt += `

Continue working toward answering the query. When you have gathered sufficient data to answer, write your complete answer directly and do not call more tools.`;

  return prompt;
}

// ============================================================================
// Budget Context
// ============================================================================

let budgetDb: Database | null = null;

/**
 * Inject the database reference for budget context generation.
 */
export function initBudgetPrompt(db: Database): void {
  budgetDb = db;
}

// ============================================================================
// Alert Context
// ============================================================================

let alertDb: Database | null = null;

/**
 * Inject the database reference for alert context generation.
 */
export function initAlertPrompt(db: Database): void {
  alertDb = db;
}

/**
 * Build an alert summary for system prompt injection.
 * Returns null if no active alerts.
 */
export function buildAlertContext(): string | null {
  if (!alertDb) return null;

  try {
    const alerts = checkAlerts(alertDb);
    if (alerts.length === 0) return null;

    const lines = alerts.map((a) => {
      const icon = a.severity === 'critical' ? '🔴' : a.severity === 'warning' ? '🟡' : 'ℹ️';
      return `- ${icon} ${a.message}`;
    });

    return `## Active Alerts\n\n${lines.join('\n')}\n\nProactively mention relevant alerts when they relate to the user's query.`;
  } catch {
    return null;
  }
}

/**
 * Build a budget summary for system prompt injection.
 * Returns null if no budgets are configured.
 */
export function buildBudgetContext(): string | null {
  if (!budgetDb) return null;

  try {
    const currentMonth = new Date().toISOString().slice(0, 7);
    const results = getBudgetVsActual(budgetDb, currentMonth);
    if (results.length === 0) return null;

    const lines = results.map((r) => {
      if (r.over) {
        return `${r.category} $${r.monthly_limit} (${r.percent_used}% — OVER by $${Math.abs(r.remaining).toFixed(0)})`;
      }
      return `${r.category} $${r.monthly_limit} (${r.percent_used}% used, $${r.remaining.toFixed(0)} remaining)`;
    });

    return `## Current Budgets\n\n${lines.join(', ')}\n\nProactively warn the user if they are near or over budget in any category.`;
  } catch {
    return null;
  }
}
