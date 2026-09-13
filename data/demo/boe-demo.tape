# ============================================================================
#  ⚠️  SUPERSEDED by boe-demo-v2.tape (September refresh: August hero month,
#      gemma4:31b, Jan->Aug ledger). Kept for design history — do not record.
# ============================================================================
#  VIDEO 1 — THE HERO  ·  "CASE FILE: MAY 2026"
#  Forensic procedural. 4 PROVEN tool-forced beats + a guarded verdict.
#  Model: granite4.1:8b. Data: full Jan->May arc on the `demo` profile.
#
#  CRAFT RULE: name the tool, forbid adding anything outside its results.
#  Dropped beats (verified weak/risky): entity_classify (leaks JSON, no
#  predefined entities) and model-generated month comparisons (drift to wrong
#  numbers). The +56% May spike lives as a REAL number in the summary (beat 3)
#  + a presenter caption — never a model-computed comparison.
#
#  Latency ~30-40s/beat in-session (grows with context). Speed up in post.
#  Pre-warm before recording:  wilson --profile demo --run "hello"
# ============================================================================

Output data/demo/boe-demo.gif
Output data/demo/boe-demo.mp4
Set Shell zsh
Set FontSize 18
Set Width 1400
Set Height 860
Set Padding 24
Set TypingSpeed 55ms
Set Theme { "name": "ForensicNoir", "background": "#0a0f1a", "foreground": "#e5e7eb", "cursor": "#22c55e", "selection": "#166534" }

Type "./data/demo/run-demo.sh"
Enter
Sleep 12s
Screenshot data/demo/hero-00-boot.png

# BEAT 1 · The catch: duplicate charges (anomaly_detect) — PROVEN
Type "Scan my transactions for duplicate charges using the anomaly tool."
Enter
Sleep 34s
Screenshot data/demo/hero-01-anomalies.png

# BEAT 2 · The slow leak: recurring charges (transaction_search) — PROVEN
Type "Use the transaction search tool to find all recurring transactions, then list only the merchant names and amounts it returns. Do not add any merchant that is not in the tool results."
Enter
Sleep 38s
Screenshot data/demo/hero-02-recurring.png

# BEAT 3 · Where it went: May summary (spending_summary) — PROVEN
#   Travel line = the coastal trip; the real total is the spike evidence.
Type "Give me a spending summary for May 2026 using the spending summary tool."
Enter
Sleep 38s
Screenshot data/demo/hero-03-summary.png

# BEAT 4 · The verdict: end on an ACTION (guarded + scoped for punch)
#   Names the real digital subs so 8b totals THOSE (not rent/utilities/income).
#   Target: duplicate $89.99 one-time + subs (14.99+19.99+9.99)*12 = $539.64/yr.
Type "Using only the findings above: (1) the duplicate MEGAMART charge, and (2) the recurring digital subscriptions SKYSTREAM, STREAMFLIX, and CLOUDVAULT — ignore rent, utilities, gym, and income. Give the one-time saving from the duplicate, and the combined ANNUAL cost of those three subscriptions. Exact dollar amounts only; introduce nothing new."
Enter
Sleep 40s
Screenshot data/demo/hero-04-verdict.png
Sleep 3s
