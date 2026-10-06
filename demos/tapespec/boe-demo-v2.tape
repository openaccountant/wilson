# ============================================================================
#  Open Accountant — "CASE FILE: AUGUST 2026" (September refresh)
#  Live TUI · gemma4:31b (demo profile default) · seeded `demo` profile
#  (Jan->Aug, 174 txns; hero beats engineered into August:
#   MEGAMART $89.99 pair, HARBORVIEW $318 pair, coastal-trip spike cluster)
#
#  v2 changes vs boe-demo.tape (still in force):
#   - DROP beat 5 (entity_classify): output is clean on 0.5.0 but the entity
#     chain now takes 223-292s — too slow to record even sped up.
#   - DROP beat 4 (profit_diff spike): unverified + depends on uncategorized history.
#   - Keep the 4 PROVEN beats; widen sleeps so no beat is captured mid-"Comparing".
#   - Prereq: pre-warm once before recording (done by the wrapper).
#
#  Sep 2026 validity: verify-accuracy.sh passes 10/10 on gemma4:31b
#  (subscriptions beat now returns the real $94.96/mo table — is_recurring
#   flags are set by rollforward-jun-aug-2026.sql).
# ============================================================================

Output data/demo/boe-demo-v2.gif
Output data/demo/boe-demo-v2.mp4

Set Shell zsh
Set FontSize 18
Set Width 1400
Set Height 860
Set Padding 24
Set Margin 0
Set TypingSpeed 55ms
Set Theme { "background": "#0a0f1a", "foreground": "#e5e7eb", "black": "#1f2937", "red": "#ef4444", "green": "#22c55e", "yellow": "#f59e0b", "blue": "#06b6d4", "magenta": "#a78bfa", "cyan": "#06b6d4", "white": "#e5e7eb", "brightBlack": "#374151", "brightRed": "#ef4444", "brightGreen": "#86efac", "brightYellow": "#f59e0b", "brightBlue": "#06b6d4", "brightMagenta": "#a78bfa", "brightCyan": "#67e8f9", "brightWhite": "#ffffff", "cursor": "#22c55e", "selection": "#166534" }

# --- Launch: opening the case file ---
Type "./data/demo/run-demo.sh"
Enter
Sleep 14s
Screenshot data/demo/shot-v2-00-boot.png

# --- BEAT 1 · The catch: duplicates (anomaly_detect) ---
# Sleeps are sized > the real ~35s/beat TUI latency so VHS never types the next
# prompt into a busy TUI (which garbles the take). The result is sped up in post.
Type "Scan my transactions for duplicate charges using the anomaly tool."
Enter
Sleep 46s
Screenshot data/demo/shot-v2-01-anomalies.png

# --- BEAT 2 · The recurring drain (transaction_search, tool-forced + guardrail) ---
Type "Use the transaction search tool to find all recurring transactions, then list only the merchant names and amounts it returns. Do not add any merchant that is not in the tool results."
Enter
Sleep 52s
Screenshot data/demo/shot-v2-02-recurring.png

# --- BEAT 3 · Spending summary for August (spending_summary) ---
Type "Give me a spending summary for August 2026 using the spending summary tool."
Enter
Sleep 48s
Screenshot data/demo/shot-v2-03-summary.png

# --- BEAT 4 · The verdict: end on an ACTION (scoped to prior findings) ---
Type "Using only the duplicate charges and recurring charges you already found above, name the top 2 money-saving actions and the exact dollar amount each saves. Do not introduce any new transactions. Keep it to 2 short bullets."
Enter
Sleep 48s
Screenshot data/demo/shot-v2-04-verdict.png

Sleep 3s
