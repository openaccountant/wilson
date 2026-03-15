import type { EntityRow } from '../../db/entity-queries.js';

export interface ClassificationInput {
  id: number;
  description: string;
  amount: number;
  date: string;
  category: string | null;
}

/**
 * Build a prompt for batch entity classification.
 *
 * Takes transactions and available entities, returns a prompt instructing the
 * LLM to assign each transaction to exactly one entity by numeric ID.
 */
export function buildEntityClassificationPrompt(
  transactions: ClassificationInput[],
  entities: EntityRow[],
): string {
  const entityList = entities
    .map((e) => `  - ID ${e.id}: ${e.name}${e.description ? ` — ${e.description}` : ''}`)
    .join('\n');

  const transactionList = transactions
    .map(
      (t) =>
        `  { "id": ${t.id}, "description": "${escapeQuotes(t.description)}", "amount": ${t.amount}, "date": "${t.date}", "category": ${t.category ? `"${escapeQuotes(t.category)}"` : 'null'} }`,
    )
    .join(',\n');

  return `You are a financial entity classifier. Assign each transaction to exactly one of these entities by numeric ID:

${entityList}

RULES:
1. Classify each transaction to exactly one entity by its numeric ID.
2. Use description, amount, category, and date as signals.
3. Business signals: software/SaaS, office supplies, professional services, business travel, advertising, domain/hosting, cloud services, coworking, business insurance.
4. Personal signals: groceries, personal dining, entertainment, streaming (Netflix/Spotify), personal health, gym, personal clothing, personal travel.
5. **When in doubt, lean personal** — incorrect business tagging has tax consequences.
6. Provide a confidence score between 0.0 and 1.0:
   - 0.9-1.0: Very confident (e.g., "AWS" → business, "NETFLIX" → personal)
   - 0.7-0.89: Confident (clear signals but some ambiguity)
   - 0.5-0.69: Uncertain (could go either way)
   - Below 0.5: Low confidence (very unclear)
7. Provide a one-sentence reasoning for each classification.

Classify these transactions:
[
${transactionList}
]

Respond with a JSON object in exactly this format:
{
  "transactions": [
    { "id": <transaction_id>, "entityId": <entity_id>, "confidence": <0.0-1.0>, "reasoning": "<one sentence>" }
  ]
}`;
}

function escapeQuotes(str: string): string {
  return str.replace(/"/g, '\\"');
}
