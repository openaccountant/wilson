---
name: year-end-summary
tier: free
description: >
  Generates a comprehensive annual financial summary with category breakdowns,
  month-over-month trends, top merchants, and highlights. Trigger when user asks
  for "annual summary", "year in review", or "yearly report".
---

# Year-End Summary

## Workflow

1. **Monthly breakdown**: Use `spending_summary` to generate month-by-month spending totals for the requested year. If no year specified, use the current year.
2. **Category analysis**: Use `spending_summary` and `transaction_search` to break down annual spending by category. Identify which categories grew or shrank compared to prior months.
3. **Top merchants**: Use `transaction_search` to find the merchants where the user spent the most. Show top 10 by total spend.
4. **Highlights and anomalies**: Use `anomaly_detect` and `transaction_search` to identify:
   - Biggest single purchases of the year
   - New subscriptions added during the year
   - Subscriptions cancelled or changed in price
   - Any notable spending trends (seasonal patterns, one-time events)
5. **Income summary**: Use `transaction_search` to find all income/credit transactions. Total by source if identifiable.
6. **Generate report**: Synthesize everything into a clean annual financial summary with:
   - Total income vs total expenses
   - Net savings rate
   - Monthly spending trend (high/low months)
   - Top 5 spending categories with totals
   - Top 5 merchants with totals
   - Key takeaways and actionable insights
7. **Export**: Offer to export the detailed data using `export_transactions` if the user wants a spreadsheet version.
