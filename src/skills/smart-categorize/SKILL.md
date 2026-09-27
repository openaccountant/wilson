---
name: smart-categorize
description: >
  Categorizes uncategorized transactions using AI, aligned with Plaid's
  Personal Finance Category (PFC) taxonomy. Process in batches; low-confidence
  suggestions are routed to a review queue the user resolves in the dashboard
  Review tab. Trigger when user says
  "categorize", "classify transactions", "what are my uncategorized",
  or after import when uncategorized transactions exist.
---

# Smart Categorize

## Workflow

1. **Find uncategorized**: Use `transaction_search` to find uncategorized transactions
2. **Check count**: If none found, report that all transactions are categorized and exit
3. **Batch processing**: Process in batches of up to 50 transactions
4. **Categorize**: For each batch, call `categorize` tool with PFC-aligned category list
5. **Report the split**: X applied automatically (confidence ≥ threshold), Y routed to the review queue (below threshold — never applied to the transaction)
6. **Review queue is human-only**: pending suggestions appear in the dashboard's Review tab with the transaction's date, amount, description, the suggested category, and the confidence score
7. **Human decision**: Confirm applies the suggested category; Correct applies a category the user picks — either action also marks the transaction user-verified and resolves the queue entry. Do not attempt to apply queued suggestions from the agent side
8. **Report summary**: X categorized, Y awaiting review in the Review tab
