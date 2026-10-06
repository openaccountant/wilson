# NEW VIDEO 1 (part A) — set a goal from the CLI (tool-forced).
# Runs on the DEMO profile so the goal appears in the dashboard Goals tab (part B).
Output data/demo/flow-goal.gif
Output data/demo/flow-goal.mp4
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
Screenshot data/demo/fg-00-boot.png

# set a savings goal — name the goal tool so 8b actually calls it
Type "Create a savings goal titled Emergency Fund with a target amount of 10000 dollars and target date 2026-12-31. Use the goal management tool to save it."
Sleep 800ms
Enter
Sleep 28s
Screenshot data/demo/fg-01-goal-set.png
Sleep 2s
