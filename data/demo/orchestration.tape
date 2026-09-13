# ============================================================================
#  VIDEO 3 — AGENTIC ORCHESTRATION  ("a team of forensic accountants")
#  Shows wilson run a multi-STEP chain — the "agents operating in a loop" story
#  a Lead WebAI presents. The wow is watching the steps + tool calls fire in
#  sequence, autonomously, on a fully local model. No cloud, no API keys.
#
#  VERIFIED: the `full-audit` chain (anomaly_detect -> recurring/subscriptions
#  -> synthesize) runs on gemma4:31b and grounds on the real MEGAMART duplicate.
#  (May 2026 timing on granite4.1:8b was ~79s; re-time on gemma4:31b before
#   recording — run the chain once headless and size the sleeps from that.)
#  CAVEAT: the final synthesis paragraph drifts (it invented
#  a date once). FRAME THE VIDEO AROUND THE PROCESS — the steps executing — and
#  cut before / caption-over the closing prose. Optionally swap for `finance-team`
#  (parallel dispatcher: categorizer + analyst + researcher) for a parallel look.
#
#  Latency: the chain alone is ~80s. Speed up heavily in post (this is a process
#  montage, not a read-along).
# ============================================================================

Output data/demo/orchestration.gif
Output data/demo/orchestration.mp4
Set Shell zsh
Set FontSize 18
Set Width 1400
Set Height 880
Set Padding 24
Set TypingSpeed 55ms
Set Theme { "name": "ForensicNoir", "background": "#0a0f1a", "foreground": "#e5e7eb", "cursor": "#22c55e", "selection": "#166534" }

Type "./data/demo/run-demo.sh"
Enter
Sleep 12s
Screenshot data/demo/orch-00-boot.png

# One command dispatches a 3-step audit chain. Watch the steps execute.
Type "Run the full-audit chain on my transactions."
Enter
Sleep 30s
Screenshot data/demo/orch-01-step.png       # mid-chain: steps firing
Sleep 30s
Screenshot data/demo/orch-02-step.png       # later step
Sleep 35s
Screenshot data/demo/orch-03-report.png     # synthesized audit report
Sleep 3s

# --- Alternate take (parallel team) — record separately if you prefer this look:
# Type "Have the finance team analyze my August spending."
# Enter
# Sleep 90s
