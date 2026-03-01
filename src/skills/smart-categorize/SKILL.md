---
name: smart-categorize
description: >
  Categorizes uncategorized transactions using AI, aligned with Plaid's
  Personal Finance Category (PFC) taxonomy. Processes in batches, allows
  user review, and learns from corrections. Trigger when user says
  "categorize", "classify transactions", "what are my uncategorized",
  or after import when uncategorized transactions exist.
---

# Smart Categorize

## Workflow

1. **Find uncategorized**: Use `transaction_search` to find uncategorized transactions
2. **Check count**: If none found, report that all transactions are categorized and exit
3. **Batch processing**: Process in batches of up to 50 transactions
4. **Categorize**: For each batch, call `categorize` tool with PFC-aligned category list
5. **Show results**: Display each transaction with its assigned category and confidence score
6. **User review**: Ask user to confirm, correct, or skip each batch
7. **Apply categories**: Apply confirmed categories via `update_category`, incorporating any user corrections
8. **Report summary**: X categorized, Y skipped, Z corrected by user
