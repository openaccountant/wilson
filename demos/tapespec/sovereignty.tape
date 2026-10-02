# ============================================================================
#  VIDEO 2 — THE SOVEREIGNTY CUT  (~45s of content)
#  The single most important beat for a central bank: the data never leaves.
#  Strategy: the boot screen already states "Model: gemma4:31b · Profile: demo"
#  and there is no network call. We capture the SAME forensic catch as the hero,
#  but the framing is about WHERE it runs, not what it finds.
#
#  The "wifi off" reveal is a PRESENTATION move, not a VHS command (toggling the
#  OS network mid-tape is unreliable). Two honest ways to do it:
#    (a) LIVE on stage: turn wifi off, then run this tape's single command.
#    (b) IN POST: add a caption overlay "Wi-Fi: OFF  ·  No data left this machine"
#        + a menubar shot. The CLI genuinely uses only localhost:11434 (Ollama),
#        so the claim is true either way.
#  Pre-record proof for the deck:  little-snitch / lsof shows no outbound conns.
# ============================================================================

Output data/demo/sovereignty.gif
Output data/demo/sovereignty.mp4
Set Shell zsh
Set FontSize 18
Set Width 1400
Set Height 820
Set Padding 24
Set TypingSpeed 55ms
Set Theme { "name": "ForensicNoir", "background": "#0a0f1a", "foreground": "#e5e7eb", "cursor": "#22c55e", "selection": "#166534" }

# Boot: the line "Model: gemma4:31b" is the whole point — let it sit on screen.
Type "./data/demo/run-demo.sh"
Enter
Sleep 12s
Screenshot data/demo/sov-00-boot.png

# One real catch, computed entirely on-device by a local open-weights model.
Type "Scan my transactions for duplicate charges using the anomaly tool."
Enter
Sleep 34s
Screenshot data/demo/sov-01-local-catch.png

# Ask it the sovereignty question directly (tool-free, but a safe factual claim
# the product is designed around). Verify the answer on your build before using.
Type "Is any of my financial data sent to the cloud or any external server when you analyze it?"
Enter
Sleep 30s
Screenshot data/demo/sov-02-privacy.png
Sleep 3s
