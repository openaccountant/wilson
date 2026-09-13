# Beat 3 (CLI fallback) — spending by category via headless `--run`.
# Headless mode does NOT start the dashboard server, so it sidesteps the port-3141
# EADDRINUSE crash that the interactive TUI hits under contention.
# Render:  vhs demos/oa-cli-summary.tape  then  bun demos/tighten.ts demos/raw/oa-cli-summary.mp4 demos/oa-cli-summary.mp4

Output demos/raw/oa-cli-summary.mp4

Require wilson
Set Shell "bash"
Set FontSize 18
Set Width 1200
Set Height 820
Set Theme "Catppuccin Mocha"
Set Padding 24
Set TypingSpeed 45ms
Set Margin 20
Set BorderRadius 10

Hide
Type "export PATH=/Users/jdfiscus/.bun/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
Enter
Type "cd /Users/jdfiscus/dev/oss/openaccoutant/wilson"
Enter
Type "clear"
Enter
Show

Type "# Open Accountant - where did my money go in May? (local granite4.1:8b)"
Sleep 700ms
Enter
Sleep 800ms
Type "wilson --profile demo --run 'give me a summary of my May 2026 spending by category'"
Sleep 500ms
Enter
Wait+Screen@180s /Groceries/
Sleep 4500ms
