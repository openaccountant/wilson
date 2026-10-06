# FLOW 1 — /help, then the slash palette, then import more data (@ file search)
# Records on the `showcase` profile (clone) so the import is non-destructive.
Output data/demo/flow1-help-import.gif
Output data/demo/flow1-help-import.mp4
Set Shell zsh
Set FontSize 18
Set Width 1400
Set Height 860
Set Padding 24
Set TypingSpeed 120ms
Set Theme { "name": "ForensicNoir", "background": "#0a0f1a", "foreground": "#e5e7eb", "cursor": "#22c55e", "selection": "#166534" }

Type "./data/demo/run-demo.sh"
Enter
Sleep 8s
Screenshot data/demo/f1-00-boot.png

# /help — show the command list
Type "/help"
Enter
Sleep 4s
Screenshot data/demo/f1-01-help.png

# type "/" to reveal the slash command palette, hold a beat
Type "/"
Sleep 2500ms
Screenshot data/demo/f1-02-palette.png

# continue the command to import August transactions into the clean ledger
Type "import data/demo/august-2026-chase.csv"
Sleep 800ms
Enter
Sleep 22s
Screenshot data/demo/f1-03-imported.png
Sleep 2s
