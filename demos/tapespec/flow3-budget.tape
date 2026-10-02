# FLOW 3 — /budget: view, set a budget, then see it tracked.
Output data/demo/flow3-budget.gif
Output data/demo/flow3-budget.mp4
Set Shell zsh
Set FontSize 18
Set Width 1400
Set Height 860
Set Padding 24
Set TypingSpeed 120ms
Set Theme { "name": "ForensicNoir", "background": "#0a0f1a", "foreground": "#e5e7eb", "cursor": "#22c55e", "selection": "#166534" }

Type "./data/demo/run-showcase.sh"
Enter
Sleep 8s
Screenshot data/demo/f3-00-boot.png

# show current budget state
Type "/budget"
Enter
Sleep 6s
Screenshot data/demo/f3-01-budget-view.png

# set a budget for Dining
Type "/budget set Dining 200"
Enter
Sleep 6s
Screenshot data/demo/f3-02-budget-set.png

# set another, then ask how we're tracking (forces budget_check on real data)
Type "/budget set Groceries 400"
Enter
Sleep 6s
Type "How am I tracking against my budgets this month? Use the budget check tool."
Enter
Sleep 30s
Screenshot data/demo/f3-03-tracking.png
Sleep 2s
