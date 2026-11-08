import { z } from 'zod';
import type { Database } from '../../db/compat-sqlite.js';
import { defineTool } from '../define-tool.js';
import { getUncategorizedTransactions, updateCategory, matchRule, getCategories, resolveCategory, type TransactionRow, type CategoryRow } from '../../db/queries.js';
import { buildCategorizationPrompt, type CategorizationInput } from './prompt.js';
import { CATEGORIES } from './categories.js';
import { formatToolResult } from '../types.js';
import { callLlm } from '../../model/llm.js';
import { CALL_TYPE_CATEGORIZATION, getTaskModel } from '../../model/task-models.js';
import { getCategorizationConfidenceThreshold, getCategorizationConcurrency } from '../../utils/config.js';
import { addPendingCategorizationReview, deletePendingCategorizationReview } from '../../db/categorization-review-queries.js';
import { resolveProvider } from '../../providers.js';
import { isModelLocal } from '../../model/locality.js';
import { isConstrainedDecodingActive } from '../../model/providers/transformers.js';
import { numberLiteralUnion } from '../literal-union.js';

// Module-level database reference
let db: Database | null = null;

/**
 * Initialize the categorize tool with a database connection.
 * Must be called before the agent starts.
 */
/** Narrow only when decoding is really constrained: local provider and no EOS-mismatch fallback. */
function isNarrowingSafe(model: string): boolean {
  return resolveProvider(model).id === 'transformers' && isConstrainedDecodingActive(model);
}

export function initCategorizeTool(database: Database): void {
  db = database;
}

function getDb(): Database {
  if (!db) {
    throw new Error('categorize tool not initialized. Call initCategorizeTool(database) first.');
  }
  return db;
}

/**
 * The production categorizer's system prompt. Exported so the demo Speed
 * Showdown sends the exact same string (single source of truth — the exhibit
 * must match what Wilson's own categorizer sends).
 */
export const CATEGORIZER_SYSTEM_PROMPT =
  'You are a precise financial transaction categorizer. Respond only with valid JSON.';

/**
 * The category names the prompt offers: roots and their children for DB
 * categories (what buildCategoryListFromDb renders), else the hardcoded list.
 * 'Other' is always allowed: it is the backstop for anything unresolved.
 */
export function offeredCategoryNames(dbCategories: CategoryRow[] | undefined): string[] {
  const names = dbCategories
    ? dbCategories
        .filter((c) => c.parent_id === null || dbCategories.some((p) => p.id === c.parent_id && p.parent_id === null))
        .map((c) => c.name)
    : CATEGORIES;
  return [...new Set([...names, 'Other'])];
}

/**
 * Zod schema for LLM structured output, built per batch. With `narrow` (only
 * where decoding is constrained, i.e. local Transformers.js) category is limited
 * to the names offered and id to this batch's ids, so the model cannot name
 * anything else. Otherwise the schema stays loose: providers that do not enforce
 * it would fail the whole batch on one near-miss, and the 'Other' fallback and
 * batch-id guard below handle those rows instead. A fresh schema per call means
 * a cold token-mask cache; the WeakMap memo in toConstraintSchema lets the old
 * one be collected.
 */
export function buildCategorizationOutputSchema(batchIds: number[], categoryNames: string[], narrow: boolean) {
  return z.object({
    transactions: narrow
      ? z
          .array(
            z.object({
              id: numberLiteralUnion(batchIds),
              category: z.enum(categoryNames as [string, ...string[]]),
              confidence: z.number().min(0).max(1),
            })
          )
          // An empty array would pass as "success" while categorizing nothing.
          .min(1)
          .max(batchIds.length)
      : z
          .array(
            z.object({
              id: z.number(),
              category: z.string(),
              confidence: z.number().min(0).max(1),
            })
          ),
  });
}

const BATCH_SIZE = 50;
/**
 * Local Transformers.js models generate a few dozen tokens a second, so a
 * 50-row batch means a minute-plus per call; small batches keep each call
 * short and progress steady.
 */
const LOCAL_BATCH_SIZE = 10;
/** Output tokens per {"id","category","confidence"} row (~20–25), with headroom. */
const OUTPUT_TOKENS_PER_ROW = 40;
const OUTPUT_TOKENS_OVERHEAD = 64;
/**
 * Consecutive failed batches before giving up: the same model on the same
 * kind of prompt fails the same way, and each failure can cost a minute.
 */
const MAX_CONSECUTIVE_BATCH_FAILURES = 2;

/**
 * Categorize tool — uses LLM to categorize uncategorized transactions.
 * Processes in batches of 50 (several in flight at once on cloud providers),
 * updates the database, and returns a summary.
 */
export const categorizeTool = defineTool({
  name: 'categorize',
  mutates: true,
  description:
    'Categorize uncategorized transactions using AI. ' +
    'Assigns each transaction to a spending category with a confidence score. ' +
    'Suggestions below the confidence threshold are NOT applied — they are held in a persistent review queue for human review.',
  schema: z.object({
    limit: z
      .number()
      .optional()
      .describe('Max transactions to categorize (default: all uncategorized)'),
    entityId: z
      .number()
      .optional()
      .describe('Optional entity ID to assign to categorized transactions'),
    skipPendingReview: z
      .boolean()
      .optional()
      .describe('Skip transactions already waiting in the review queue (default: false)'),
  }),
  func: async ({ limit, entityId, skipPendingReview }, config) => {
    const database = getDb();
    const threshold = getCategorizationConfidenceThreshold();
    // A caller that can be cancelled (the dashboard's /categorize: its owner deactivated, or auth switched on
    // under an anonymous run) passes a signal; the run then stops before writing anything more. A caller whose
    // write rights can lapse mid-run (a dashboard chat whose owner was demoted, #165) passes mayWrite, asked again
    // at the same points: once it says no, the run stops the same way.
    const signal = config?.signal;
    let writeRevoked = false;
    const throwIfAborted = () => {
      if (!writeRevoked && config?.mayWrite && !config.mayWrite()) writeRevoked = true;
      if (signal?.aborted || writeRevoked) throw new DOMException('Categorization cancelled', 'AbortError');
    };
    throwIfAborted();

    // Load dynamic categories from DB (with fallback)
    let dbCategories: CategoryRow[] | undefined;
    try {
      dbCategories = getCategories(database);
      if (dbCategories.length === 0) dbCategories = undefined;
    } catch {
      dbCategories = undefined;
    }

    // 1. Get uncategorized transactions
    const uncategorized = getUncategorizedTransactions(database, limit, { excludePendingReview: skipPendingReview });

    if (uncategorized.length === 0) {
      const stillUncategorized = countUncategorized(database);
      const pendingReview = skipPendingReview ? countUncategorizedPendingReview(database) : 0;
      return formatToolResult({
        // Only held rows remain: "all categorized" would be false.
        message: pendingReview > 0
          ? `No new transactions to categorize — ${pendingReview} are waiting for your review in the Review tab.`
          : 'All transactions are already categorized.',
        categorized: 0,
        stillUncategorized,
        ...(skipPendingReview ? { pendingReview } : {}),
      });
    }

    let totalCategorized = 0;
    let totalRoutedForReview = 0;
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
          // Rule matches apply at confidence 1.0 — clear any stale pending
          // review row so the queue only lists transactions still in question.
          deletePendingCategorizationReview(database, txn.id);
        } else {
          needsLlm.push(txn);
        }
      } catch {
        // If rules table doesn't exist yet, fall through to LLM
        needsLlm.push(txn);
      }
    }

    // 2. Process remaining in batches via LLM, up to `concurrency` at a time.
    // A cloud provider answers several requests at once; local Ollama only
    // when the user opts in (see getCategorizationConcurrency); an in-process
    // model is one pipeline, so it always runs one batch at a time.
    const categorizationModel = getTaskModel('categorization');
    const inProcess = resolveProvider(categorizationModel).id === 'transformers';
    const batchSize = inProcess ? LOCAL_BATCH_SIZE : BATCH_SIZE;
    const batches = Math.ceil(needsLlm.length / batchSize);
    const concurrency = inProcess ? 1 : getCategorizationConcurrency(isModelLocal(categorizationModel));
    let batchesDone = 0;
    let llmRowsHandled = 0;
    const reportProgress = () =>
      config?.onProgress?.({ done: ruleMatchCount + llmRowsHandled, total: uncategorized.length, batch: batchesDone, batches });
    if (batches > 0) reportProgress();
    // Batches finish out of order: errors carry their batch number and are reported sorted.
    const batchErrors: { batch: number; message: string }[] = [];
    // Counted in completion order; once it trips, no new batch starts.
    let consecutiveFailures = 0;
    let nextStart = 0;

    const runBatch = async (start: number) => {
      const batchNo = start / batchSize + 1;
      const batch = needsLlm.slice(start, start + batchSize);
      const inputs: CategorizationInput[] = batch.map((t: TransactionRow) => ({
        id: t.id,
        description: t.description,
        amount: t.amount,
        date: t.date,
      }));

      const prompt = buildCategorizationPrompt(inputs, dbCategories);
      const batchIds = new Set(batch.map((t) => t.id));
      const outputSchema = buildCategorizationOutputSchema(
        [...batchIds],
        offeredCategoryNames(dbCategories),
        isNarrowingSafe(getTaskModel('categorization')),
      );

      try {
        // 3. Call LLM with structured output. Resolved per batch so a pinned
        // override (settings.json) lands on the very next run with no restart.
        const model = getTaskModel('categorization');
        const result = await callLlm(prompt, {
          systemPrompt: CATEGORIZER_SYSTEM_PROMPT,
          outputSchema,
          model,
          callType: CALL_TYPE_CATEGORIZATION,
          // Room for every row's JSON: the local adapter otherwise caps output
          // at 512 tokens, truncating a 50-row reply into invalid JSON.
          maxTokens: OUTPUT_TOKENS_OVERHEAD + OUTPUT_TOKENS_PER_ROW * batch.length,
          signal,
        });
        // Cancelled while the model was answering: its answer must not be applied.
        throwIfAborted();

        // callLlm validated the structured output against the per-batch schema
        // (with one repair re-prompt) or threw — result.response.structured is guaranteed
        // to satisfy the schema, so a rejected batch lands in the catch below and this
        // batch's transactions stay uncategorized.
        const categorizations = result.response.structured as { transactions: { id: number; category: string; confidence: number }[] };

        // 4. Update categories in database. bun:sqlite is synchronous, so a
        // batch's writes run start to finish without another batch interleaving.
        for (const cat of categorizations.transactions) {
          // Whatever the provider enforced, an id outside this batch is never written.
          if (!batchIds.has(cat.id)) {
            batchErrors.push({ batch: batchNo, message: `Batch ${batchNo}: ignored id ${cat.id} not in batch` });
            continue;
          }
          // Validate category: try DB lookup first, fall back to hardcoded list, then 'Other'
          let validCategory: string;
          if (dbCategories) {
            validCategory = resolveCategory(database, cat.category) ?? 'Other';
          } else {
            validCategory = CATEGORIES.includes(cat.category) ? cat.category : 'Other';
          }
          const confidence = Math.max(0, Math.min(1, cat.confidence));

          if (confidence >= threshold) {
            updateCategory(database, cat.id, validCategory, confidence);
            if (entityId !== undefined) {
              database.prepare('UPDATE transactions SET entity_id = @entityId WHERE id = @id').run({ entityId, id: cat.id });
            }
            totalCategorized++;
            categoryCounts[validCategory] = (categoryCounts[validCategory] ?? 0) + 1;
            // Now categorized — clear any stale pending review row.
            deletePendingCategorizationReview(database, cat.id);
          } else {
            // Guardrail: below-threshold suggestion is NEVER applied to the
            // transaction (category stays untouched) — route it to the
            // persistent review queue for a human decision. The partial
            // unique index makes re-runs idempotent (no duplicate rows).
            addPendingCategorizationReview(database, cat.id, validCategory, confidence);
            totalRoutedForReview++;
          }
        }
        consecutiveFailures = 0;
      } catch (err) {
        // A cancel is not a failed batch: stop the run (the caller reports it) instead of counting it.
        if (signal?.aborted || writeRevoked) throw err;
        consecutiveFailures++;
        batchErrors.push({
          batch: batchNo,
          message: `Batch ${batchNo}: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
      batchesDone++;
      llmRowsHandled += batch.length;
      reportProgress();
    };

    const worker = async () => {
      while (nextStart < needsLlm.length && consecutiveFailures < MAX_CONSECUTIVE_BATCH_FAILURES) {
        throwIfAborted();
        const start = nextStart;
        nextStart += batchSize;
        await runBatch(start);
      }
    };
    // allSettled, not all: on a cancel, wait for the batches already in flight
    // (each refuses to write once cancelled) so nothing lands after we return.
    const settled = await Promise.allSettled(Array.from({ length: Math.min(concurrency, batches) }, worker));
    const rejected = settled.find((s): s is PromiseRejectedResult => s.status === 'rejected');
    if (rejected) throw rejected.reason;
    const notAttempted = needsLlm.length - Math.min(nextStart, needsLlm.length);
    errors.push(...batchErrors.sort((a, b) => a.batch - b.batch).map((e) => e.message));

    return formatToolResult({
      success: true,
      totalUncategorized: uncategorized.length,
      categorized: totalCategorized,
      ruleMatched: ruleMatchCount,
      llmCategorized: totalCategorized - ruleMatchCount,
      categoriesApplied: categoryCounts,
      routedForReview: totalRoutedForReview,
      errors: errors.length > 0 ? errors : undefined,
      notAttempted: notAttempted > 0 ? notAttempted : undefined,
      stillUncategorized: countUncategorized(database),
      ...(skipPendingReview ? { pendingReview: countUncategorizedPendingReview(database) } : {}),
      message:
        `Categorized ${totalCategorized} of ${uncategorized.length} transactions` +
        (ruleMatchCount > 0 ? ` (${ruleMatchCount} by rules, ${totalCategorized - ruleMatchCount} by LLM)` : '') +
        `. ${totalRoutedForReview} routed for human review (below threshold ${threshold}).` +
        (errors.length > 0 ? ` ${errors.length} batch errors occurred.` : '') +
        (notAttempted > 0
          ? ` Stopped after ${MAX_CONSECUTIVE_BATCH_FAILURES} failed batches in a row; ${notAttempted} transactions were not attempted.`
          : ''),
    });
  },
});

/** Transactions with no category (those held in the review queue included). */
function countUncategorized(database: Database): number {
  return (database.prepare('SELECT COUNT(*) AS n FROM transactions WHERE category IS NULL').get() as { n: number }).n;
}

/** Uncategorized transactions that are waiting in the review queue. */
function countUncategorizedPendingReview(database: Database): number {
  return (database.prepare(
    `SELECT COUNT(*) AS n FROM transactions WHERE category IS NULL
     AND id IN (SELECT transaction_id FROM categorization_reviews WHERE status = 'pending')`
  ).get() as { n: number }).n;
}
