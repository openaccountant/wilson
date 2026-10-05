import { z } from 'zod';
import type { Database } from '../../db/compat-sqlite.js';
import { defineTool } from '../define-tool.js';
import { mutatesUnlessDryRun } from '../mutation.js';
import { getEntities, getUnassignedTransactions, assignEntityToTransactions } from '../../db/entity-queries.js';
import { buildEntityClassificationPrompt, type ClassificationInput } from './entity-classify-prompt.js';
import { formatToolResult } from '../types.js';
import { callLlm } from '../../model/llm.js';
import { numberLiteralUnion } from '../literal-union.js';
import { resolveProvider } from '../../providers.js';
import { isConstrainedDecodingActive } from '../../model/providers/transformers.js';
import { CALL_TYPE_ENTITY_CLASSIFICATION, getTaskModel } from '../../model/task-models.js';

let db: Database | null = null;

/** Narrow only when decoding is really constrained: local provider and no EOS-mismatch fallback. */
function isNarrowingSafe(model: string): boolean {
  return resolveProvider(model).id === 'transformers' && isConstrainedDecodingActive(model);
}

export function initEntityClassifyTool(database: Database): void {
  db = database;
}

function getDb(): Database {
  if (!db) {
    throw new Error('entity_classify tool not initialized. Call initEntityClassifyTool(database) first.');
  }
  return db;
}

/**
 * Per-batch output schema. With `narrow` (only where decoding is constrained,
 * i.e. local Transformers.js) id is limited to this batch's ids and entityId to
 * the known entities, so the model cannot emit anything else. Otherwise it stays
 * loose so one unknown entityId routes that row to review instead of failing
 * the batch. (A fresh schema per call means a cold token-mask cache.)
 */
export function buildClassificationOutputSchema(batchIds: number[], entityIds: number[], narrow: boolean) {
  const rows = z.array(
    z.object({
      id: narrow ? numberLiteralUnion(batchIds) : z.number(),
      entityId: narrow ? numberLiteralUnion(entityIds) : z.number(),
      confidence: z.number().min(0).max(1),
      reasoning: z.string(),
    }),
  );
  // An empty array would pass as "success" while classifying nothing, but only
  // constrained decoding is prone to it; cloud schemas stay as they were.
  return z.object({ transactions: narrow ? rows.min(1) : rows });
}

const BATCH_SIZE = 50;
/** Local Transformers.js models are slow and cap output at 512 tokens, so batch small. */
const LOCAL_BATCH_SIZE = 10;
/** Output tokens per {"id","entityId","confidence","reasoning"} row (~40–50 with a short reason), with headroom. */
const OUTPUT_TOKENS_PER_ROW = 80;
const OUTPUT_TOKENS_OVERHEAD = 64;

export const entityClassifyTool = defineTool({
  name: 'entity_classify',
  mutates: mutatesUnlessDryRun,
  description:
    'Classify unassigned transactions into business entities using AI. ' +
    'Assigns each transaction to an entity with confidence scores and reasoning.',
  schema: z.object({
    limit: z
      .number()
      .optional()
      .describe('Max transactions to classify (default: all unassigned)'),
    dryRun: z
      .boolean()
      .optional()
      .describe('Preview classifications without committing (default: false)'),
    confidenceThreshold: z
      .number()
      .optional()
      .describe('Minimum confidence to auto-assign (default: 0.7)'),
  }),
  func: async ({ limit, dryRun, confidenceThreshold }) => {
    const database = getDb();
    const threshold = confidenceThreshold ?? 0.7;
    const isDryRun = dryRun ?? false;

    // 1. Validate at least 2 entities exist
    const entities = getEntities(database);
    if (entities.length < 2) {
      return formatToolResult({
        error: 'At least 2 entities are required for classification. Add more entities with entity_manage.',
        entityCount: entities.length,
      });
    }

    // 2. Fetch unassigned transactions
    const unassigned = getUnassignedTransactions(database, limit);
    if (unassigned.length === 0) {
      return formatToolResult({
        message: 'All transactions are already assigned to an entity.',
        classified: 0,
      });
    }

    let totalClassified = 0;
    const entityCounts: Record<string, number> = {};
    const reviewItems: Array<{ id: number; description: string; amount: number; entityName: string; confidence: number; reasoning: string }> = [];
    const errors: string[] = [];

    // Build entity ID → name lookup
    const entityMap = new Map(entities.map((e) => [e.id, e.name]));

    // 3. Process in batches (smaller for local models, as categorize does)
    const batchSize = resolveProvider(getTaskModel('entity-classification')).id === 'transformers' ? LOCAL_BATCH_SIZE : BATCH_SIZE;
    for (let i = 0; i < unassigned.length; i += batchSize) {
      const batch = unassigned.slice(i, i + batchSize);
      const inputs: ClassificationInput[] = batch.map((t) => ({
        id: t.id,
        description: t.description,
        amount: t.amount,
        date: t.date,
        category: t.category,
      }));

      const prompt = buildEntityClassificationPrompt(inputs, entities);
      const batchIds = new Set(batch.map((t) => t.id));
      const outputSchema = buildClassificationOutputSchema(
        [...batchIds],
        entities.map((e) => e.id),
        isNarrowingSafe(getTaskModel('entity-classification')),
      );

      try {
        // Resolved per batch so a pinned override (settings.json) lands on the
        // very next run with no restart.
        const model = getTaskModel('entity-classification');
        const result = await callLlm(prompt, {
          systemPrompt: 'You are a precise financial entity classifier. Respond only with valid JSON.',
          outputSchema,
          model,
          callType: CALL_TYPE_ENTITY_CLASSIFICATION,
          // Room for every row's JSON: the local adapter otherwise caps output
          // at 512 tokens, truncating a full batch into invalid JSON.
          maxTokens: OUTPUT_TOKENS_OVERHEAD + OUTPUT_TOKENS_PER_ROW * batch.length,
        });

        // callLlm validated the structured output against the per-batch schema
        // (with one repair re-prompt) or threw — result.response.structured is guaranteed
        // to satisfy the schema, so a rejected batch lands in the catch below and nothing
        // is assigned for this batch.
        const classifications = result.response.structured as z.infer<ReturnType<typeof buildClassificationOutputSchema>>;

        // 4. Process results
        const highConfIds: Map<number, number[]> = new Map(); // entityId → txnIds

        for (const cls of classifications.transactions) {
          // Whatever the provider enforced, an id outside this batch is never assigned.
          if (!batchIds.has(cls.id)) {
            errors.push(`Batch ${Math.floor(i / batchSize) + 1}: ignored id ${cls.id} not in batch`);
            continue;
          }
          const confidence = Math.max(0, Math.min(1, cls.confidence));
          const entityName = entityMap.get(cls.entityId) ?? `Unknown (#${cls.entityId})`;

          // Validate entity ID exists
          if (!entityMap.has(cls.entityId)) {
            reviewItems.push({
              id: cls.id,
              description: batch.find((t) => t.id === cls.id)?.description ?? '',
              amount: batch.find((t) => t.id === cls.id)?.amount ?? 0,
              entityName,
              confidence,
              reasoning: cls.reasoning,
            });
            continue;
          }

          if (confidence >= threshold && !isDryRun) {
            // Group by entity for bulk assignment
            const ids = highConfIds.get(cls.entityId) ?? [];
            ids.push(cls.id);
            highConfIds.set(cls.entityId, ids);
            totalClassified++;
            entityCounts[entityName] = (entityCounts[entityName] ?? 0) + 1;
          } else {
            // Add to review (low confidence or dry run)
            reviewItems.push({
              id: cls.id,
              description: batch.find((t) => t.id === cls.id)?.description ?? '',
              amount: batch.find((t) => t.id === cls.id)?.amount ?? 0,
              entityName,
              confidence,
              reasoning: cls.reasoning,
            });
            if (isDryRun && confidence >= threshold) {
              entityCounts[entityName] = (entityCounts[entityName] ?? 0) + 1;
            }
          }
        }

        // Bulk assign high-confidence results
        for (const [entityId, txnIds] of highConfIds) {
          assignEntityToTransactions(database, entityId, txnIds);
        }
      } catch (err) {
        errors.push(
          `Batch ${Math.floor(i / batchSize) + 1}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    return formatToolResult({
      success: true,
      dryRun: isDryRun,
      totalUnassigned: unassigned.length,
      classified: isDryRun ? 0 : totalClassified,
      wouldClassify: isDryRun ? Object.values(entityCounts).reduce((a, b) => a + b, 0) : undefined,
      entityBreakdown: entityCounts,
      reviewItems: reviewItems.length > 0 ? reviewItems : undefined,
      errors: errors.length > 0 ? errors : undefined,
      message: isDryRun
        ? `Dry run: ${reviewItems.length} transactions analyzed across ${entities.length} entities. ` +
          `${Object.values(entityCounts).reduce((a, b) => a + b, 0)} would be auto-assigned (confidence >= ${threshold}). ` +
          `${reviewItems.filter((r) => r.confidence < threshold).length} need manual review.`
        : `Classified ${totalClassified} of ${unassigned.length} transactions. ` +
          `${reviewItems.length} need review (confidence < ${threshold}).` +
          (errors.length > 0 ? ` ${errors.length} batch errors occurred.` : ''),
    });
  },
});
