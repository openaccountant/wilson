---
name: spending-review
description: >
  Performs a comprehensive review of spending for a given period. Summarizes
  by category, compares to budgets, highlights anomalies, and provides
  actionable recommendations. Trigger when user says "review my spending",
  "how did I do this month", "spending report", or "where is my money going".
---

# Spending Review

## Workflow

1. **Determine time period**: Default to current month; accept offset (e.g., "last month") or custom date range
2. **Get category breakdown**: Use `spending_summary` to get spending totals by category for the period
3. **Check budgets**: Use `budget_check` to compare actual spending against budgets (if set)
4. **Detect anomalies**: Use `anomaly_detect` to find unusual spending patterns or outliers
5. **Present findings**:
   - Category breakdown table with amounts and percentage of total
   - Top merchants by spend
   - Anomalies and unusual transactions
   - Trends vs previous period (month-over-month or period-over-period)
6. **Provide recommendations**: Actionable suggestions including areas to cut back, budget adjustments, and spending patterns to watch
