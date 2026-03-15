---
name: multi-entity
tier: paid
description: >
  Tracks finances across multiple business entities with AI-powered classification
  and per-entity reporting. Trigger when user asks about multi-entity, multiple
  businesses, separating personal and business expenses, or consolidated financials.
---

# Multi-Entity Classification

## Workflow

1. **List entities**: Call `entity_manage` with `action: "list"` to show existing entities. If only one exists, prompt the user to add at least one more (e.g., "Side Hustle", "LLC", "Rental Property") before proceeding.

2. **Check unassigned**: Use `entity_classify` with `dryRun: true` and `limit: 5` to confirm unassigned transactions exist. Report how many transactions lack an entity assignment.

3. **Dry run**: Call `entity_classify` with `dryRun: true` (no limit) to preview the full classification. Present:
   - Per-entity transaction count and spending totals
   - A sample of high-confidence classifications with reasoning
   - All low-confidence items with reasoning for user review

4. **User review**: Ask if the breakdown looks right. Offer to adjust the confidence threshold if too many or too few items need review. Discuss any low-confidence items the user wants to override.

5. **Apply**: Call `entity_classify` with `dryRun: false` using the agreed threshold. Report how many transactions were auto-assigned.

6. **Handle review items**: For each low-confidence item returned, present the transaction details and reasoning. Ask the user which entity it belongs to, then use `entity_manage` with `action: "assign"` to assign confirmed ones individually.

7. **Summary**: Show per-entity spending breakdown using `spending_summary` filtered by entity. Highlight the split between entities and any patterns worth noting.
