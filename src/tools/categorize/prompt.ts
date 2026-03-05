import { CATEGORIES, CATEGORY_DESCRIPTIONS } from './categories.js';
import type { CategoryRow } from '../../db/queries.js';

export interface CategorizationInput {
  id: number;
  description: string;
  amount: number;
  date: string;
}

/**
 * Build a hierarchical category list from DB categories for the LLM prompt.
 */
function buildCategoryListFromDb(dbCategories: CategoryRow[]): string {
  const roots = dbCategories.filter(c => c.parent_id === null);
  const childrenMap = new Map<number, CategoryRow[]>();
  for (const c of dbCategories) {
    if (c.parent_id !== null) {
      const siblings = childrenMap.get(c.parent_id) ?? [];
      siblings.push(c);
      childrenMap.set(c.parent_id, siblings);
    }
  }

  const lines: string[] = [];
  for (const root of roots) {
    lines.push(`  - ${root.name}: ${root.description ?? ''}`);
    const children = childrenMap.get(root.id);
    if (children) {
      for (const child of children) {
        lines.push(`    - ${child.name}: ${child.description ?? ''}`);
      }
    }
  }
  return lines.join('\n');
}

/**
 * Build a prompt for batch transaction categorization.
 *
 * The prompt instructs the LLM to categorize each transaction into one of our
 * standard categories, returning structured JSON with confidence scores.
 *
 * When dbCategories is provided, renders the hierarchical list from the DB.
 * Otherwise falls back to the hardcoded CATEGORIES list.
 */
export function buildCategorizationPrompt(transactions: CategorizationInput[], dbCategories?: CategoryRow[]): string {
  const categoryList = dbCategories && dbCategories.length > 0
    ? buildCategoryListFromDb(dbCategories)
    : CATEGORIES.map(
        (cat) => `  - ${cat}: ${CATEGORY_DESCRIPTIONS[cat] ?? ''}`
      ).join('\n');

  const transactionList = transactions
    .map(
      (t) =>
        `  { "id": ${t.id}, "description": "${escapeQuotes(t.description)}", "amount": ${t.amount}, "date": "${t.date}" }`
    )
    .join(',\n');

  return `You are a financial transaction categorizer. Categorize each transaction into exactly one of the following categories:

${categoryList}

RULES:
1. Choose the single best-fitting category for each transaction.
2. Use the description and amount to determine the category.
3. Negative amounts are expenses; positive amounts are income/credits.
4. Provide a confidence score between 0.0 and 1.0 for each categorization.
   - 0.9-1.0: Very confident (e.g., "NETFLIX" -> Subscriptions)
   - 0.7-0.89: Confident (e.g., "AMZN" -> Shopping, could be groceries)
   - 0.5-0.69: Uncertain (ambiguous description)
   - Below 0.5: Low confidence (very unclear)
5. For transfers between accounts (Venmo, Zelle, PayPal), use "Transfer".
6. For refunds or credits, match the category of the original purchase if possible, otherwise use "Income".

Categorize these transactions:
[
${transactionList}
]

Respond with a JSON object in exactly this format:
{
  "transactions": [
    { "id": <transaction_id>, "category": "<category_name>", "confidence": <0.0-1.0> }
  ]
}`;
}

function escapeQuotes(str: string): string {
  return str.replace(/"/g, '\\"');
}
