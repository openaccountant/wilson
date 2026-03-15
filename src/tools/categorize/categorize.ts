import { z } from 'zod';
import type { Database } from '../../db/compat-sqlite.js';
import { defineTool } from '../define-tool.js';
import { getUncategorizedTransactions, updateCategory, matchRule, getCategories, resolveCategory, type TransactionRow, type CategoryRow } from '../../db/queries.js';
import { buildCategorizationPrompt, type CategorizationInput } from './prompt.js';
import { CATEGORIES } from './categories.js';
import { formatToolResult } from '../types.js';
import { callLlm } from '../../model/llm.js';
import { getConfiguredModel } from '../../utils/config.js';

// Module-level database reference
let db: Database | null = null;

/**
 * Initialize the categorize tool with a database connection.
 * Must be called before the agent starts.
 */
export function initCategorizeTool(database: Database): void {
  db = database;
}

function getDb(): Database {
  if (!db) {
    throw new Error('categorize tool not initialized. Call initCategorizeTool(database) first.');
  }
  return db;
}

/** Zod schema for LLM structured output */
const categorizationOutputSchema = z.object({
  transactions: z.array(
    z.object({
      id: z.number(),
      category: z.string(),
      confidence: z.number(),
    })
  ),
});

const BATCH_SIZE = 50;

/**
 * Categorize tool — uses LLM to categorize uncategorized transactions.
 * Processes in batches of 50, updates the database, and returns a summary.
 */
export const categorizeTool = defineTool({
  name: 'categorize',
  description:
    'Categorize uncategorized transactions using AI. ' +
    'Assigns each transaction to a spending category with a confidence score.',
  schema: z.object({
    limit: z
      .number()
      .optional()
      .describe('Max transactions to categorize (default: all uncategorized)'),
    entityId: z
      .number()
      .optional()
      .describe('Optional entity ID to assign to categorized transactions'),
  }),
  func: async ({ limit, entityId }) => {
    const database = getDb();

    // Load dynamic categories from DB (with fallback)
    let dbCategories: CategoryRow[] | undefined;
    try {
      dbCategories = getCategories(database);
      if (dbCategories.length === 0) dbCategories = undefined;
    } catch {
      dbCategories = undefined;
    }

    // 1. Get uncategorized transactions
    const uncategorized = getUncategorizedTransactions(database, limit);

    if (uncategorized.length === 0) {
      return formatToolResult({
        message: 'All transactions are already categorized.',
        categorized: 0,
      });
    }

    let totalCategorized = 0;
    let totalNeedingReview = 0;
    let ruleMatchCount = 0;
    const categoryCounts: Record<string, number> = {};
    const errors: string[] = [];

    // 1b. Pre-categorize using rules engine
    const needsLlm: TransactionRow[] = [];
    for (const txn of uncategorized) {
      try {
        const match = matchRule(database, txn.description);
        if (match) {
          updateCategory(database, txn.id, match.category, 1.0);
          if (entityId !== undefined) {
            database.prepare('UPDATE transactions SET entity_id = @entityId WHERE id = @id').run({ entityId, id: txn.id });
          }
          totalCategorized++;
          ruleMatchCount++;
          categoryCounts[match.category] = (categoryCounts[match.category] ?? 0) + 1;
        } else {
          needsLlm.push(txn);
        }
      } catch {
        // If rules table doesn't exist yet, fall through to LLM
        needsLlm.push(txn);
      }
    }

    // 2. Process remaining in batches via LLM
    for (let i = 0; i < needsLlm.length; i += BATCH_SIZE) {
      const batch = needsLlm.slice(i, i + BATCH_SIZE);
      const inputs: CategorizationInput[] = batch.map((t: TransactionRow) => ({
        id: t.id,
        description: t.description,
        amount: t.amount,
        date: t.date,
      }));

      const prompt = buildCategorizationPrompt(inputs, dbCategories);

      try {
        // 3. Call LLM with structured output
        const { model } = getConfiguredModel();
        const result = await callLlm(prompt, {
          systemPrompt: 'You are a precise financial transaction categorizer. Respond only with valid JSON.',
          outputSchema: categorizationOutputSchema,
          model,
        });

        // Parse the result — with structured output, response.structured is the parsed object
        let categorizations: z.infer<typeof categorizationOutputSchema>;

        if (result.response.structured && typeof result.response.structured === 'object' && 'transactions' in result.response.structured) {
          categorizations = result.response.structured as z.infer<typeof categorizationOutputSchema>;
        } else if (result.response.content) {
          categorizations = categorizationOutputSchema.parse(JSON.parse(result.response.content));
        } else {
          errors.push(`Batch ${Math.floor(i / BATCH_SIZE) + 1}: Unexpected LLM response format`);
          continue;
        }

        // 4. Update categories in database
        for (const cat of categorizations.transactions) {
          // Validate category: try DB lookup first, fall back to hardcoded list, then 'Other'
          let validCategory: string;
          if (dbCategories) {
            validCategory = resolveCategory(database, cat.category) ?? 'Other';
          } else {
            validCategory = CATEGORIES.includes(cat.category) ? cat.category : 'Other';
          }
          const confidence = Math.max(0, Math.min(1, cat.confidence));

          updateCategory(database, cat.id, validCategory, confidence);
          if (entityId !== undefined) {
            database.prepare('UPDATE transactions SET entity_id = @entityId WHERE id = @id').run({ entityId, id: cat.id });
          }
          totalCategorized++;

          categoryCounts[validCategory] = (categoryCounts[validCategory] ?? 0) + 1;

          if (confidence < 0.7) {
            totalNeedingReview++;
          }
        }
      } catch (err) {
        errors.push(
          `Batch ${Math.floor(i / BATCH_SIZE) + 1}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    return formatToolResult({
      success: true,
      totalUncategorized: uncategorized.length,
      categorized: totalCategorized,
      ruleMatched: ruleMatchCount,
      llmCategorized: totalCategorized - ruleMatchCount,
      categoriesApplied: categoryCounts,
      needingReview: totalNeedingReview,
      errors: errors.length > 0 ? errors : undefined,
      message:
        `Categorized ${totalCategorized} of ${uncategorized.length} transactions` +
        (ruleMatchCount > 0 ? ` (${ruleMatchCount} by rules, ${totalCategorized - ruleMatchCount} by LLM)` : '') +
        `. ${totalNeedingReview} need review (confidence < 0.7).` +
        (errors.length > 0 ? ` ${errors.length} batch errors occurred.` : ''),
    });
  },
});
