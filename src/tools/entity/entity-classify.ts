import { z } from 'zod';
import type { Database } from '../../db/compat-sqlite.js';
import { defineTool } from '../define-tool.js';
import { getEntities, getUnassignedTransactions, assignEntityToTransactions } from '../../db/entity-queries.js';
import { buildEntityClassificationPrompt, type ClassificationInput } from './entity-classify-prompt.js';
import { formatToolResult } from '../types.js';
import { callLlm } from '../../model/llm.js';
import { getConfiguredModel } from '../../utils/config.js';

let db: Database | null = null;

export function initEntityClassifyTool(database: Database): void {
  db = database;
}

function getDb(): Database {
  if (!db) {
    throw new Error('entity_classify tool not initialized. Call initEntityClassifyTool(database) first.');
  }
  return db;
}

const classificationOutputSchema = z.object({
  transactions: z.array(
    z.object({
      id: z.number(),
      entityId: z.number(),
      confidence: z.number(),
      reasoning: z.string(),
    }),
  ),
});

const BATCH_SIZE = 50;

export const entityClassifyTool = defineTool({
  name: 'entity_classify',
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

    // 3. Process in batches
    for (let i = 0; i < unassigned.length; i += BATCH_SIZE) {
      const batch = unassigned.slice(i, i + BATCH_SIZE);
      const inputs: ClassificationInput[] = batch.map((t) => ({
        id: t.id,
        description: t.description,
        amount: t.amount,
        date: t.date,
        category: t.category,
      }));

      const prompt = buildEntityClassificationPrompt(inputs, entities);

      try {
        const { model } = getConfiguredModel();
        const result = await callLlm(prompt, {
          systemPrompt: 'You are a precise financial entity classifier. Respond only with valid JSON.',
          outputSchema: classificationOutputSchema,
          model,
        });

        let classifications: z.infer<typeof classificationOutputSchema>;

        if (result.response.structured && typeof result.response.structured === 'object' && 'transactions' in result.response.structured) {
          classifications = result.response.structured as z.infer<typeof classificationOutputSchema>;
        } else if (result.response.content) {
          classifications = classificationOutputSchema.parse(JSON.parse(result.response.content));
        } else {
          errors.push(`Batch ${Math.floor(i / BATCH_SIZE) + 1}: Unexpected LLM response format`);
          continue;
        }

        // 4. Process results
        const highConfIds: Map<number, number[]> = new Map(); // entityId → txnIds

        for (const cls of classifications.transactions) {
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
          `Batch ${Math.floor(i / BATCH_SIZE) + 1}: ${err instanceof Error ? err.message : String(err)}`,
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
