---
name: bank-sync
description: >
  Syncs transactions from linked bank accounts, shows account balances,
  and identifies new spending. Trigger when user says "sync my bank",
  "update transactions", "check balances", or "what's new in my accounts".
---

# Bank Sync

## Workflow

1. **Check linked accounts**: Verify the user has linked bank accounts. If not, direct them to use `/connect` to link via Plaid.
2. **Sync transactions**: Use `plaid_sync` to pull the latest transactions from all linked accounts. Report how many new transactions were added.
3. **Show balances**: Use `plaid_balances` to display current account balances across all linked institutions.
4. **Summarize new activity**: Use `spending_summary` on the newly synced transactions to give a quick breakdown of recent spending by category.
5. **Check for recurring changes**: Use `plaid_recurring` to identify any new or changed subscriptions/bills since last sync.
6. **Suggest next steps**: Based on the sync results, suggest:
   - Running `categorize` if new transactions need categorization
   - Checking `budget_check` if budgets are set
   - Running `anomaly_detect` if anything looks unusual
