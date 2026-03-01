---
name: import-transactions
description: >
  Imports transactions from bank files (CSV, OFX, QIF). Detects the file
  format and bank automatically, parses transactions, deduplicates against
  existing data, and inserts new records. Trigger when user says "import",
  "load transactions", "add bank file", provides a file path, or mentions
  CSV/OFX/QIF.
---

# Import Transactions

## Workflow

1. **Get file path**: Ask user for file path (or accept from context if already provided)
2. **Detect file format**: Determine format (CSV vs OFX vs QIF) by extension and content sniffing
3. **Parse by format**:
   - For CSV: detect bank (Chase, Amex, BofA, generic) by header patterns and parse accordingly
   - For OFX: parse with OFX parser
   - For QIF: parse with QIF parser
4. **Preview**: Show count of transactions, date range, and sample entries for user confirmation
5. **Deduplicate**: Check for duplicates via `external_id` (or file hash for backward compatibility)
6. **Insert**: Insert new transactions into the database, report count imported vs skipped
7. **Suggest categorization**: If uncategorized transactions exist after import, suggest running the `smart-categorize` skill
