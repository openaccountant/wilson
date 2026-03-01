---
name: subscription-audit
description: >
  Analyzes recurring charges to find subscriptions, calculates total
  monthly/annual cost, flags services with no recent usage, and recommends
  cancellations. Trigger when user asks about subscriptions, recurring charges,
  "what am I paying for monthly", or wants to cut expenses.
---

# Subscription Audit

## Workflow

1. **Find recurring charges**: Use `anomaly_detect` with types `["unused_subscriptions"]` to identify all recurring transactions
2. **Get recurring transactions**: Use `transaction_search` with query "all recurring transactions" to get the full list
3. **Analyze each subscription**:
   - Calculate monthly cost (normalize weekly/annual charges to monthly)
   - Determine last activity date for each service
   - Flag subscriptions with no non-subscription activity in 90+ days
4. **Calculate totals**:
   - Total monthly subscription spend
   - Total annual subscription spend
   - Number of active vs potentially unused subscriptions
5. **Generate recommendations**:
   - Rank subscriptions by cost (highest first)
   - Highlight unused subscriptions with estimated annual savings if cancelled
   - Flag any duplicate or overlapping services (e.g., multiple streaming services)
6. **Present findings**:
   - Summary table: Service | Monthly Cost | Last Activity | Status
   - Total monthly/annual spend
   - Recommended cancellations with projected savings
   - Note: Recommendations are suggestions — user makes final decisions
